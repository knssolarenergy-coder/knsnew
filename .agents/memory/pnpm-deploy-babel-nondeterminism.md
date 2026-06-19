---
name: Non-deterministic @babel resolution in pnpm deploy builds
description: Why an Expo/pnpm production build can fail intermittently with "Cannot find module '@babel/traverse'" and the deterministic fix.
---

# Intermittent "Cannot find module '@babel/...'" in pnpm + Expo production builds

A package can `require("@babel/traverse")` (and `@babel/generator`, `@babel/types`, etc.) at build time without declaring it as a dependency, relying on it being present somewhere pnpm happened to hoist it. Under pnpm's strict node-linker, whether that bare require resolves depends on the **peer-variant** layout pnpm produces — and that layout is **not stable across different install environments** (dev container vs. the deploy builder). The result: the same committed code publishes successfully some attempts and fails others with `Cannot find module '@babel/traverse'`. Intermittent build failures with no code change between them are the tell.

Concrete case here: `react-native-worklets`' Babel plugin is loaded by `babel-preset-expo` during the deploy's `expo export --platform web` step and does `require("@babel/traverse")` without declaring it.

**Fix:** declare the undeclared build-time deps on the offending package via pnpm `packageExtensions` (in `pnpm-workspace.yaml`), e.g. add `@babel/{core,generator,traverse,types}` to `react-native-worklets`. This makes pnpm hard-link them into that package's own `node_modules` in **every** install, removing the reliance on hoisting.

**Why:** `packageExtensions` changes the lockfile so the dependency is explicit and deterministic everywhere, instead of depending on environment-specific hoist layout. Verified by checking the app's symlink target variant has the modules as siblings, then re-running the exact failing step (`node artifacts/ks-solar/scripts/build.js`).

**How to apply:** when a build (especially a Babel/Metro plugin) fails with a bare `Cannot find module '@some/transitive'` that resolves fine locally but fails in CI/deploy — don't add it as an app-level devDep (that only fixes things the app's own config requires by path); instead add it to the requiring package via `packageExtensions`, run `pnpm install`, and confirm the hard link. Contrast with the sibling lesson where `babel-preset-expo` *did* need to be an app-level devDep because `babel.config.js` references it by name from the app dir.
