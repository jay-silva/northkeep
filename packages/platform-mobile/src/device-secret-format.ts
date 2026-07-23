import { DEVICE_SECRET_BYTES } from '@northkeep/core';

/**
 * Wire format of the device secret, shared verbatim with desktop
 * (platform-node/src/platform.ts): 64 lowercase-or-uppercase hex characters
 * encoding exactly 32 bytes. The QR link payload (northkeep://link/v1?ds=...)
 * and SecureStore both carry this hex string, so a phone-derived master key is
 * bit-for-bit the desktop's. Pure module: Node-testable.
 */

export function encodeDeviceSecretHex(secret: Uint8Array): string {
  if (secret.length !== DEVICE_SECRET_BYTES) {
    throw new Error(`device secret must be ${DEVICE_SECRET_BYTES} bytes`);
  }
  return Buffer.from(secret.buffer, secret.byteOffset, secret.byteLength).toString('hex');
}

/** Same validation as desktop loadDeviceSecret; throws on malformed input. */
export function parseDeviceSecretHex(hex: string): Buffer {
  const trimmed = hex.trim();
  if (!/^[0-9a-f]{64}$/i.test(trimmed)) {
    throw new Error('Device secret is malformed (expected 64 hex characters).');
  }
  const secret = Buffer.from(trimmed, 'hex');
  if (secret.length !== DEVICE_SECRET_BYTES) {
    throw new Error('Device secret has the wrong length.');
  }
  return secret;
}
