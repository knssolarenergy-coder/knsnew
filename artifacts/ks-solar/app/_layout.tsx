import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from "@expo-google-fonts/inter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setBaseUrl, useGetSettings } from "@workspace/api-client-react";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import Constants from "expo-constants";
import React, { useEffect, useRef, useState } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Alert, Linking, Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { AuthProvider, useAuth } from "@/context/AuthContext";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ConfirmProvider } from "@/components/ConfirmModal";
import { LocationEnforcementOverlay } from "@/components/LocationEnforcementOverlay";
import { UpdateModal } from "@/components/UpdateModal";
import { registerForPushNotificationsAsync } from "@/hooks/usePushNotifications";
import { useRouter } from "expo-router";
import {
  flushOfflineQueue,
  sendForegroundPing,
  setCurrentUserId,
  startAlwaysOnTracking,
  startAppStateFlushListener,
  stopAlwaysOnTracking,
} from "@/backgroundLocationTask";

// Register background location task at app startup — wrapped in try/catch so any
// task-manager init failure never crashes the whole app.
if (Platform.OS !== "web") {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("@/backgroundLocationTask");
  } catch {
    // Silently skip — background tracking unavailable (e.g. Expo Go)
  }
}

const _apiOrigin = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}`
  : typeof window !== "undefined"
  ? window.location.origin
  : "";

setBaseUrl(_apiOrigin);

SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30_000 },
  },
});

const API_BASE = `${_apiOrigin}/api`;

const BG_PERM_SHOWN_KEY = "ks_solar_bg_perm_shown";
// v3 — previous versions only opened generic Settings with text instructions, so
// most technicians never actually whitelisted the app and Doze/OEM battery
// managers kept killing the location service. v3 fires the REAL one-tap "ignore
// battery optimizations" system dialog and KEEPS re-prompting (max once / 24h)
// until the technician confirms they've configured it.
const BATTERY_OPT_DONE_KEY = "ks_solar_battery_opt_v3_done";
const BATTERY_OPT_LAST_KEY = "ks_solar_battery_opt_v3_last";
const BATTERY_REPROMPT_MS = 24 * 60 * 60 * 1000;

/**
 * Fires Android's one-tap "Allow / ignore battery optimizations" dialog.
 * Without this exemption, OEM battery managers (Xiaomi, Oppo, Vivo, Samsung) and
 * Doze freeze or kill the location foreground service once the app is
 * backgrounded — the #1 reason tracking "stops when the app is closed". Falls
 * back to the battery-optimization list, then generic app settings.
 */
async function openBatteryExemption(): Promise<void> {
  if (Platform.OS !== "android") return;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const IntentLauncher = (() => {
    try {
      return require("expo-intent-launcher") as typeof import("expo-intent-launcher");
    } catch {
      return null;
    }
  })();
  if (!IntentLauncher) {
    Linking.openSettings().catch(() => {});
    return;
  }
  try {
    await IntentLauncher.startActivityAsync(
      "android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS",
      { data: "package:com.kssolar.app" }
    );
  } catch {
    try {
      await IntentLauncher.startActivityAsync(
        "android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS"
      );
    } catch {
      Linking.openSettings().catch(() => {});
    }
  }
}

function showBatteryOptPromptOnce() {
  if (Platform.OS !== "android") return;
  (async () => {
    try {
      const done = await AsyncStorage.getItem(BATTERY_OPT_DONE_KEY);
      if (done) return;
      const last = await AsyncStorage.getItem(BATTERY_OPT_LAST_KEY);
      if (last && Date.now() - Number(last) < BATTERY_REPROMPT_MS) return;
      await AsyncStorage.setItem(BATTERY_OPT_LAST_KEY, String(Date.now())).catch(
        () => {}
      );
      Alert.alert(
        "Zaroori: Tracking 24/7 chalti rahe",
        'App band ya phone lock hone par bhi location chalti rahe, is ke liye 2 settings on karein:\n\n1\u20e3  "Battery Allow" dabayein, phir system dialog par "Allow" — battery optimization se app exempt ho jayegi.\n2\u20e3  "Autostart" se settings khol kar app ka Autostart ON karein (Xiaomi/Oppo/Vivo/Samsung).\n\nJab dono ho jayein to "Ho gaya" dabayein.',
        [
          { text: "Battery Allow", onPress: () => openBatteryExemption() },
          {
            text: "Autostart",
            onPress: () => Linking.openSettings().catch(() => {}),
          },
          {
            text: "Ho gaya \u2713",
            onPress: () =>
              AsyncStorage.setItem(BATTERY_OPT_DONE_KEY, "1").catch(() => {}),
          },
        ]
      );
    } catch {}
  })();
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function UpdateChecker() {
  const [showUpdate, setShowUpdate] = useState(false);
  const [latestVersion, setLatestVersion] = useState("");
  const [apkUrl, setApkUrl] = useState("");
  const { data: settingsData } = useGetSettings();

  const currentVersion = Constants.expoConfig?.version ?? "0.0.0";

  useEffect(() => {
    if (!settingsData) return;
    const latest = settingsData.find((s) => s.key === "latest_version")?.value ?? "";
    const url = settingsData.find((s) => s.key === "apk_download_url")?.value ?? "";
    if (latest && url && compareVersions(latest, currentVersion) > 0) {
      setLatestVersion(latest);
      setApkUrl(url);
      setShowUpdate(true);
    }
  }, [settingsData, currentVersion]);

  return (
    <UpdateModal
      visible={showUpdate}
      currentVersion={currentVersion}
      latestVersion={latestVersion}
      apkUrl={apkUrl}
      onDismiss={() => setShowUpdate(false)}
    />
  );
}

function PushManager() {
  const { user, token } = useAuth();
  const lastUserId = useRef<string | null>(null);

  useEffect(() => {
    if (!user || !token || Platform.OS === "web") return;
    if (lastUserId.current === user.id) return;
    lastUserId.current = user.id;

    registerForPushNotificationsAsync(token, API_BASE).catch(() => {});
  }, [user?.id, token]);

  return null;
}

function LocationTracker() {
  const { user, isLoading } = useAuth();
  const lastUserId = useRef<string | null>(null);
  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const appStateUnsubRef = useRef<(() => void) | null>(null);
  const netInfoUnsubRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (Platform.OS === "web") return;
    // Wait until auth has settled. A transient null user during token
    // re-validation (cold start, resume, network blip) must NEVER tear down an
    // active technician's tracking — that was the root cause of tracking dying.
    if (isLoading) return;

    const teardownListeners = () => {
      if (pingIntervalRef.current) { clearInterval(pingIntervalRef.current); pingIntervalRef.current = null; }
      if (appStateUnsubRef.current) { appStateUnsubRef.current(); appStateUnsubRef.current = null; }
      if (netInfoUnsubRef.current) { netInfoUnsubRef.current(); netInfoUnsubRef.current = null; }
    };

    if (!user || user.role !== "technician") {
      // A confirmed non-technician is signed in (admin/customer) → they must not
      // be tracked, so stop the native service. An explicit logout already stops
      // tracking from AuthContext.logout(); a logged-out (null) user has nothing
      // running to stop. Because we gate on !isLoading above, this can never fire
      // on a transient null user.
      if (user && user.role !== "technician") {
        stopAlwaysOnTracking().catch(() => {});
      }
      teardownListeners();
      lastUserId.current = null;
      return;
    }

    if (lastUserId.current === user.id) return;
    lastUserId.current = user.id;

    // Cancellation guard: flipped true when this effect is torn down (logout,
    // role change, remount). Pending async permission callbacks check it so a
    // late "OK" tap can never (re)start tracking AFTER the user is gone.
    let cancelled = false;

    // Tag current user for queue attribution; clears a previous different user's queued pings
    setCurrentUserId(user.id).catch(() => {});

    // One-time explanation before requesting background permission
    AsyncStorage.getItem(BG_PERM_SHOWN_KEY)
      .then((shown) => {
        if (cancelled) return;
        if (!shown) {
          Alert.alert(
            "Background Location",
            "K&S Solar will track your location continuously while you are logged in so the office can see where technicians are at all times.",
            [{
              text: "OK",
              onPress: () => {
                AsyncStorage.setItem(BG_PERM_SHOWN_KEY, "1").catch(() => {});
                if (cancelled) return;
                startAlwaysOnTracking().catch(() => {});
                showBatteryOptPromptOnce();
              },
            }]
          );
        } else {
          startAlwaysOnTracking().catch(() => {});
          showBatteryOptPromptOnce();
        }
      })
      .catch(() => {
        if (cancelled) return;
        startAlwaysOnTracking().catch(() => {});
        showBatteryOptPromptOnce();
      });

    flushOfflineQueue().catch(() => {});
    sendForegroundPing().catch(() => {});

    pingIntervalRef.current = setInterval(() => {
      sendForegroundPing().catch(() => {});
    }, 30_000);

    appStateUnsubRef.current = startAppStateFlushListener();

    // NetInfo: flush queue immediately when connectivity is restored
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const NetInfo = require("@react-native-community/netinfo") as {
        addEventListener: (
          cb: (s: { isConnected: boolean | null }) => void
        ) => () => void;
      };
      let wasOffline = false;
      netInfoUnsubRef.current = NetInfo.addEventListener((state) => {
        if (state.isConnected && wasOffline) {
          flushOfflineQueue().catch(() => {});
          sendForegroundPing().catch(() => {});
        }
        wasOffline = state.isConnected === false;
      });
    } catch {
      // NetInfo unavailable — AppState-based flush still active
    }

    // Cleanup: ONLY tear down the JS listeners we created. We deliberately do
    // NOT stop the native location service here. React unmounts/remounts this
    // tree whenever the OS recreates the activity (app backgrounded, low memory,
    // config change) — calling stopAlwaysOnTracking() from cleanup is exactly
    // what silently killed background tracking after a few hours. The service is
    // stopped only by an explicit logout (AuthContext.logout) or a confirmed
    // role change to a non-technician.
    return () => {
      cancelled = true;
      teardownListeners();
    };
  }, [user?.id, user?.role, isLoading]);

  return null;
}

function NotificationObserver() {
  const router = useRouter();

  useEffect(() => {
    if (Platform.OS === "web") return;
    let sub: { remove: () => void } | undefined;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Notifications = require("expo-notifications") as typeof import("expo-notifications");
      sub = Notifications.addNotificationResponseReceivedListener((response) => {
        const data = response.notification.request.content.data as Record<string, string> | undefined;
        if (!data?.type) return;
        switch (data.type) {
          case "booking_new":
          case "complaint_new":
          case "quote_new":
            router.push("/(tabs)/admin");
            break;
          case "booking_assigned":
          case "complaint_assigned":
          case "site_visit_assigned":
            router.push("/(tabs)/technician");
            break;
          default:
            break;
        }
      });
    } catch {
      // expo-notifications unavailable (Expo Go) — silently skip
    }
    return () => {
      try { sub?.remove(); } catch { /* ignore */ }
    };
  }, [router]);

  return null;
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) return null;

  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <GestureHandlerRootView>
            <KeyboardProvider>
              <AuthProvider>
                <ConfirmProvider>
                  <PushManager />
                  <NotificationObserver />
                  <UpdateChecker />
                  <LocationTracker />
                  <LocationEnforcementOverlay />
                  <Stack screenOptions={{ headerShown: false }}>
                    <Stack.Screen name="(tabs)" />
                    <Stack.Screen name="(auth)" />
                    <Stack.Screen name="complaint-detail" />
                  </Stack>
                </ConfirmProvider>
              </AuthProvider>
            </KeyboardProvider>
          </GestureHandlerRootView>
        </QueryClientProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
