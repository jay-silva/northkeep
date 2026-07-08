/**
 * Minimal sodium-native declaration — only the keyed BLAKE2b that sync uses to
 * derive account/token from the device secret. Kept in lockstep with creds.ts.
 * (sodium-native ships no types; mirrors packages/core/src/sodium-native.d.ts.)
 */
declare module 'sodium-native' {
  const sodium: {
    crypto_generichash(out: Buffer, input: Buffer, key?: Buffer): void;
  };
  export = sodium;
}
