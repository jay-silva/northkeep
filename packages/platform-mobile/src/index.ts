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
// On-device LLM seam (M6-4, ADR 0020): Tier-2 NER on the phone + airplane-mode
// private chat. Deliberately NOT re-exported from this barrel: the adapters
// (apple-fm/llama-rn) import native modules (@react-native-ai/apple, llama.rn,
// ai) that only resolve inside apps/mobile, so re-exporting here would make
// every Node consumer of @northkeep/platform-mobile fail at load. Import it via
// the subpath instead: '@northkeep/platform-mobile/dist/local-model/index.js'
// (the same convention apps/mobile uses for '@northkeep/converse/dist/turn.js').
