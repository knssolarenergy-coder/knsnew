import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";
import * as SecureStore from "expo-secure-store";
import { AppState, Platform } from "react-native";

export const LOCATION_TASK_NAME = "ks-solar-bg-location";

const TOKEN_KEY = "ks_solar_token";
const USER_ID_KEY = "ks_solar_user_id";
const OFFLINE_QUEUE_KEY = "ks_solar_location_queue";
const MAX_QUEUE_SIZE = 2000;

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
}

/**
 * Call on logout — clears the current user ID so the background task
 * does not enqueue pings for an anonymous/unauthenticated session.
 */
export async function clearCurrentUserId(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(USER_ID_KEY);
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
            const resp = await fetch(`${apiBase}/technician-locations/ping`, {
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
            });
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
    const resp = await fetch(`${apiBase}/technician-locations/ping`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ latitude, longitude, recordedAt }),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

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
        const loc = locations[0];
        if (!loc) return;

        const latitude = loc.coords.latitude.toString();
        const longitude = loc.coords.longitude.toString();
        const recordedAt = new Date(loc.timestamp).toISOString();

        const token = await SecureStore.getItemAsync(TOKEN_KEY).catch(() => null);
        const userId = await SecureStore.getItemAsync(USER_ID_KEY).catch(() => null);

        if (!token || !userId) {
          return;
        }

        try {
          await flushOfflineQueue();
          const ok = await sendPingNow(token, latitude, longitude, recordedAt);
          if (!ok) {
            await enqueuePing(userId, latitude, longitude, recordedAt);
          }
        } catch {
          await enqueuePing(userId, latitude, longitude, recordedAt);
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
    if (!already) {
      await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
        accuracy: Location.Accuracy.Balanced,
        timeInterval: 300_000,
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
    }
  } catch {}
}

export async function stopAlwaysOnTracking(): Promise<void> {
  if (Platform.OS === "web") return;
  try {
    const already = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);
    if (already) await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
  } catch {}
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
