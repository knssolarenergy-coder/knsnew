import { setAuthTokenGetter } from "@workspace/api-client-react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { Platform } from "react-native";
import { clearCurrentUserId, mirrorAuthToken, stopAlwaysOnTracking } from "../backgroundLocationTask";

export interface UpdateProfileData {
  name: string;
  phone: string;
  city?: string | null;
  bankName?: string | null;
  bankAccountNumber?: string | null;
  bankAccountTitle?: string | null;
  inverterBrand?: string | null;
}

const TOKEN_KEY = "ks_solar_token";
// Last-known profile cached on disk. Lets a logged-in user (especially a
// technician whose background tracking must keep running) stay signed in across
// app restarts and network blips, instead of being logged out the moment
// /auth/me can't be reached.
const USER_CACHE_KEY = "ks_solar_user_cache";

async function cacheUser(u: UserProfile | null): Promise<void> {
  try {
    if (u) await AsyncStorage.setItem(USER_CACHE_KEY, JSON.stringify(u));
    else await AsyncStorage.removeItem(USER_CACHE_KEY);
  } catch {}
}

async function loadCachedUser(): Promise<UserProfile | null> {
  try {
    const raw = await AsyncStorage.getItem(USER_CACHE_KEY);
    return raw ? (JSON.parse(raw) as UserProfile) : null;
  } catch {
    return null;
  }
}

export interface UserProfile {
  id: string;
  name: string;
  email: string;
  phone: string;
  isAdmin: boolean;
  isMaster: boolean;
  inverterBrand: string | null;
  city: string | null;
  status: string;
  role: string;
  specialty: string | null;
  createdAt: string;
  referralCode?: string | null;
  referralPoints?: number;
  bankName?: string | null;
  bankAccountNumber?: string | null;
  bankAccountTitle?: string | null;
}

interface AuthContextType {
  user: UserProfile | null;
  token: string | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  loginWithToken: (token: string, user: UserProfile) => Promise<void>;
  register: (
    name: string,
    email: string,
    phone: string,
    password: string,
    isMaster: boolean,
    inverterBrand: string | null,
    referralCode?: string | null
  ) => Promise<boolean>;
  logout: () => Promise<void>;
  updateProfile: (data: UpdateProfileData) => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

async function storeToken(token: string | null) {
  if (Platform.OS === "web") {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
    return;
  }
  if (token) await SecureStore.setItemAsync(TOKEN_KEY, token);
  else await SecureStore.deleteItemAsync(TOKEN_KEY);
  // Mirror token presence so KSSolarBootReceiver can check auth state from Java.
  await mirrorAuthToken(token !== null);
}

async function loadToken(): Promise<string | null> {
  if (Platform.OS === "web") return localStorage.getItem(TOKEN_KEY);
  return SecureStore.getItemAsync(TOKEN_KEY);
}

const BASE =
  Platform.OS === "web" && typeof window !== "undefined"
    ? `${window.location.origin}/api`
    : `https://${process.env.EXPO_PUBLIC_DOMAIN}/api`;

// Safely parse a response body as JSON. Returns null for empty / non-JSON
// bodies instead of throwing the cryptic
// "Failed to execute 'json' on 'Response': Unexpected end of JSON input"
// error that occurs when the API server is down or a proxy returns an
// empty / HTML error page.
async function parseJsonSafe(res: Response): Promise<any> {
  const text = await res.text();
  if (!text || text.trim() === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function apiPost<T>(path: string, body: unknown, token?: string | null): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("Cannot reach the server. Please check your internet connection and try again.");
  }
  const data = await parseJsonSafe(res);
  if (!res.ok) {
    const err: any = new Error(
      data?.message ??
        data?.error ??
        (res.status >= 500
          ? "Server error. Please try again in a moment."
          : "Request failed")
    );
    err.code = data?.error;
    throw err;
  }
  if (data == null) {
    throw new Error("The server returned an unexpected response. Please try again.");
  }
  return data as T;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadToken().then(async (t) => {
      setToken(t);
      if (!t) {
        setIsLoading(false);
        return;
      }
      setAuthTokenGetter(() => t);

      // Optimistically restore the last-known profile so a logged-in user stays
      // signed in (and a technician's tracking keeps running) before /auth/me
      // responds — and even if it never does because the network is down.
      const cached = await loadCachedUser();
      if (cached) {
        setUser(cached);
        setIsLoading(false);
      }

      // Validate the token in the background. ONLY a definitive auth rejection
      // (401/403) logs the user out. A network error, timeout, or 5xx must NOT —
      // otherwise a technician in a low-signal area gets logged out and their
      // background location tracking dies with the wiped token.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const r = await fetch(`${BASE}/auth/me`, {
          headers: { Authorization: `Bearer ${t}` },
          signal: controller.signal,
        });
        if (r.ok) {
          const u = await parseJsonSafe(r);
          if (u) {
            setUser(u as UserProfile);
            cacheUser(u as UserProfile);
          }
        } else if (r.status === 401 || r.status === 403) {
          // Token was revoked / definitively rejected → force a FULL logout,
          // including stopping background tracking. LocationTracker never stops
          // on user=null, so we must stop the native service here explicitly,
          // otherwise a deauthorized device would keep reporting location.
          await stopAlwaysOnTracking();
          await clearCurrentUserId();
          setToken(null);
          setUser(null);
          setAuthTokenGetter(null);
          await storeToken(null);
          await cacheUser(null);
        }
        // Other statuses (5xx etc.): keep token + cached user, retry next launch.
      } catch {
        // Network error / timeout: keep token + cached user — do not log out.
      } finally {
        clearTimeout(timer);
        setIsLoading(false);
      }
    });
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const { token: t, user: u } = await apiPost<{ token: string; user: UserProfile }>(
      "/auth/login",
      { email, password }
    );
    await storeToken(t);
    setToken(t);
    setUser(u);
    setAuthTokenGetter(() => t);
    cacheUser(u);
  }, []);

  const loginWithToken = useCallback(async (t: string, u: UserProfile) => {
    await storeToken(t);
    setToken(t);
    setUser(u);
    setAuthTokenGetter(() => t);
    cacheUser(u);
  }, []);

  // Returns true if account is pending approval (don't log in)
  const register = useCallback(async (
    name: string,
    email: string,
    phone: string,
    password: string,
    isMaster: boolean,
    inverterBrand: string | null,
    referralCode?: string | null
  ): Promise<boolean> => {
    const result = await apiPost<{ pending?: boolean; message?: string; token?: string; user?: UserProfile }>(
      "/auth/register",
      { name, email, phone, password, isMaster, inverterBrand, ...(referralCode ? { referralCode } : {}) }
    );
    if (result.pending) {
      return true;
    }
    if (result.token && result.user) {
      await storeToken(result.token);
      setToken(result.token);
      setUser(result.user);
      setAuthTokenGetter(() => result.token!);
      cacheUser(result.user);
    }
    return false;
  }, []);

  const logout = useCallback(async () => {
    // Explicit logout is the ONLY place that stops always-on background tracking.
    // (React lifecycle / transient null users must never stop it.)
    await stopAlwaysOnTracking();
    await clearCurrentUserId();
    await storeToken(null);
    await cacheUser(null);
    setToken(null);
    setUser(null);
    setAuthTokenGetter(null);
  }, []);

  const updateProfile = useCallback(async (data: UpdateProfileData) => {
    const currentToken = token;
    if (!currentToken) throw new Error("Not authenticated");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${currentToken}`,
    };
    let res: Response;
    try {
      res = await fetch(`${BASE}/auth/me`, {
        method: "PATCH",
        headers,
        body: JSON.stringify(data),
      });
    } catch {
      throw new Error("Cannot reach the server. Please check your internet connection and try again.");
    }
    const json = await parseJsonSafe(res);
    if (!res.ok) throw new Error(json?.error ?? "Update failed");
    if (json == null) throw new Error("The server returned an unexpected response. Please try again.");
    setUser(json as UserProfile);
    cacheUser(json as UserProfile);
  }, [token]);

  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    const currentToken = token;
    if (!currentToken) throw new Error("Not authenticated");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${currentToken}`,
    };
    let res: Response;
    try {
      res = await fetch(`${BASE}/auth/me/password`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ currentPassword, newPassword }),
      });
    } catch {
      throw new Error("Cannot reach the server. Please check your internet connection and try again.");
    }
    const json = await parseJsonSafe(res);
    if (!res.ok) throw new Error(json?.error ?? "Password change failed");
  }, [token]);

  return (
    <AuthContext.Provider value={{ user, token, isLoading, login, loginWithToken, register, logout, updateProfile, changePassword }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
