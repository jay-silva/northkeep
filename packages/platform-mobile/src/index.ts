export { mobilePlatform, mobilePlatformReady } from './platform.js';
export { mobileCryptoProvider, mobileCryptoReady } from './native.js';
export { mobileSqliteDriver } from './sqlite.js';
export { defaultVaultUri, mobileVaultStorage } from './storage.js';
export { deleteDeviceSecret, loadDeviceSecret, storeDeviceSecret } from './device-secret.js';
export { encodeDeviceSecretHex, parseDeviceSecretHex } from './device-secret-format.js';
// Pure building blocks, exported for the Node byte-exactness suite and for any
// future backend swap (they carry no React Native imports):
export { createMobileCryptoProvider, type MobileCryptoDeps } from './crypto.js';
export {
  argon2ParamsFromSodium,
  createNodeCryptoArgon2id,
  pwhashViaArgon2id,
  type Argon2idFn,
  type Argon2idParams,
  type NodeStyleArgon2Module,
} from './argon2.js';
export type { SodiumApi } from './sodium-api.js';
export { isNamedParamsObject, toExpoBindParams } from './sqlite-params.js';
