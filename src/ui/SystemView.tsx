import React, { useEffect, useRef, useState } from 'react';
import { storage, isCloud, LocalProvider } from '../storage/local';
import { SupabaseProvider } from '../storage/supabase';
import { Asset, BudgetConfig, Reference } from '../domain/types';
import { INVENTORY_CHANGED_EVENT } from './events';
import { S } from './styles';

/** System — stores overview, budget, and optional legacy data import. */
export default function SystemView() {
    const [counts, setCounts] = useState({ assets: 0, references: 0, rules: 0, results: 0, signals: 0 });
    const [budget, setBudgetState] = useState<BudgetConfig>({ monthlyUsd: 50, warnAtFraction: 0.8 });
    const [spent, setSpent] = useState(0);
    const [importLog, setImportLog] = useState('');
    const fileRef = useRef<HTMLInputElement>(null);

    const refresh = async () => {
        const [assets, references, rules, results, signals, b] = await Promise.all([
            storage.listAssets(), storage.listReferences(), storage.listRules(),
            storage.listResults(), storage.listSignals(), storage.getBudget(),
        ]);
        setCounts({ assets: assets.length, references: references.length, rules: rules.length, results: results.length, signals: signals.length });
        setBudgetState(b);
        setSpent(await storage.getMonthSpend(new Date().toISOString().slice(0, 7)));
    };
    useEffect(() => { refresh(); }, []);

    const importFiles = async (files: FileList | null) => {
        if (!files) return;
        const bulk: Record<string, unknown> = {};
        for (const f of Array.from(files)) {
            const json = JSON.parse(await f.text());
            if (f.name.startsWith('assets')) bulk.assets = json;
            else if (f.name.startsWith('references')) bulk.references = json;
            else if (f.name.startsWith('signals')) bulk.signals = json;
        }

        // Cleanup: remove rows from older migration snapshots (pre-deterministic
        // ids) so re-imports refresh instead of duplicating. Learned rules,
        // generation results and promoted references are never touched.
        if (bulk.assets) {
            for (const a of await storage.listAssets()) {
                if (a.v1Id && !a.id.startsWith('v1a:')) await storage.deleteAsset(a.id);
            }
        }
        if (bulk.references) {
            for (const r of await storage.listReferences()) {
                const fromV1 = r.kind === 'material' || (r.tags ?? []).includes('v1-plate');
                if (fromV1 && !r.id.startsWith('v1')) await storage.deleteReference(r.id);
            }
        }

        await storage.importBulk(bulk as never);
        setImportLog(`Imported: ${Object.keys(bulk).join(', ')}`);
        window.dispatchEvent(new CustomEvent(INVENTORY_CHANGED_EVENT));
        refresh();
    };

    const saveBudget = async (usd: number) => {
        const next = { ...budget, monthlyUsd: usd };
        setBudgetState(next);
        await storage.setBudget(next);
    };

    /** One-click legacy import: old cloud tables may already hold compatible
     *  assets/references — read them, stamp the active brandId, write into
     *  praxis_* tables. */
    const importFromV13Cloud = async () => {
        if (!isCloud || !(storage instanceof SupabaseProvider)) return;
        setImportLog('Importing from legacy cloud tables...');
        try {
            const [assetRows, refRows] = await Promise.all([
                storage.readLegacyTable<{ id: string; data: Asset }>('assets'),
                storage.readLegacyTable<{ id: string; data: Reference }>('refs'),
            ]);
            const assets = assetRows.map(r => r.data).filter(a => a?.name && Array.isArray(a.photos));
            const references = refRows.map(r => r.data).filter(r => r?.image?.value);
            await storage.importBulk({ assets, references });
            setImportLog(`Imported ${assets.length} heroes + ${references.length} references from legacy cloud tables`);
            window.dispatchEvent(new CustomEvent(INVENTORY_CHANGED_EVENT));
        } catch (err: any) {
            setImportLog(`Import failed: ${err?.message || err}`);
        }
        refresh();
    };

    const uploadLocalToCloud = async () => {
        if (!isCloud) return;
        setImportLog('Uploading local data to cloud…');
        try {
            const local = new LocalProvider();
            const [assets, references, rules, results, signals, budget] = await Promise.all([
                local.listAssets(), local.listReferences(), local.listRules(),
                local.listResults(1000), local.listSignals(), local.getBudget(),
            ]);
            await storage.importBulk({ assets, references, rules, results, signals });
            await storage.setBudget(budget);
            setImportLog(`Uploaded: ${assets.length} assets, ${references.length} refs, ${rules.length} rules, ${results.length} results, ${signals.length} signals`);
        } catch (err: any) {
            setImportLog(`Upload failed: ${err?.message || err}`);
        }
        refresh();
    };

    return (
        <div style={{ maxWidth: 720, margin: '0 auto', padding: '24px 28px' }}>
            <p style={{ fontSize: 12, color: isCloud ? '#059669' : '#a1a1aa' }}>
                Storage: {isCloud ? 'Supabase cloud' : 'local IndexedDB (offline mode)'}
            </p>
            <h2 style={{ fontSize: 16 }}>Stores</h2>
            <table style={{ fontSize: 14, borderSpacing: '1.5rem 0.25rem' }}>
                <tbody>
                    <tr><td>Assets (hero truth)</td><td><strong>{counts.assets}</strong></td></tr>
                    <tr><td>References (aesthetics)</td><td><strong>{counts.references}</strong></td></tr>
                    <tr><td>Knowledge rules</td><td><strong>{counts.rules}</strong></td></tr>
                    <tr><td>Results</td><td><strong>{counts.results}</strong></td></tr>
                    <tr><td>Feedback signals</td><td><strong>{counts.signals}</strong></td></tr>
                </tbody>
            </table>

            <h2 style={{ fontSize: 16, marginTop: 24 }}>Budget</h2>
            <p style={{ fontSize: 14 }}>
                Monthly limit $
                <input type="number" value={budget.monthlyUsd} onChange={e => saveBudget(Number(e.target.value))} style={{ ...S.input, width: 80, margin: '0 6px' }} />
                · spent this month: <strong>${spent.toFixed(2)}</strong>
            </p>

            <h2 style={{ fontSize: 16, marginTop: 24 }}>Data</h2>
            {isCloud && (
                <button style={{ ...S.btn, marginRight: 8 }} onClick={importFromV13Cloud}>
                    Import legacy cloud data
                </button>
            )}
            {isCloud && (
                <button style={{ ...S.btnGhost, marginRight: 8 }} onClick={uploadLocalToCloud}>
                    Upload local data → cloud (one-time)
                </button>
            )}
            <button style={S.btnGhost} onClick={() => fileRef.current?.click()}>Import legacy data (migration-out/*.json)</button>
            <input ref={fileRef} type="file" multiple accept=".json" style={{ display: 'none' }} onChange={e => importFiles(e.target.files)} />
            {importLog && <p style={{ fontSize: 13, color: '#059669' }}>{importLog}</p>}
        </div>
    );
}
