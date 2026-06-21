---
name: Always-on location architecture
description: How always-on 24/7 location tracking is structured — decoupled from attendance, with offline queue and per-technician trail map.
---

# Always-on location architecture

## The rule
Location tracking is **always-on for technicians** after login — NOT tied to attendance check-in/check-out.

**Why:** Admin needs to see where technicians are even when they haven't checked in. Offline pings must not be lost.

## How to apply
- `backgroundLocationTask.ts` exports `startAlwaysOnTracking()`, `sendForegroundPing()`, `startAppStateFlushListener()`, `flushOfflineQueue()`
- `_layout.tsx` has a `LocationTracker` component (renders null) that calls `startAlwaysOnTracking()` on technician login and `sendForegroundPing()` every 30s
- `startBackgroundLocation(attendanceId)` and `stopBackgroundLocation()` are kept as no-ops for backward compat (technician.tsx still calls them on check-in/check-out)
- Background task fires every 5 minutes; pings `POST /technician-locations/ping` with no attendanceId
- Offline queue stored in AsyncStorage key `ks_solar_location_queue` (max 2000 entries); flushed on next successful ping or when app foregrounds (AppState)

## DB
- `technician_location_history` — all historical pings (technicianId, lat, lng, recordedAt, receivedAt); no attendanceId
- `technician_locations` — latest position per technician (attendanceId is now nullable)

## API endpoints
- `POST /technician-locations/ping` — always-on ping (JWT auth, no attendanceId)
- `GET /technician-locations/trail?userId=&date=` — admin: ordered trail for a technician on a date
- `GET /technician-locations` — updated to show ALL technicians with a ping in last 4h (not just checked-in)

## Admin UI
- `TechTrailModal.native.tsx` — full-screen Mapbox modal with ShapeSource/LineLayer polyline trail + date picker
- `TechTrailModal.tsx` — web stub
- "Track" button on each technician card in `admin.tsx` Technicians tab
