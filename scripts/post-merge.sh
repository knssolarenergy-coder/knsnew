#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm --filter @workspace/db run push

# Create symlink for babel-preset-expo so Metro bundler can resolve it
# in the pnpm hoisted workspace setup (it's a devDep of ks-solar, not hoisted to root).
BABEL_PRESET_PATH=$(ls -d node_modules/.pnpm/babel-preset-expo*/node_modules/babel-preset-expo 2>/dev/null | head -1)
if [ -n "$BABEL_PRESET_PATH" ]; then
  mkdir -p artifacts/ks-solar/node_modules
  ln -sfn "/home/runner/workspace/$BABEL_PRESET_PATH" artifacts/ks-solar/node_modules/babel-preset-expo
fi
