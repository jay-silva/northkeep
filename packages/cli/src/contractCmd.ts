import {
  CONTRACT_TEXT,
  chatgptStatus,
  claudeCodeStatus,
  contractStatusAll,
  cursorGitVisibilityNote,
  cursorStatus,
  installAll,
  installContract,
  uninstallContract,
  type ContractTarget,
  type InstallResult,
} from '@northkeep/mcp-server';

/**
 * `northkeep contract` — M16 session-contract installer (ADR 0042).
 * Writes the standing project instruction into Claude Code, Codex, or a
 * Cursor project. Advisory, not enforced. Does not redact chat.
 */

const TARGET_LABEL: Record<ContractTarget, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  'cursor-project': 'Cursor (this project)',
};

const GAPS =
  'This contract does not reach Claude Desktop plain chat or ChatGPT chat. Those surfaces have no on-disk instruction file.';

function connectWarn(target: ContractTarget): string | null {
  switch (target) {
    case 'claude':
      return claudeCodeStatus().connected
        ? null
        : 'Claude Code is not connected to NorthKeep yet. The contract is installed, but project tools will not be available until you connect.';
    case 'codex':
      return chatgptStatus().connected
        ? null
        : 'ChatGPT / Codex is not connected to NorthKeep yet. The contract is installed, but project tools will not be available until you connect.';
    case 'cursor-project':
      return cursorStatus().connected
        ? null
        : 'Cursor is not connected to NorthKeep yet. The contract is installed, but project tools will not be available until you connect.';
    default: {
      const _exhaustive: never = target;
      throw new Error(`Unhandled Contract target: ${String(_exhaustive)}`);
    }
  }
}

function printInstallResult(result: InstallResult): void {
  if (result.skipped) {
    console.log(`⚠  ${result.skipReason}`);
    return;
  }
  console.log(`✓ Installed the session contract for ${TARGET_LABEL[result.target]}.`);
  console.log(`  ${result.path}`);
  if (result.warning) console.log(`⚠  ${result.warning}`);
  const warn = connectWarn(result.target);
  if (warn) console.log(`⚠  ${warn}`);
  if (result.target === 'cursor-project') {
    console.log(`⚠  ${cursorGitVisibilityNote()}`);
  }
}

export function contractInstallCmd(
  raw: string,
  options: { project?: string },
  fail: (m: string) => never,
): void {
  try {
    if (raw === 'all') {
      for (const result of installAll()) printInstallResult(result);
      console.log('');
      console.log(GAPS);
      return;
    }
    let target: ContractTarget;
    switch (raw) {
      case 'claude':
      case 'codex':
        target = raw;
        break;
      case 'cursor':
        target = 'cursor-project';
        break;
      default:
        fail('Target must be claude, codex, cursor, or all.');
    }
    if (target === 'cursor-project' && !options.project) {
      fail('Cursor contract install requires --project <dir>.');
    }
    printInstallResult(installContract(target, { projectDir: options.project }));
    console.log('');
    console.log(GAPS);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

export function contractUninstallCmd(
  raw: string,
  options: { project?: string },
  fail: (m: string) => never,
): void {
  let target: ContractTarget;
  switch (raw) {
    case 'claude':
    case 'codex':
      target = raw;
      break;
    case 'cursor':
      target = 'cursor-project';
      break;
    default:
      fail('Target must be claude, codex, or cursor.');
  }
  if (target === 'cursor-project' && !options.project) {
    fail('Cursor contract uninstall requires --project <dir>.');
  }
  try {
    const result = uninstallContract(target, { projectDir: options.project });
    switch (result.action) {
      case 'deleted':
        console.log(`✓ Removed the ${TARGET_LABEL[target]} session contract.`);
        break;
      case 'moved-aside':
        console.log(`✓ ${result.message ?? `Moved the edited file to ${result.backupPath}.`}`);
        break;
      case 'block-removed':
        console.log(`✓ Removed NorthKeep's contract block from ${result.path}.`);
        break;
      case 'absent':
        console.log(`${TARGET_LABEL[target]} had no session contract. Nothing to remove.`);
        break;
      case 'refused':
        fail(result.message ?? `Could not remove ${result.path}.`);
        break;
      default: {
        const _exhaustive: never = result.action;
        throw new Error(`Unhandled uninstall action: ${String(_exhaustive)}`);
      }
    }
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

export function contractStatusCmd(options: { project?: string }): void {
  console.log('NorthKeep contract status');
  for (const row of contractStatusAll({ projectDir: options.project })) {
    const label = TARGET_LABEL[row.target].padEnd(22);
    const extra = row.message ? `  ${row.message}` : '';
    console.log(`  ${label} ${row.status.padEnd(10)}  ${row.path}${extra}`);
  }
  if (!options.project) {
    console.log('  Cursor (this project)  (pass --project <dir> to check a project rule)');
  }
  console.log('');
  console.log(GAPS);
}

export function contractPrintCmd(): void {
  process.stdout.write(CONTRACT_TEXT.endsWith('\n') ? CONTRACT_TEXT : `${CONTRACT_TEXT}\n`);
}
