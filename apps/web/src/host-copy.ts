import { devicePhrase, ollamaAltCommand, ollamaInstallCommand, ollamaStartCommand } from '@northkeep/core';

/**
 * User-facing words that name this computer or tell the user how to start
 * Ollama. macOS keeps the brew and Keychain wording. Linux does not.
 */
export interface HostCopy {
  device: string;
  deviceTitle: string;
  /** Primary command to start Ollama. */
  ollamaStart: string;
  /** A second way to start it, when the primary one is not the only one. */
  ollamaAlt: string | null;
  /** Shell install command. Null where the download page is the instruction. */
  ollamaInstall: string | null;
  /** Saved endpoint label, such as "This Linux computer: Ollama". */
  ollamaLabel: string;
  /**
   * What happens to a provider API key. Only macOS stores one, in the Keychain.
   * Other platforms must not claim a store they do not have.
   */
  providerKeyNote: string;
}

function titleDevice(platform: NodeJS.Platform): string {
  const device = devicePhrase(platform);
  return device.charAt(0).toUpperCase() + device.slice(1);
}

export function localModelLabel(platform: NodeJS.Platform, model: string): string {
  return titleDevice(platform) + ': ' + model;
}

/** Fields the desktop page reads from GET /api/status. */
export function hostStatus(platform: NodeJS.Platform): {
  ollama_start: string;
  ollama_alt: string | null;
  ollama_install: string | null;
  ollama_label: string;
  provider_key_note: string;
} {
  const copy = hostCopy(platform);
  return {
    ollama_start: copy.ollamaStart,
    ollama_alt: copy.ollamaAlt,
    ollama_install: copy.ollamaInstall,
    ollama_label: copy.ollamaLabel,
    provider_key_note: copy.providerKeyNote,
  };
}

export function hostCopy(platform: NodeJS.Platform): HostCopy {
  const device = devicePhrase(platform);
  const deviceTitle = titleDevice(platform);
  const providerKeyNote = platform === 'darwin'
    ? 'Your key goes straight to the macOS Keychain; never written to files or shown again.'
    : 'API keys are not saved on this computer. NorthKeep does not write them to files.';
  return {
    device,
    deviceTitle,
    ollamaStart: ollamaStartCommand(platform),
    ollamaAlt: ollamaAltCommand(platform),
    ollamaInstall: ollamaInstallCommand(platform),
    ollamaLabel: deviceTitle + ': Ollama',
    providerKeyNote,
  };
}
