import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { generateDeviceSecret, KDF_INTERACTIVE, Vault } from '@northkeep/core';
import { applyReviewAction, assembleReviewReport, loadReviewReport, proposalFingerprint, reconcileReviewOperations, restoreReviewOperation, saveReviewReport } from '../src/index.js';
const passphrase = 'synthetic review passphrase';
const previousHome = process.env.NORTHKEEP_HOME;
describe('durable review sessions', () => {
    let dir = '';
    let vaultPath = '';
    let secret: Buffer;
    afterEach(() => {
        if (previousHome === undefined) delete process.env.NORTHKEEP_HOME;
        else process.env.NORTHKEEP_HOME = previousHome;
        if (dir)
            fs.rmSync(dir, {
                recursive: true, force: true
            });
    });
    function create() {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-review-session-'));
        process.env.NORTHKEEP_HOME = dir;
        vaultPath = path.join(dir, 'vault.nkv');
        secret = generateDeviceSecret();
        return Vault.create({
            path: vaultPath, passphrase, deviceSecret: secret, kdf: KDF_INTERACTIVE
        });
    }
    function open() {
        return Vault.open({
            path: vaultPath, passphrase, deviceSecret: secret
        });
    }
    function report(vault: Vault, entries = vault.list()) {
        const proposal = {
            id: 'aabbccdd', kind: 'stale' as const, entry_ids: [entries[0]!.id], quotes: [{
                    entry_id: entries[0]!.id, quote: entries[0]!.content
                }], explanation: 'synthetic correction', target_entry_id: entries[0]!.id, proposed_content: 'Corrected synthetic fact.', status: 'pending' as const
        };
        return assembleReviewReport({
            model: 'fixture', started_at: new Date().toISOString(), entry_count: entries.length, drops: {}, proposals: [proposal], vault_id: vault.getVaultId(), vault_path: vaultPath, selected_scopes: ['personal'], source_entries: entries
        });
    }
    it('records prepared before save and safely retries after a failed save', () => {
        let vault = create();
        const entry = vault.remember({
            content: 'Original synthetic fact.', type: 'semantic'
        });
        vault.save();
        const r = report(vault, [entry]);
        saveReviewReport(r, vaultPath);
        const request = {
            report_id: r.report_id, proposal_fingerprint: proposalFingerprint(r.proposals[0]!), operation_id: randomUUID(), content: 'Corrected synthetic fact.'
        };
        vault.save = () => {
            throw new Error('injected save failure');
        };
        expect(() => applyReviewAction(vault, r, vaultPath, vault.getVaultId(), 'aabbccdd', 'accept', request)).toThrow(/injected/);
        vault.close();
        vault = open();
        const loaded = loadReviewReport(vaultPath);
        expect(loaded?.schema).toBe('northkeep-review-report/2');
        if (!loaded || loaded.schema !== 'northkeep-review-report/2')
            throw new Error('missing report');
        reconcileReviewOperations(vault, loaded, vaultPath);
        expect(loaded.operations[0]!.status).toBe('aborted');
        const receipt = applyReviewAction(vault, loaded, vaultPath, vault.getVaultId(), 'aabbccdd', 'accept', request);
        expect(receipt.status).toBe('committed');
        expect(vault.list()[0]!.content).toBe('Corrected synthetic fact.');
        expect(() => applyReviewAction(vault, loaded, vaultPath, vault.getVaultId(), 'aabbccdd', 'accept', {
            ...request, content: 'Changed retry'
        })).toThrow(/different request/);
        vault.close();
    });
    it('restores an accepted edit by supersession and makes retry idempotent', () => {
        const vault = create();
        const entry = vault.remember({
            content: 'Original synthetic fact.', type: 'semantic'
        });
        vault.save();
        const r = report(vault, [entry]);
        const action = {
            report_id: r.report_id, proposal_fingerprint: proposalFingerprint(r.proposals[0]!), operation_id: randomUUID(), content: 'Corrected synthetic fact.'
        };
        const applied = applyReviewAction(vault, r, vaultPath, vault.getVaultId(), 'aabbccdd', 'accept', action);
        const head = applied.after.find(e => e.id !== entry.id)!;
        const request = {
            report_id: r.report_id, operation_id: randomUUID(), receipt_id: applied.receipt_id, expected_head_id: head.id, expected_content: head.content
        };
        const restored = restoreReviewOperation(vault, r, vaultPath, vault.getVaultId(), request);
        expect(restored.status).toBe('committed');
        expect(vault.list()[0]!.content).toBe(entry.content);
        expect(restoreReviewOperation(vault, r, vaultPath, vault.getVaultId(), request).receipt_id).toBe(restored.receipt_id);
        expect(() => restoreReviewOperation(vault, r, vaultPath, vault.getVaultId(), {
            ...request, operation_id: randomUUID()
        })).toThrow(/already been restored/);
        vault.close();
    });
    it('reconciles a vault save whose final report commit was interrupted', () => {
        let vault = create();
        const entry = vault.remember({
            content: 'Original synthetic fact.', type: 'semantic'
        });
        vault.save();
        const r = report(vault, [entry]);
        const request = {
            report_id: r.report_id, proposal_fingerprint: proposalFingerprint(r.proposals[0]!), operation_id: randomUUID(), content: 'Corrected synthetic fact.'
        };
        const receipt = applyReviewAction(vault, r, vaultPath, vault.getVaultId(), 'aabbccdd', 'accept', request);
        receipt.status = 'prepared';
        delete receipt.committed_at;
        saveReviewReport(r, vaultPath);
        vault.close();
        vault = open();
        const loaded = loadReviewReport(vaultPath);
        if (!loaded || loaded.schema !== 'northkeep-review-report/2')
            throw new Error('missing report');
        reconcileReviewOperations(vault, loaded, vaultPath);
        expect(loaded.operations[0]!.status).toBe('committed');
        expect(vault.list()[0]!.content).toBe('Corrected synthetic fact.');
        vault.close();
    });
    it('retries a restore after its vault save fails', () => {
        let vault = create();
        const entry = vault.remember({
            content: 'Original synthetic fact.', type: 'semantic'
        });
        vault.save();
        const r = report(vault, [entry]);
        const applied = applyReviewAction(vault, r, vaultPath, vault.getVaultId(), 'aabbccdd', 'accept', {
            report_id: r.report_id, proposal_fingerprint: proposalFingerprint(r.proposals[0]!), operation_id: randomUUID(), content: 'Corrected synthetic fact.'
        });
        const head = applied.after.find(e => e.id !== entry.id)!;
        const request = {
            report_id: r.report_id, operation_id: randomUUID(), receipt_id: applied.receipt_id, expected_head_id: head.id, expected_content: head.content
        };
        vault.save = () => {
            throw new Error('injected restore save failure');
        };
        expect(() => restoreReviewOperation(vault, r, vaultPath, vault.getVaultId(), request)).toThrow(/injected/);
        vault.close();
        vault = open();
        const loaded = loadReviewReport(vaultPath);
        if (!loaded || loaded.schema !== 'northkeep-review-report/2')
            throw new Error('missing report');
        reconcileReviewOperations(vault, loaded, vaultPath);
        expect(restoreReviewOperation(vault, loaded, vaultPath, vault.getVaultId(), request).status).toBe('committed');
        expect(vault.list()[0]!.content).toBe(entry.content);
        vault.close();
    });
    it('refuses malformed workflow state and a report bound to another vault path', () => {
        const vault = create();
        const entry = vault.remember({
            content: 'Original synthetic fact.', type: 'semantic'
        });
        vault.save();
        const r = report(vault, [entry]);
        saveReviewReport(r, vaultPath);
        const raw = fs.readFileSync(path.join(dir, fs.readdirSync(dir).find(name => name.startsWith('review-report-'))!), 'utf8');
        fs.writeFileSync(path.join(dir, fs.readdirSync(dir).find(name => name.startsWith('review-report-'))!), raw.replace('"operations": []', '"operations": [{}]'));
        expect(() => loadReviewReport(vaultPath)).toThrow(/strict validation/);
        expect(() => reconcileReviewOperations(vault, {
            ...r, vault_id: randomUUID()
        }, vaultPath)).toThrow(/different vault/);
        expect(() => applyReviewAction(vault, {
            ...r, vault_id: randomUUID()
        }, vaultPath, vault.getVaultId(), 'aabbccdd', 'accept', {
            report_id: r.report_id, proposal_fingerprint: proposalFingerprint(r.proposals[0]!), operation_id: randomUUID(), content: 'Changed'
        })).toThrow(/different vault/);
        vault.close();
    });
});
