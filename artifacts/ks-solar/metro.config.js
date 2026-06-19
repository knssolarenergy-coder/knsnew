const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// Block Metro from watching pnpm tmp directories that appear briefly during
// installs and cause ENOENT watcher crashes (e.g. tslib_tmp_*, node-fetch_tmp_*)
config.resolver = config.resolver ?? {};
config.resolver.blockList = [
  /node_modules[/\\]\.pnpm[/\\].*_tmp_\d+/,
  ...(Array.isArray(config.resolver.blockList) ? config.resolver.blockList : []),
];

module.exports = config;
