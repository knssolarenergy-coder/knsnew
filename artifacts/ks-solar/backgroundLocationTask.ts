import AsyncStorage from "@react-native-async-storage/async-storage";
import * as FileSystem from "expo-file-system/legacy";
import * as Location from "expo-location";
import * as SecureStore from "expo-secure-store";
import { AppState, Platform } from "react-native";

export const LOCATION_TASK_NAME = "ks-solar-bg-location";

const TOKEN_KEY = "ks_solar_token";
const USER_ID_KEY = "ks_solar_user_id";
const OFFLINE_QUEUE_KEY = "ks_solar_location_queue";
const MAX_QUEUE_SIZE = 2000;

const CONFIG_VERSION_KEY = "ks_solar_tracking_config_version";
// Bump whenever the startLocationUpdatesAsync() options below change. An already
// registered Expo location task keeps its ORIGINAL persisted options forever
// (hasStartedLocationUpdatesAsync short-circuits a re-start), so without a
// version restart, updated options never reach devices that upgraded the app.
const TRACKING_CONFIG_VERSION = "2";

const PING_TIMEOUT_MS = 10_000;

/**
 * fetch() with a hard timeout. A hung request inside the headless background
 * task is the silent killer of always-on tracking: with no timeout a single
 * stalled socket (common on flaky mobile networks) wedges the headless JS
 * runtime, Android stops scheduling the task, and the foreground service can be
 * reaped with it. AbortController guarantees every request settles.
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

interface QueuedPing {
  userId: string;
  latitude: string;
  longitude: string;
  recordedAt: string;
}

async function readQueue(): Promise<QueuedPing[]> {
  try {
    const raw = await AsyncStorage.getItem(OFFLINE_QUEUE_KEY);
    return raw ? (JSON.parse(raw) as QueuedPing[]) : [];
  } catch {
    return [];
  }
}

async function writeQueue(queue: QueuedPing[]): Promise<void> {
  try {
    await AsyncStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
  } catch {}
}

async function enqueuePing(
  userId: string,
  latitude: string,
  longitude: string,
  recordedAt: string
): Promise<void> {
  if (!userId) return;
  const queue = await readQueue();
  queue.push({ userId, latitude, longitude, recordedAt });
  if (queue.length > MAX_QUEUE_SIZE) {
    queue.splice(0, queue.length - MAX_QUEUE_SIZE);
  }
  await writeQueue(queue);
}

/**
 * Call on login — sets the current user ID for queue attribution.
 * If a different user was previously active, their queued pings are discarded
 * to prevent cross-user location data attribution on shared devices.
 */
export async function setCurrentUserId(userId: string): Promise<void> {
  try {
    const prevId = await SecureStore.getItemAsync(USER_ID_KEY);
    if (prevId && prevId !== userId) {
      const queue = await readQueue();
      await writeQueue(queue.filter((p) => p.userId !== prevId));
    }
    await SecureStore.setItemAsync(USER_ID_KEY, userId);
  } catch {}
  await setAuthUserIdFlag(userId);
}

/**
 * Call on logout — clears the current user ID so the background task
 * does not enqueue pings for an anonymous/unauthenticated session.
 */
export async function clearCurrentUserId(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(USER_ID_KEY);
  } catch {}
  await setTrackingFlag(false);
  await setAuthUserIdFlag(null);
}

/**
 * Writes or removes a plain flag file that the Android BroadcastReceiver
 * (KSSolarBootReceiver) can check after a device reboot. The file lives in
 * the app's internal files directory (getFilesDir()), which is the same path
 * Expo FileSystem maps to documentDirectory on Android.
 *
 * Only runs on Android — iOS handles background location restarts natively.
 */
async function setTrackingFlag(active: boolean): Promise<void> {
  if (Platform.OS !== "android") return;
  try {
    const flagPath = `${FileSystem.documentDirectory ?? ""}ks_tracking_active`;
    if (active) {
      await FileSystem.writeAsStringAsync(flagPath, "1");
    } else {
      const info = await FileSystem.getInfoAsync(flagPath);
      if (info.exists) {
        await FileSystem.deleteAsync(flagPath, { idempotent: true });
      }
    }
  } catch {}
}

/**
 * Mirror the authentication token *presence* into a plain file so the
 * Android BootReceiver can verify a user is logged in without needing to
 * decrypt expo-secure-store's EncryptedSharedPreferences.
 *
 * Call this whenever the token is stored or cleared (login / logout /
 * token invalidation). The actual token value is never written to disk —
 * only a "1" presence marker.
 *
 * Only runs on Android.
 */
export async function mirrorAuthToken(hasToken: boolean): Promise<void> {
  if (Platform.OS !== "android") return;
  try {
    const flagPath = `${FileSystem.documentDirectory ?? ""}ks_auth_token`;
    if (hasToken) {
      await FileSystem.writeAsStringAsync(flagPath, "1");
    } else {
      const info = await FileSystem.getInfoAsync(flagPath);
      if (info.exists) {
        await FileSystem.deleteAsync(flagPath, { idempotent: true });
      }
    }
  } catch {}
}

async function setAuthUserIdFlag(userId: string | null): Promise<void> {
  if (Platform.OS !== "android") return;
  try {
    const flagPath = `${FileSystem.documentDirectory ?? ""}ks_auth_user_id`;
    if (userId !== null) {
      await FileSystem.writeAsStringAsync(flagPath, userId);
    } else {
      const info = await FileSystem.getInfoAsync(flagPath);
      if (info.exists) {
        await FileSystem.deleteAsync(flagPath, { idempotent: true });
      }
    }
  } catch {}
}

export async function flushOfflineQueue(): Promise<void> {
  try {
    const queue = await readQueue();
    if (queue.length === 0) return;
    const token = await SecureStore.getItemAsync(TOKEN_KEY);
    if (!token) return;
    const currentUserId = await SecureStore.getItemAsync(USER_ID_KEY);
    if (!currentUserId) return;

    const myPings = queue.filter((p) => p.userId === currentUserId);
    const otherPings = queue.filter((p) => p.userId !== currentUserId);

    if (myPings.length === 0) return;

    const apiBase = `https://${process.env.EXPO_PUBLIC_DOMAIN}/api`;
    const remaining: QueuedPing[] = [...otherPings];
    const batchSize = 30;

    for (let i = 0; i < myPings.length; i += batchSize) {
      const batch = myPings.slice(i, i + batchSize);
      try {
        const results = await Promise.all(
          batch.map(async (ping) => {
            const resp = await fetchWithTimeout(
              `${apiBase}/technician-locations/ping`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({
                  latitude: ping.latitude,
                  longitude: ping.longitude,
                  recordedAt: ping.recordedAt,
                }),
              },
              PING_TIMEOUT_MS
            );
            return { ping, ok: resp.ok };
          })
        );
        for (const r of results) {
          if (!r.ok) remaining.push(r.ping);
        }
      } catch {
        remaining.push(...myPings.slice(i));
        break;
      }
    }
    await writeQueue(remaining);
  } catch {}
}

async function sendPingNow(
  token: string,
  latitude: string,
  longitude: string,
  recordedAt: string
): Promise<boolean> {
  try {
    const apiBase = `https://${process.env.EXPO_PUBLIC_DOMAIN}/api`;
    const resp = await fetchWithTimeout(
      `${apiBase}/technician-locations/ping`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ latitude, longitude, recordedAt }),
      },
      PING_TIMEOUT_MS
    );
    return resp.ok;
  } catch {
    return false;
  }
}

// Guards against overlapping headless invocations. The location task can fire
// again before the previous network send finished; without this, slow networks
// pile up concurrent fetches inside the headless runtime. This module-level flag
// survives across invocations because Expo keeps one JS runtime alive for the
// foreground service.
let backgroundTaskBusy = false;

if (Platform.OS !== "web") {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const TaskManager = require("expo-task-manager") as typeof import("expo-task-manager");
    TaskManager.defineTask(
      LOCATION_TASK_NAME,
      async ({
        data,
        error,
      }: {
        data: unknown;
        error: { message: string } | null;
      }) => {
        if (error) return;
        const { locations } = data as { locations: Location.LocationObject[] };
        // Use the most recent fix if Android batched several together.
        const loc = locations[locations.length - 1];
        if (!loc) return;

        const latitude = loc.coords.latitude.toString();
        const longitude = loc.coords.longitude.toString();
        const recordedAt = new Date(loc.timestamp).toISOString();

        const token = await SecureStore.getItemAsync(TOKEN_KEY).catch(() => null);
        const userId = await SecureStore.getItemAsync(USER_ID_KEY).catch(() => null);

        if (!token || !userId) {
          return;
        }

        // If a previous send is still in flight, just persist this fix and bail —
        // never let headless invocations overlap. The foreground flush will pick
        // up the queued fix later.
        if (backgroundTaskBusy) {
          await enqueuePing(userId, latitude, longitude, recordedAt);
          return;
        }

        // Keep the background task minimal — send one ping (bounded by a timeout),
        // else enqueue. Queue flushing happens in the foreground (AppState +
        // NetInfo listeners) to avoid long-running async chains in the headless task.
        backgroundTaskBusy = true;
        try {
          const ok = await sendPingNow(token, latitude, longitude, recordedAt);
          if (!ok) {
            await enqueuePing(userId, latitude, longitude, recordedAt);
          }
        } catch {
          await enqueuePing(userId, latitude, longitude, recordedAt);
        } finally {
          backgroundTaskBusy = false;
        }
      }
    );
  } catch {
    // expo-task-manager unavailable (Expo Go) — background tracking disabled
  }
}

export async function startAlwaysOnTracking(): Promise<void> {
  if (Platform.OS === "web") return;
  try {
    const fgStatus = await Location.requestForegroundPermissionsAsync();
    if (fgStatus.status !== "granted") return;
    const bgStatus = await Location.requestBackgroundPermissionsAsync();
    if (bgStatus.status !== "granted") return;
    const already = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);
    const storedVersion = await AsyncStorage.getItem(CONFIG_VERSION_KEY).catch(
      () => null
    );

    // Force a one-time restart when tracking options change between app versions.
    // hasStartedLocationUpdatesAsync() otherwise keeps the old persisted options.
    if (already && storedVersion !== TRACKING_CONFIG_VERSION) {
      try {
        await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
      } catch {}
    }

    const needStart = !already || storedVersion !== TRACKING_CONFIG_VERSION;
    if (needStart) {
      await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
        accuracy: Location.Accuracy.Balanced,
        timeInterval: 60_000,
        distanceInterval: 0,
        activityType: Location.ActivityType.Other,
        foregroundService: {
          notificationTitle: "K&S Solar — Location Active",
          notificationBody: "Sharing your location with the office.",
          notificationColor: "#0891B2",
          killServiceOnDestroy: false,
        },
        pausesUpdatesAutomatically: false,
        showsBackgroundLocationIndicator: true,
      });
      await AsyncStorage.setItem(
        CONFIG_VERSION_KEY,
        TRACKING_CONFIG_VERSION
      ).catch(() => {});
    }
    // Write flag so KSSolarBootReceiver can restart the service after a reboot.
    await setTrackingFlag(true);
  } catch {}
}

export async function stopAlwaysOnTracking(): Promise<void> {
  if (Platform.OS === "web") return;
  try {
    const already = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);
    if (already) await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
  } catch {}
  await setTrackingFlag(false);
}

export async function sendForegroundPing(): Promise<void> {
  if (Platform.OS === "web") return;
  try {
    const token = await SecureStore.getItemAsync(TOKEN_KEY);
    if (!token) return;
    const userId = await SecureStore.getItemAsync(USER_ID_KEY);
    if (!userId) return;
    const loc = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
    });
    const recordedAt = new Date(loc.timestamp).toISOString();
    const latitude = loc.coords.latitude.toString();
    const longitude = loc.coords.longitude.toString();
    await flushOfflineQueue();
    const ok = await sendPingNow(token, latitude, longitude, recordedAt);
    if (!ok) {
      await enqueuePing(userId, latitude, longitude, recordedAt);
    }
  } catch {}
}

/** @deprecated Now a no-op. Use startAlwaysOnTracking() instead. */
export async function startBackgroundLocation(_attendanceId: string): Promise<void> {
  await startAlwaysOnTracking();
}

/** @deprecated Now a no-op. Location is always-on and never stops until logout. */
export async function stopBackgroundLocation(): Promise<void> {}

export function startAppStateFlushListener(): () => void {
  if (Platform.OS === "web") return () => {};
  const sub = AppState.addEventListener("change", (state) => {
    if (state === "active") {
      flushOfflineQueue().catch(() => {});
    }
  });
  return () => sub.remove();
}
