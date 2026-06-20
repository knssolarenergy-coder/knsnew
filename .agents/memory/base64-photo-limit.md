---
name: Base64 photo upload body limit
description: Sending photos as base64 in JSON body hits Express default 100kb limit; fix and approach documented here.
---

## Rule
Always set `express.json({ limit: "25mb" })` (and same for urlencoded) when the API accepts base64-encoded images in request bodies.

**Why:** Express body-parser defaults to 100kb. A quality-0.4 JPEG selfie from a phone camera is typically 150–400kb in base64. Without the limit increase, check-in POST returns HTTP 413 PayloadTooLargeError even though the JSON schema is valid.

**How to apply:** In `artifacts/api-server/src/app.ts`, both `express.json()` and `express.urlencoded()` must have `limit: "25mb"`. This is already set — do NOT remove it.

## Companion: get base64 at capture time
Use `base64: true` + `quality: 0.4` in `ImagePicker.launchCameraAsync()` / `launchImageLibraryAsync()` so the data URL is ready immediately — no FileReader, no expo-file-system needed.
`uploadPhoto(uri)` short-circuits with `if (uri.startsWith("data:")) return uri` for the fast path.
