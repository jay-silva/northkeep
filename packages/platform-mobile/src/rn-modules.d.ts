/**
 * Ambient declarations for the React Native / Expo peer dependencies. These
 * packages are peerDependencies satisfied by the consuming Expo app; they are
 * NOT installed at the monorepo root (they cannot run under Node), so tsc needs
 * local declarations — the same pattern as platform-node/src/sodium-native.d.ts.
 *
 * Only the members this package actually uses are declared. If an upstream API
 * differs on device, the compile inside apps/mobile (which installs the real
 * packages) is the second line of defense; ADR 0021 mandates on-device
 * validation before any of this is trusted with a real vault.
 */

declare module 'react-native-libsodium' {
  /**
   * react-native-libsodium exposes a libsodium-wrappers-compatible API surface
   * (JSI-backed, synchronous). The subset declared here is the SodiumApi seam
   * in sodium-api.ts; libsodium-wrappers-sumo satisfies the same shape in the
   * Node byte-exactness tests.
   */
  const sodium: {
    ready: Promise<void>;
    crypto_generichash(
      hashLength: number,
      message: Uint8Array,
      key?: Uint8Array | null,
    ): Uint8Array;
    crypto_aead_xchacha20poly1305_ietf_encrypt(
      message: Uint8Array,
      additionalData: Uint8Array | null,
      secretNonce: null,
      publicNonce: Uint8Array,
      key: Uint8Array,
    ): Uint8Array;
    crypto_aead_xchacha20poly1305_ietf_decrypt(
      secretNonce: null,
      ciphertext: Uint8Array,
      additionalData: Uint8Array | null,
      publicNonce: Uint8Array,
      key: Uint8Array,
    ): Uint8Array;
    randombytes_buf(length: number): Uint8Array;
    crypto_aead_xchacha20poly1305_ietf_ABYTES: number;
    crypto_aead_xchacha20poly1305_ietf_NPUBBYTES: number;
  };
  export default sodium;
}

declare module 'react-native-quick-crypto' {
  /**
   * react-native-quick-crypto tracks the node:crypto API. argon2Sync landed in
   * Node 24 (OpenSSL 3.2 Argon2); the byte-exact tests run the SAME wrapper
   * (createNodeCryptoArgon2id) against node:crypto.argon2Sync, so the parameter
   * mapping is proven in Node even though this binding itself only runs on
   * device.
   */
  export function argon2Sync(
    algorithm: 'argon2d' | 'argon2i' | 'argon2id',
    parameters: {
      message: Uint8Array;
      nonce: Uint8Array;
      parallelism: number;
      tagLength: number;
      memory: number;
      passes: number;
    },
  ): Uint8Array;
}

declare module 'expo-sqlite' {
  export interface SQLiteRunResult {
    changes: number;
    lastInsertRowId: number;
  }
  export interface SQLiteExecuteSyncResult<T> extends SQLiteRunResult {
    getAllSync(): T[];
    getFirstSync(): T | null;
  }
  export interface SQLiteStatement {
    executeSync<T>(...params: unknown[]): SQLiteExecuteSyncResult<T>;
    finalizeSync(): void;
  }
  export interface SQLiteDatabase {
    prepareSync(sql: string): SQLiteStatement;
    execSync(sql: string): void;
    withTransactionSync(fn: () => void): void;
    closeSync(): void;
    serializeSync(schemaName?: string): Uint8Array;
  }
  export function openDatabaseSync(name: string, options?: unknown): SQLiteDatabase;
  export function deserializeDatabaseSync(data: Uint8Array, options?: unknown): SQLiteDatabase;
}

declare module 'expo-file-system' {
  /** SDK 54+ synchronous File/Directory API (JSI). */
  export class File {
    constructor(...uris: Array<string | File | Directory>);
    readonly exists: boolean;
    readonly uri: string;
    /** Async in expo-file-system 55; use bytesSync() for the synchronous seam. */
    bytes(): Promise<Uint8Array>;
    bytesSync(): Uint8Array;
    write(content: Uint8Array | string): void;
    writeBytes(bytes: Uint8Array): void;
    create(options?: { intermediates?: boolean; overwrite?: boolean }): void;
    copy(destination: File): void;
    move(destination: File): void;
    delete(): void;
  }
  export class Directory {
    constructor(...uris: Array<string | File | Directory>);
    readonly exists: boolean;
    readonly uri: string;
    create(options?: { intermediates?: boolean }): void;
  }
  export const Paths: {
    readonly document: Directory;
    readonly cache: Directory;
  };
}

declare module 'expo-secure-store' {
  export interface SecureStoreOptions {
    keychainAccessible?: number;
    keychainService?: string;
    requireAuthentication?: boolean;
  }
  /** iOS kSecAttrAccessibleWhenUnlockedThisDeviceOnly: never iCloud-synced. */
  export const WHEN_UNLOCKED_THIS_DEVICE_ONLY: number;
  export function getItemAsync(key: string, options?: SecureStoreOptions): Promise<string | null>;
  export function setItemAsync(
    key: string,
    value: string,
    options?: SecureStoreOptions,
  ): Promise<void>;
  export function deleteItemAsync(key: string, options?: SecureStoreOptions): Promise<void>;
}

/**
 * On-device model backends (M6-4, ADR 0020). Declared ambiently for the same
 * reason as the crypto/sqlite modules above: the real packages are installed by
 * apps/mobile (native code that only compiles at prebuild/EAS), not at the
 * monorepo root, so tsc compiles packages/platform-mobile/src/local-model
 * against these minimal declarations. Only the members the adapters use are
 * declared; the on-device compile in apps/mobile is the second line of defense.
 */
declare module '@react-native-ai/apple' {
  /** Opaque AI-SDK LanguageModel handle returned by apple(). */
  export interface AppleLanguageModel {
    readonly provider?: string;
  }
  /** Callable provider (apple()) that also exposes a sync capability probe. */
  export const apple: {
    (): AppleLanguageModel;
    isAvailable(): boolean;
  };
}

declare module 'llama.rn' {
  export interface LlamaCompletionResult {
    text: string;
  }
  export interface LlamaContext {
    completion(
      params: {
        messages?: Array<{ role: string; content: string }>;
        prompt?: string;
        n_predict?: number;
        stop?: string[];
        temperature?: number;
        response_format?: { type: string; json_schema?: unknown };
        grammar?: string;
      },
      callback?: (data: { token: string }) => void,
    ): Promise<LlamaCompletionResult>;
    release(): Promise<void>;
  }
  export function initLlama(options: {
    model: string;
    n_ctx?: number;
    n_gpu_layers?: number;
    use_mlock?: boolean;
    embedding?: boolean;
  }): Promise<LlamaContext>;
}

declare module 'ai' {
  /** Minimal subset of the Vercel AI SDK used by AppleFMModel. */
  export function generateText(options: {
    model: unknown;
    messages?: unknown;
    prompt?: string;
    abortSignal?: AbortSignal;
    maxOutputTokens?: number;
  }): Promise<{ text: string }>;
  export function streamText(options: {
    model: unknown;
    messages?: unknown;
    prompt?: string;
    abortSignal?: AbortSignal;
    maxOutputTokens?: number;
  }): { textStream: AsyncIterable<string> };
  export function generateObject(options: {
    model: unknown;
    schema: unknown;
    prompt?: string;
    messages?: unknown;
  }): Promise<{ object: unknown }>;
  export function jsonSchema(schema: Record<string, unknown>): unknown;
}
