---
name: pnpm + Expo babel-preset-expo resolution
description: Why babel-preset-expo must be an explicit dependency in the Expo app under pnpm, and how it manifests.
---

# babel-preset-expo must be explicit under pnpm

`artifacts/ks-solar/babel.config.js` uses `presets: [["babel-preset-expo", ...]]`. `babel-preset-expo` is only a *transitive* dependency of `expo`. This workspace uses pnpm with the default strict node-linker (no hoisting), so a transitive dep is NOT symlinked into the app's `node_modules`. Metro's @babel/core then fails to resolve it.

**Symptom:** Metro bundle returns 500 / `TransformError: app/_layout.tsx: Cannot find module 'babel-preset-expo'`. App preview is blank white. This breaks web bundling, Expo Go, AND the EAS Android JS-bundle step (so the APK build fails too).

**Fix:** declare it explicitly: `pnpm --filter @workspace/ks-solar add -D babel-preset-expo@~54.0.11` (track the Expo SDK major — SDK 54 → 54.x).

**Why:** discovered while finalizing the app for an APK build; a transitive-only babel preset is invisible to app-level resolution under strict pnpm.

**How to apply:** any time `Cannot find module '<babel preset/plugin>'` appears for an Expo app on pnpm, the preset/plugin named in babel.config.js needs to be a direct dependency of the app package. Same logic applies to any babel plugin referenced by config but shipped only transitively.
