/**
 * Metro config for the pnpm monorepo + the Node-builtin seam.
 *
 * @northkeep/core and @northkeep/sync are written for Node and import
 * node:fs / node:os / node:path / node:crypto at module top level (platform.ts,
 * lock.ts, sync config/client). The mobile app never CALLS those code paths
 * (it goes through the platform seam and its own SecureStore/pull modules),
 * but Metro still has to RESOLVE the imports to bundle the packages. Each
 * builtin maps to a tiny local shim that throws with a clear message if a
 * Node-only path is ever reached at runtime; `buffer` maps to the npm
 * `buffer` polyfill the vault code depends on.
 *
 * NEEDS ON-DEVICE VALIDATION: this resolver wiring has not been exercised by
 * a real Metro bundle from this environment (`npx expo export` or an EAS
 * build is the check).
 */
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const workspaceRoot = path.resolve(__dirname, '../..');
const config = getDefaultConfig(__dirname);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

const NODE_SHIMS = {
  fs: path.resolve(__dirname, 'shims/node-fs.js'),
  os: path.resolve(__dirname, 'shims/node-os.js'),
  path: path.resolve(__dirname, 'shims/node-path.js'),
  crypto: path.resolve(__dirname, 'shims/node-crypto.js'),
  buffer: require.resolve('buffer/'),
};

const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const bare = moduleName.startsWith('node:') ? moduleName.slice('node:'.length) : moduleName;
  if (Object.prototype.hasOwnProperty.call(NODE_SHIMS, bare)) {
    return { type: 'sourceFile', filePath: NODE_SHIMS[bare] };
  }
  if (defaultResolveRequest) return defaultResolveRequest(context, moduleName, platform);
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
