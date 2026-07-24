import { KNOWN_TOOL_NAMES, loadToolsConfig, setToolEnabled, toolsConfigPath } from '@northkeep/converse';
import { DIM, GREEN, RESET, YELLOW } from './ui.js';

/**
 * `northkeep tools` — the agent-tool switchboard (M10b, ADR 0028). Tools ship
 * DISABLED; only this config enables them (never the model, never a flag on a
 * request). Same command style as `northkeep routing`.
 */

export function toolsList(): void {
  const config = loadToolsConfig();
  for (const name of KNOWN_TOOL_NAMES) {
    const enabled = config.tools[name]?.enabled === true;
    console.log(
      `  ${name.padEnd(12)} ${enabled ? `${GREEN}enabled${RESET}` : `${DIM}disabled${RESET}`}`,
    );
  }
  console.log(`\n${DIM}Stored in ${toolsConfigPath()} (settings only — no secrets, no content).${RESET}`);
  console.log(`${DIM}Enable with: northkeep tools enable <name> · use with: northkeep converse --tools${RESET}`);
  if (KNOWN_TOOL_NAMES.some((n) => config.tools[n]?.enabled)) {
    console.log(
      `${YELLOW}Note:${RESET} every tool call still asks for your approval before it runs (M10b placeholder gate).`,
    );
  }
}

export function toolsEnable(name: string, fail: (m: string) => never): void {
  try {
    setToolEnabled(name, true);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  console.log(`✓ ${name} enabled. Use it with: northkeep converse --tools`);
  console.log('  Every call shows you the exact URL/arguments and waits for your yes.');
}

export function toolsDisable(name: string, fail: (m: string) => never): void {
  try {
    setToolEnabled(name, false);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  console.log(`✓ ${name} disabled.`);
}
