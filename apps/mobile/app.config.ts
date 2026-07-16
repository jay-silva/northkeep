import type { ExpoConfig } from 'expo/config';

/**
 * Expo app config (app.config.ts instead of app.json so decisions can carry
 * comments). Track M, milestone M6-1 (07-MOBILE-LAUNCH-PLAN.md).
 *
 * NEEDS ON-DEVICE VALIDATION (EAS build): nothing in this file has been run
 * through `expo prebuild` or an EAS build from this environment. Bundle ids,
 * plugin config, and permission strings must be verified on Jay's account.
 */
const config: ExpoConfig = {
  name: 'NorthKeep',
  slug: 'northkeep',
  version: '0.1.0',
  // The app owns the northkeep:// scheme so link QR codes can ALSO deep-link
  // straight into the app when scanned with the system camera (the in-app
  // scanner on the device-link screen is the primary path).
  scheme: 'northkeep',
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  // RN New Architecture (ADR 0017): the default and only mode on SDK 55, so
  // no newArchEnabled flag exists anymore.
  ios: {
    bundleIdentifier: 'ai.northkeep.app',
    supportsTablet: false,
    // TODO(M6-5): icons/splash from brand/, privacy nutrition label, export
    // compliance answers. Deliberately not set in the M6-1 skeleton.
  },
  android: {
    package: 'ai.northkeep.app',
  },
  plugins: [
    'expo-router',
    'expo-secure-store',
    [
      'expo-camera',
      {
        cameraPermission:
          'NorthKeep uses the camera only to scan the link code shown by NorthKeep on your computer. No photos are taken or stored.',
      },
    ],
    [
      'expo-local-authentication',
      {
        faceIDPermission:
          'NorthKeep can use Face ID to unlock your vault with a key that never leaves this device.',
      },
    ],
    // TODO(platform-mobile integration): when @northkeep/platform-mobile lands,
    // its native deps (expo-sqlite, react-native-libsodium,
    // react-native-quick-crypto) may need config-plugin entries here.
  ],
};

export default config;
