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
import { Platform } from "react-native";
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
  startAlwaysOnTracking,
  startAppStateFlushListener,
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

  useEffect(() => {
    if (Platform.OS === "web") return;
    if (!user || user.role !== "technician") return;
    if (lastUserId.current === user.id) return;
    lastUserId.current = user.id;

    startAlwaysOnTracking().catch(() => {});
    flushOfflineQueue().catch(() => {});
    sendForegroundPing().catch(() => {});

    pingIntervalRef.current = setInterval(() => {
      sendForegroundPing().catch(() => {});
    }, 30_000);

    appStateUnsubRef.current = startAppStateFlushListener();

    return () => {
      if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
      if (appStateUnsubRef.current) appStateUnsubRef.current();
      lastUserId.current = null;
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
