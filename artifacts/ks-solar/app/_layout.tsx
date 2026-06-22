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
  clearCurrentUserId,
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
// v2 key — forces re-prompt for users who saw the old (less informative) prompt
const BATTERY_OPT_KEY   = "ks_solar_battery_opt_v2";

function showBatteryOptPromptOnce() {
  if (Platform.OS !== "android") return;
  AsyncStorage.getItem(BATTERY_OPT_KEY).then((shown) => {
    if (shown) return;
    AsyncStorage.setItem(BATTERY_OPT_KEY, "1").catch(() => {});
    Alert.alert(
      "Location Tracking — 2 Zaruri Settings",
      "App close hone par bhi tracking chalti rahe, is ke liye yeh karo:\n\n1️⃣  Battery → \"Koi Paabandi Nahi\" (No Restrictions)\n2️⃣  Autostart → ON karo (Xiaomi/MIUI/Samsung mein)\n\nNeeche Settings dabao → K&S Solar dhoondo → dono options lagao.",
      [
        { text: "Baad Mein", style: "cancel" },
        {
          text: "Settings Kholein",
          onPress: () => Linking.openSettings().catch(() => {}),
        },
      ]
    );
  }).catch(() => {});
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
  const { user } = useAuth();
  const lastUserId = useRef<string | null>(null);
  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const appStateUnsubRef = useRef<(() => void) | null>(null);
  const netInfoUnsubRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (Platform.OS === "web") return;

    if (!user || user.role !== "technician") {
      if (lastUserId.current) {
        stopAlwaysOnTracking().catch(() => {});
        clearCurrentUserId().catch(() => {});
        if (pingIntervalRef.current) { clearInterval(pingIntervalRef.current); pingIntervalRef.current = null; }
        if (appStateUnsubRef.current) { appStateUnsubRef.current(); appStateUnsubRef.current = null; }
        if (netInfoUnsubRef.current) { netInfoUnsubRef.current(); netInfoUnsubRef.current = null; }
        lastUserId.current = null;
      }
      return;
    }

    if (lastUserId.current === user.id) return;
    lastUserId.current = user.id;

    // Tag current user for queue attribution; clears a previous different user's queued pings
    setCurrentUserId(user.id).catch(() => {});

    // One-time explanation before requesting background permission
    AsyncStorage.getItem(BG_PERM_SHOWN_KEY)
      .then((shown) => {
        if (!shown) {
          Alert.alert(
            "Background Location",
            "K&S Solar will track your location continuously while you are logged in so the office can see where technicians are at all times.",
            [{
              text: "OK",
              onPress: () => {
                AsyncStorage.setItem(BG_PERM_SHOWN_KEY, "1").catch(() => {});
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

    return () => {
      if (pingIntervalRef.current) { clearInterval(pingIntervalRef.current); pingIntervalRef.current = null; }
      if (appStateUnsubRef.current) { appStateUnsubRef.current(); appStateUnsubRef.current = null; }
      if (netInfoUnsubRef.current) { netInfoUnsubRef.current(); netInfoUnsubRef.current = null; }
      lastUserId.current = null;
      stopAlwaysOnTracking().catch(() => {});
      clearCurrentUserId().catch(() => {});
    };
  }, [user?.id, user?.role]);

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
