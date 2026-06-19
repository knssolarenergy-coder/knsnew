import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from "@expo-google-fonts/inter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setBaseUrl } from "@workspace/api-client-react";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import React, { useEffect, useRef } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Platform } from "react-native";
import { AuthProvider, useAuth } from "@/context/AuthContext";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ConfirmProvider } from "@/components/ConfirmModal";
import { LocationEnforcementOverlay } from "@/components/LocationEnforcementOverlay";
import { registerForPushNotificationsAsync } from "@/hooks/usePushNotifications";
import { useRouter } from "expo-router";
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
