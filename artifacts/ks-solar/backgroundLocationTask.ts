import * as Location from "expo-location";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

export const LOCATION_TASK_NAME = "ks-solar-bg-location";

const TOKEN_KEY = "ks_solar_token";
const ATTENDANCE_KEY = "ks_solar_active_attendance";

// Task must be defined at module top-level (Expo requirement).
// Platform guard ensures expo-task-manager is only required on native.
if (Platform.OS !== "web") {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const TaskManager = require("expo-task-manager") as typeof import("expo-task-manager");
    TaskManager.defineTask(LOCATION_TASK_NAME, async ({ data, error }: { data: unknown; error: { message: string } | null }) => {
      if (error) return;
      const { locations } = data as { locations: Location.LocationObject[] };
      const loc = locations[0];
      if (!loc) return;
      try {
        const token = await SecureStore.getItemAsync(TOKEN_KEY);
        const attendanceId = await SecureStore.getItemAsync(ATTENDANCE_KEY);
        if (!token || !attendanceId) return;
        const apiBase = `https://${process.env.EXPO_PUBLIC_DOMAIN}/api`;
        await fetch(`${apiBase}/technician-locations`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            attendanceId,
            latitude: loc.coords.latitude.toString(),
            longitude: loc.coords.longitude.toString(),
            address: null,
          }),
        });
      } catch {
        // Silent fail — background tasks should never throw
      }
    });
  } catch {
    // expo-task-manager not available (e.g. Expo Go) — background tracking disabled
  }
}

/** Call after technician checks in. Requests "always" permission and starts background tracking. */
export async function startBackgroundLocation(attendanceId: string): Promise<void> {
  if (Platform.OS === "web") return;
  try {
    const { status } = await Location.requestBackgroundPermissionsAsync();
    if (status !== "granted") return;
    await SecureStore.setItemAsync(ATTENDANCE_KEY, attendanceId);
    const already = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);
    if (!already) {
      await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
        accuracy: Location.Accuracy.High,
        timeInterval: 10_000,
        // 0 = report on the time interval even when the technician is standing
        // still. With a distance filter, a stationary phone with the screen off
        // would stop sending pings — this keeps tracking alive while locked.
        distanceInterval: 0,
        activityType: Location.ActivityType.Other,
        foregroundService: {
          notificationTitle: "K&S Solar — Tracking Active",
          notificationBody: "Sharing your location with the office. Keep this notification visible until check-out.",
          notificationColor: "#0891B2",
          // Keep the foreground service (and tracking) running even if the app
          // is swiped away from recents while the screen is locked.
          killServiceOnDestroy: false,
        },
        pausesUpdatesAutomatically: false,
        showsBackgroundLocationIndicator: true,
      });
    }
  } catch {
    // Graceful — background permission denied or task already running
  }
}

/** Call after technician checks out. Stops background tracking and clears stored data. */
export async function stopBackgroundLocation(): Promise<void> {
  if (Platform.OS === "web") return;
  try {
    const already = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);
    if (already) await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
  } catch {}
  try {
    await SecureStore.deleteItemAsync(ATTENDANCE_KEY);
  } catch {}
}
