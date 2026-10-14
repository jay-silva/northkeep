import { describe, expect, it } from 'vitest';
import { devicePhrase, ollamaStartCommand, ollamaStartHint, yourDevicePhrase } from '../src/host-phrase.js';

// The phone's JavaScript engine has no Node platform: process.platform is undefined there.
const phone = undefined as unknown as NodeJS.Platform;

describe('host phrases off Node', () => {
  it('names an unknown platform "this device" instead of returning undefined', () => {
    expect(devicePhrase(phone)).toBe('this device');
    expect(devicePhrase('ios' as NodeJS.Platform)).toBe('this device');
    expect(yourDevicePhrase(phone)).toBe('your device');
  });

  it('still gives an Ollama command on an unknown platform', () => {
    expect(ollamaStartCommand(phone)).toBe('ollama serve');
    expect(ollamaStartHint(phone)).toBe('ollama serve');
  });

  it('keeps the known platforms as they were', () => {
    expect(devicePhrase('darwin')).toBe('this Mac');
    expect(devicePhrase('linux')).toBe('this Linux computer');
    expect(ollamaStartCommand('darwin')).toBe('brew services start ollama');
  });
});
