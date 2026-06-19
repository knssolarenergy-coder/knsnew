---
name: EAS build needs EAS_NO_VCS=1 in this environment
description: The Replit main-agent sandbox blocks the git operations EAS uses to archive the project, so eas build must bypass VCS.
---

# EAS build: bypass git with EAS_NO_VCS=1

`eas build` by default uses git to create the uploaded project archive (it acquires `.git/index.lock` / runs git plumbing). In the Replit main-agent sandbox these are treated as destructive git operations and are blocked, so the build aborts immediately with `Destructive git operations are not allowed in the main agent`.

**Fix:** prefix the command with `EAS_NO_VCS=1`, which makes EAS archive the working directory directly (respecting `.easignore`/`.gitignore`) instead of using git.

Working invocation (Android APK, this repo):
`cd artifacts/ks-solar && EAS_NO_VCS=1 npx --no-install eas build --profile preview --platform android --non-interactive --no-wait`

**Why:** the sandbox forbids git mutations on the main branch; EAS's git archive path triggers exactly that. Discovered when an APK build failed on `.git/index.lock`.

**How to apply:** any `eas build`/`eas update` (or other tool that snapshots via git) launched from the main agent here needs `EAS_NO_VCS=1`. Use `--no-wait` because cloud builds run ~15-25 min and exceed the shell timeout; the CLI returns a build URL to poll. Auth is non-interactive via the already-configured `EXPO_TOKEN`; the existing remote Android keystore is reused.
