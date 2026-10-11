/**
 * The noun in "an encrypted vault on ___". macOS stays "this Mac".
 * Linux and Windows get their own wording so a first-run dialog on those
 * machines does not claim the vault lives on a Mac.
 */
export function devicePhrase(platform: NodeJS.Platform): string {
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
      return unexpected;
    }
  }
}
