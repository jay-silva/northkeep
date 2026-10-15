import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// platform-mobile compiles against hand-written Expo declarations (rn-modules.d.ts)
// because it cannot depend on Expo. Those drifted once: SDK 57 made File.move
// async while the copy still said void. This checks the copy against the real
// packages this app installs.

const appDir = join(__dirname, '..');
const shimPath = join(appDir, '../../packages/platform-mobile/src/rn-modules.d.ts');
const MODULES = ['expo-file-system', 'expo-sqlite', 'expo-secure-store'];

interface Shimmed {
  module: string;
  body: string;
  types: string[];
  functions: string[];
  values: string[];
}

/** The body and exported names of each shimmed module, read from the shim. */
function readShim(text: string): Shimmed[] {
  const file = ts.createSourceFile(shimPath, text, ts.ScriptTarget.Latest, true);
  const out: Shimmed[] = [];
  for (const stmt of file.statements) {
    if (!ts.isModuleDeclaration(stmt) || !ts.isStringLiteral(stmt.name) || !MODULES.includes(stmt.name.text)) continue;
    const block = stmt.body as ts.ModuleBlock;
    const entry: Shimmed = { module: stmt.name.text, body: text.slice(block.getStart() + 1, block.getEnd() - 1), types: [], functions: [], values: [] };
    for (const s of block.statements) {
      if ((ts.isClassDeclaration(s) || ts.isInterfaceDeclaration(s)) && s.name) {
        const args = s.typeParameters ? `<${s.typeParameters.map(() => 'unknown').join(', ')}>` : '';
        entry.types.push(s.name.text + args);
      }
      else if (ts.isFunctionDeclaration(s) && s.name) entry.functions.push(s.name.text);
      else if (ts.isVariableStatement(s)) {
        for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name)) entry.values.push(d.name.text);
      }
    }
    out.push(entry);
  }
  return out;
}

/**
 * Every shim member must exist on the real export, and what the real one
 * returns must fit what the shim promises: a real Promise never fits a shim
 * `void`. Parameters are not compared.
 */
function contractSource(shims: Shimmed[]): string {
  const lines = [
    'type Fits<R, S> = [R] extends [S] ? true : false;',
    'type Drift<S, R> = { [K in keyof S]-?: K extends keyof R',
    '  ? S[K] extends (...a: never[]) => infer SR',
    '    ? R[K] extends (...a: never[]) => infer RR ? (Fits<RR, SR> extends true ? never : K) : K',
    '    : Fits<R[K], S[K]> extends true ? never : K',
    '  : K }[keyof S];',
    'type Clean<D> = [D] extends [never] ? true : { drifted: D };',
  ];
  shims.forEach((s, i) => {
    lines.unshift(`import type * as Real${i} from '${s.module}';`);
    lines.push(`declare namespace Shim${i} {${s.body}}`);
    for (const t of s.types) {
      lines.push(`export const ${t.replace(/<.*/, '')}_${i}: Clean<Drift<Shim${i}.${t}, Real${i}.${t}>> = true;`);
    }
    for (const f of s.functions) {
      lines.push(`export const ${f}_${i}: Fits<ReturnType<typeof Real${i}.${f}>, ReturnType<typeof Shim${i}.${f}>> = true;`);
    }
    for (const v of s.values) {
      lines.push(`export const ${v}_${i}: Clean<Drift<{ ${v}: typeof Shim${i}.${v} }, { ${v}: typeof Real${i}.${v} }>> = true;`);
    }
  });
  return lines.join('\n');
}

/** Type errors in the generated contract, compiled where the real Expo packages resolve. */
function compile(source: string): string[] {
  const configPath = join(appDir, 'tsconfig.json');
  const config = ts.getParsedCommandLineOfConfigFile(configPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
  if (!config) throw new Error('could not read apps/mobile/tsconfig.json');
  const virtualPath = join(appDir, 'test', '__expo-contract__.ts');
  const host = ts.createCompilerHost(config.options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, lang, ...rest) =>
    name === virtualPath ? ts.createSourceFile(name, source, lang) : getSourceFile(name, lang, ...rest);
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (name) => name === virtualPath || fileExists(name);
  const program = ts.createProgram([virtualPath], { ...config.options, noEmit: true }, host);
  return ts
    .getPreEmitDiagnostics(program, program.getSourceFile(virtualPath))
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

describe('hand-written Expo types match the installed Expo packages', () => {
  const shims = readShim(readFileSync(shimPath, 'utf8'));

  it('covers every shimmed Expo module', () => {
    expect(shims.map((s) => s.module).sort()).toEqual([...MODULES].sort());
  });

  it('agrees with the real declarations', () => {
    expect(compile(contractSource(shims))).toEqual([]);
  }, 60_000);

  it('catches a method the shim calls synchronous when Expo made it async', () => {
    const broken = shims.map((s) => ({ ...s, body: s.body.replace(/move\(destination: File\): Promise<void>;/, 'move(destination: File): void;') }));
    expect(broken.find((s) => s.module === 'expo-file-system')!.body).toContain('move(destination: File): void;');
    expect(compile(contractSource(broken)).join('\n')).toMatch(/drifted: [^}]*"move"/);
  }, 60_000);
});
