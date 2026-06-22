---
name: Android always-on background location tracking
description: Why technician GPS tracking silently stopped after hours, and the rules that keep it alive on Android (esp. aggressive OEMs).
---

# Always-on background location must never be stopped by React lifecycle

**Rule:** The native foreground location service (expo-location `startLocationUpdatesAsync` + `LocationTaskService`) must be stopped in EXACTLY ONE place: an explicit user logout. Never stop it from:
- a React `useEffect` cleanup (return fn) — React unmounts/remounts the tree when Android recreates the Activity (app backgrounded, low memory, config change), so cleanup fires while the user is still logged in and kills tracking.
- a transient `!user` / null-user branch — `user` flickers to null during token re-validation on cold start/resume; treating that as logout kills tracking.

**Why:** Tracking "worked for a few hours then died" (admin map showed a technician stuck at "Away Xh ago"). Root cause was JS calling `stopLocationUpdatesAsync()` itself from effect cleanup + the null-user branch. `android:stopWithTask="false"` cannot help when JS explicitly stops the service.

**How to apply:**
- LocationTracker effect: gate on `!isLoading` (auth settled) before acting; cleanup only tears down JS intervals/listeners; only stop the service for a CONFIRMED logged-in non-technician (role change). Explicit `logout()` in AuthContext is the only place that calls `stopAlwaysOnTracking()` + `clearCurrentUserId()`.
- Auth: never log the user out (wipe token) on a network error / timeout / 5xx from `/auth/me` — only on 401/403. The headless location task reads the token from SecureStore, so wiping it on a network blip also kills background pings. Cache the last-known profile and optimistically restore it so a technician stays logged in offline.
- Headless location task callback must stay tiny: send ONE ping (with a hard fetch timeout via AbortController) or enqueue; never run the multi-request offline-queue flush inside it (flush only in foreground via AppState 'active' + NetInfo reconnect). Use an in-flight guard so callbacks don't overlap. A hung fetch with no timeout wedges the headless JS runtime.
- Changing `startLocationUpdatesAsync` options has no effect on already-installed devices unless you force a restart — `hasStartedLocationUpdatesAsync()` keeps the original persisted options. Gate a one-time stop+start on a stored config-version key.
- OEM (MIUI/Xiaomi/EMUI/Samsung) battery management is NOT fully fixable in code: user must enable Autostart, set battery to Unrestricted/No-restrictions, and lock the app in recents. Surface this as mandatory in-app guidance; code can only open settings.

**What was tried and REJECTED:** native AlarmManager watchdog (BroadcastReceiver + ContentProvider) caused crashes; expo-background-fetch (WorkManager) backup added crashes/complexity. Both removed. The reliable fix was removing the JS-initiated stops + fetch timeouts, not adding more restart machinery.
