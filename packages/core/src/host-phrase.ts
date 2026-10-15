/**
 * The noun in "an encrypted vault on ___", and the Ollama commands that go
 * with it. macOS stays "this Mac" and Homebrew. Linux and Windows do not.
 */
export function devicePhrase(platform: NodeJS.Platform | undefined): string {
  if (platform === undefined) return 'this device';
  switch (platform) {
    case 'darwin':
      return 'this Mac';
    case 'linux':
      return 'this Linux computer';
    case 'win32':
      return 'this Windows PC';
    case 'aix':
    case 'android':
    case 'freebsd':
    case 'haiku':
    case 'openbsd':
    case 'sunos':
    case 'cygwin':
    case 'netbsd':
      return 'this computer';
    default: {
      const unexpected: never = platform;
      void unexpected;
      return 'this device';
    }
  }
}

/**
 * The platform this code runs on, read at call time. Undefined on the phone,
 * which has no Node platform. Never read it at module load in code the phone
 * bundles: build 31 crashed on launch that way.
 */
export function hostPlatform(): NodeJS.Platform | undefined {
  return typeof process === 'undefined' ? undefined : process.platform;
}

/** devicePhrase for the device running this code: "this Mac", or "this device" on the phone. */
export function thisDevicePhrase(): string {
  return devicePhrase(hostPlatform());
}

/** "your Mac", "your Linux computer", and the same for the other platforms. */
export function yourDevicePhrase(platform: NodeJS.Platform | undefined): string {
  return devicePhrase(platform).replace(/^this /, 'your ');
}

/** The command that starts Ollama on this platform. */
export function ollamaStartCommand(platform: NodeJS.Platform | undefined): string {
  if (platform === undefined) return 'ollama serve';
  switch (platform) {
    case 'darwin':
      return 'brew services start ollama';
    case 'linux':
      return 'systemctl start ollama';
    case 'win32':
    case 'aix':
    case 'android':
    case 'freebsd':
    case 'haiku':
    case 'openbsd':
    case 'sunos':
    case 'cygwin':
    case 'netbsd':
      return 'ollama serve';
    default: {
      const unexpected: never = platform;
      void unexpected;
      return 'ollama serve';
    }
  }
}

/** A second way to start Ollama, when the primary command is not the only one. */
export function ollamaAltCommand(platform: NodeJS.Platform | undefined): string | null {
  return platform === 'linux' ? 'ollama serve' : null;
}

/**
 * A shell install command. Null where the download page is the instruction:
 * Linux should not be told to pipe a Homebrew command.
 */
export function ollamaInstallCommand(platform: NodeJS.Platform | undefined): string | null {
  return platform === 'darwin' ? 'brew install ollama' : null;
}

/** What a user can paste when Ollama is missing. Includes the alternate on Linux. */
export function ollamaStartHint(platform: NodeJS.Platform | undefined): string {
  const start = ollamaStartCommand(platform);
  const alt = ollamaAltCommand(platform);
  const install = ollamaInstallCommand(platform);
  const run = alt ? `${start} or ${alt}` : start;
  return install ? `${install} && ${start}` : run;
}
