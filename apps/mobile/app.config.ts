import type { ExpoConfig } from 'expo/config';

/**
 * Expo app config (app.config.ts instead of app.json so decisions can carry
 * comments). Track M, milestone M6-2 (07-MOBILE-LAUNCH-PLAN.md).
 *
 * EAS-BUILD READY, DEVICE-UNVALIDATED: this file has been proven to bundle via
 * `npx expo export --platform ios` (Metro resolves every workspace package,
 * native module, and shim). What has NOT happened here: `expo prebuild`, the
 * native CocoaPods/Gradle compile, and any on-device run. Those only happen on
 * an EAS build against Jay's Apple account (invariant #3 / ADR 0021).
 *
 * The EAS `projectId` is intentionally absent: `eas init` (run by Jay, logged in
 * as owner `j_silva`) creates the project on Expo's side and writes
 * `extra.eas.projectId` here. Do NOT invent one.
 */
const config: ExpoConfig = {
  name: 'NorthKeep',
  slug: 'northkeep',
  // Expo account that owns the EAS project + the app slug (Jay is logged in as
  // this). Required so `eas init`/`eas build` resolve the right account.
  owner: 'j_silva',
  version: '0.1.0',
  // The app owns the northkeep:// scheme so link QR codes can ALSO deep-link
  // straight into the app when scanned with the system camera (the in-app
  // scanner on the device-link screen is the primary path).
  scheme: 'northkeep',
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  // RN New Architecture (ADR 0017): the default and only mode on SDK 55, so
  // no newArchEnabled flag exists anymore. react-native-quick-crypto (Nitro)
  // and react-native-libsodium both require New Arch, which is satisfied.
  ios: {
    // com.silvapeak.<app> is Jay's bundle-id convention. The Apple Team ID is
    // NOT stored here (public repo): EAS resolves it from Jay's logged-in Apple
    // session at build time, and his device is already a registered test device
    // so the development provisioning profile picks it up automatically.
    bundleIdentifier: 'com.silvapeak.northkeep',
    supportsTablet: false,
    infoPlist: {
      // Redundant with the expo-camera / expo-local-authentication plugin
      // options below (the plugins inject these), but declared explicitly so
      // the required usage strings are visible and guaranteed present.
      NSCameraUsageDescription:
        'NorthKeep uses the camera only to scan the link code shown by NorthKeep on your computer. No photos are taken or stored.',
      NSFaceIDUsageDescription:
        'NorthKeep can use Face ID to unlock your vault with a key that never leaves this device.',
    },
    // TODO(M6-5): icons/splash from brand/, privacy nutrition label, export
    // compliance answers. Deliberately not set in the M6-2 skeleton.
  },
  android: {
    // Kept in lock-step with the iOS bundle identifier under Jay's rebrand.
    package: 'com.silvapeak.northkeep',
  },
  plugins: [
    'expo-router',
    // Sets iOS min deployment target + New-Arch flags the native modules below
    // need at prebuild/compile time (react-native-quick-crypto declares this as
    // a peer). No-op for the Metro JS bundle; matters only on the EAS compile.
    'expo-build-properties',
    [
      'expo-secure-store',
      {
        faceIDPermission:
          'NorthKeep can use Face ID to unlock your vault with a key that never leaves this device.',
      },
    ],
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
    // Native modules from @northkeep/platform-mobile that ship their own Expo
    // config plugins (each mutates the native project at prebuild; harmless
    // during export). expo-sqlite backs the vault; the two crypto modules back
    // the CryptoProvider (ADR 0021).
    'expo-sqlite',
    'react-native-libsodium',
    'react-native-quick-crypto',
  ],
  // EAS project id, created by `eas init` under owner j_silva. A public Expo
  // identifier (it appears in the project URL), not a secret.
  extra: {
    eas: {
      projectId: '2da41269-7bcd-454f-9173-9116342a0632',
    },
  },
};

export default config;
