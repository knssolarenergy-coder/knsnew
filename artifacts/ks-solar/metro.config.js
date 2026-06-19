const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const workspaceRoot = path.resolve(__dirname, "../..");
const projectRoot = __dirname;

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];

config.resolver = config.resolver ?? {};

config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules/.pnpm/node_modules"),
];

config.resolver.blockList = [
  /node_modules[/\\]\.pnpm[/\\].*_tmp_\d+/,
  ...(Array.isArray(config.resolver.blockList) ? config.resolver.blockList : []),
];

module.exports = config;
