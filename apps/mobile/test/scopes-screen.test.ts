import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { applySyncOutcome, newlySharedMessage, type ConnectorFailure } from '../src/lib/connect-flow.js';

const screenPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'app', 'sharing', 'scopes.tsx');
const source = ts.createSourceFile(screenPath, fs.readFileSync(screenPath, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function find<T extends ts.Node>(pred: (n: ts.Node) => n is T): T[] {
  const out: T[] = [];
  const visit = (n: ts.Node): void => {
    if (pred(n)) out.push(n);
    n.forEachChild(visit);
  };
  visit(source);
  return out;
}

function syncButtonDisabled(): ts.Expression {
  const buttons = find((n): n is ts.JsxSelfClosingElement => ts.isJsxSelfClosingElement(n) && n.tagName.getText() === 'Button');
  const sync = buttons.find((b) =>
    b.attributes.properties.some(
      (a) => ts.isJsxAttribute(a) && a.name.getText() === 'title' && a.initializer?.getText() === '"Sync app-written memories"',
    ),
  );
  expect(sync).toBeDefined();
  const disabled = sync!.attributes.properties.find((a) => ts.isJsxAttribute(a) && a.name.getText() === 'disabled') as ts.JsxAttribute;
  const init = disabled.initializer as ts.JsxExpression;
  return init.expression!;
}

describe('Sharing screen: Sync button wiring (ADR 0050)', () => {
  it('gates the button with canSyncNow on the shared count and the loaded pairing', () => {
    const calls: ts.CallExpression[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && n.expression.getText() === 'canSyncNow') calls.push(n);
      n.forEachChild(visit);
    };
    visit(syncButtonDisabled());
    expect(calls).toHaveLength(1);
    const arg = calls[0]!.arguments[0] as ts.ObjectLiteralExpression;
    const props = new Map(arg.properties.map((p) => [p.name?.getText(), p.getText()]));
    expect(props.get('sharedCount')).toBe('sharedCount: sharedScopes.length');
    expect(props.get('paired')).toBe('paired');
  });

  it('loads the pairing into the paired state on mount', () => {
    const setPairedCalls = find((n): n is ts.CallExpression => ts.isCallExpression(n) && n.expression.getText() === 'setPaired');
    expect(setPairedCalls.some((c) => c.arguments[0]!.getText().includes('loadConnectorPairedAt()'))).toBe(true);
  });

  it('hands every sync outcome to applySyncOutcome with a store re-read', () => {
    const apply = find((n): n is ts.CallExpression => ts.isCallExpression(n) && n.expression.getText() === 'applySyncOutcome');
    expect(apply).toHaveLength(1);
    const view = apply[0]!.arguments[1] as ts.ObjectLiteralExpression;
    const props = new Map(view.properties.map((p) => [p.name?.getText(), p.getText()]));
    expect(props.get('reloadShared')).toBe('reloadShared: () => store.load()');
    expect(props.has('setSharedScopes')).toBe(true);
  });
});

describe('applySyncOutcome', () => {
  function view(reloaded: string[]) {
    const state = { shared: null as string[] | null, result: null as string | null, error: null as ConnectorFailure | null };
    return {
      state,
      view: {
        reloadShared: async () => reloaded,
        setSharedScopes: (s: string[]) => { state.shared = s; },
        setSyncResult: (t: string | null) => { state.result = t; },
        setSyncError: (f: ConnectorFailure | null) => { state.error = f; },
      },
    };
  }
  const counts = { added: 1, forgotten: 0, deduped: 0, held: 0, held_scopes: [] as string[] };

  it('re-reads the shared list after a sync so a newly marked project shows as Shared', async () => {
    const v = view(['project:hosted-thing']);
    await applySyncOutcome({ kind: 'synced', ...counts, pushed: 1, newlyShared: ['project:hosted-thing'] }, v.view);
    expect(v.state.shared).toEqual(['project:hosted-thing']);
    expect(v.state.result).toContain(newlySharedMessage('project:hosted-thing'));
  });

  it('re-reads after a partial sync and after a skipped push too', async () => {
    const a = view(['x']);
    await applySyncOutcome(
      { kind: 'partially-synced', ...counts, newlyShared: [], pushFailure: { kind: 'network', message: 'offline', retryable: true } as never },
      a.view,
    );
    expect(a.state.shared).toEqual(['x']);
    expect(a.state.error?.message).toContain('offline');
    const b = view([]);
    await applySyncOutcome({ kind: 'synced-no-push', reason: 'nothing-shared', ...counts }, b.view);
    expect(b.state.shared).toEqual([]);
  });

  it('does not touch the list when the sync never reached the server', async () => {
    const v = view(['should-not-load']);
    await applySyncOutcome({ kind: 'nothing-shared', message: 'No scopes are shared yet.' }, v.view);
    expect(v.state.shared).toBeNull();
    expect(v.state.result).toBe('No scopes are shared yet.');
  });
});
