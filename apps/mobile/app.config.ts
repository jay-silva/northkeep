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
  // Brand app icon (master 1024x1024 from brand/northkeep-icon-1024.png). Expo
  // generates every platform size from this at build; the top-level `icon` is
  // what iOS uses (no separate ios.icon needed on SDK 55). RGB, no alpha, so the
  // App Store's "no transparency in the marketing icon" rule is satisfied.
  icon: './assets/icon.png',
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
    // Explicit build number: autoIncrement can't write back into a dynamic
    // app.config.ts (EAS only auto-bumps a static app.json), so bump this by hand
    // each TestFlight upload (2, 3, ...) or switch eas.json to appVersionSource:
    // "remote" later to have EAS track it.
    buildNumber: '2',
    infoPlist: {
      // Export compliance (US EAR). NorthKeep is publicly available open-source
      // software (AGPL, github.com/jay-silva/northkeep) that uses only standard,
      // published cryptographic algorithms via libsodium (XChaCha20-Poly1305,
      // Argon2id, BLAKE2b). It rests on the publicly-available / open-source
      // exemption, so false = no per-submission compliance document is required.
      // That basis is supported by the one-time BIS + NSA source-URL notification
      // (EAR 742.15(b)); confirm with export counsel before the PUBLIC App Store
      // release. Fine as-is for TestFlight testing.
      ITSAppUsesNonExemptEncryption: false,
      // Redundant with the expo-camera / expo-local-authentication plugin
      // options below (the plugins inject these), but declared explicitly so
      // the required usage strings are visible and guaranteed present.
      NSCameraUsageDescription:
        'NorthKeep uses the camera only to scan the link code shown by NorthKeep on your computer. No photos are taken or stored.',
      NSFaceIDUsageDescription:
        'NorthKeep can use Face ID to unlock your vault with a key that never leaves this device.',
    },
    // App icon comes from the top-level `icon` above (brand master). Export
    // compliance answered via ITSAppUsesNonExemptEncryption above. Still
    // TODO(M6-5): App Store privacy nutrition label.
  },
  android: {
    // Kept in lock-step with the iOS bundle identifier under Jay's rebrand.
    package: 'com.silvapeak.northkeep',
    // Android adaptive icon: same brand master as the foreground. The art is a
    // full-bleed white-background square, so backgroundColor is white to match
    // (it only shows where the foreground is transparent, which here it isn't).
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      backgroundColor: '#ffffff',
    },
  },
  plugins: [
    'expo-router',
    // Splash screen: centered brand mark at ~200pt from the 1024 master.
    // The brand art has a SOLID WHITE background (RGB, no alpha), and its own
    // fill colors (the "N" and circuit traces) are light, so it can't be keyed
    // to transparency. The splash background is therefore white to match the
    // art's own field — a dark bg (the app's colors.bg #0f1420) would show a
    // white square floating around the mark. If a dark splash is wanted, supply
    // a dark-background or alpha-cut variant of the mark and flip this to
    // #0f1420. Rendered result is only confirmable on an EAS build / device.
    [
      'expo-splash-screen',
      {
        image: './assets/splash-icon.png',
        backgroundColor: '#ffffff',
        imageWidth: 200,
      },
    ],
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
