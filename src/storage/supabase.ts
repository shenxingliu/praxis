/// <reference types="vite/client" />
import { StorageProvider } from './provider';
import {
    Asset, Reference, Element, KnowledgeRule, GenerationResult, FeedbackSignal,
    PraxisJob, BudgetConfig, SpendRecord,
} from '../domain/types';
import { getCurrentBrandId } from '../domain/brand';

/**
 * SupabaseProvider — cloud persistence over PostgREST. No SDK dependency:
 * the table shape is uniform ({id, data jsonb} / kv{key, value jsonb}) so
 * plain fetch covers everything.
 *
 * Praxis uses its OWN praxis_* tables. Legacy tables may exist in the same
 * Supabase project; they are never touched except by the explicit one-way
 * import in the System page.
 *
 * Brand scoping: reads filter server-side on data->>brandId.
 *
 * Security note: open RLS policies (single-user phase). Before any team
 * rollout this switches to Supabase Auth + per-user policies.
 */

const TABLE = {
    assets: 'praxis_assets',
    references: 'praxis_refs',
    elements: 'praxis_elements',
    rules: 'praxis_rules',
    results: 'praxis_results',
    signals: 'praxis_signals',
    jobs: 'praxis_jobs',
    spend: 'praxis_spend',
    kv: 'praxis_kv',
} as const;

/** Upsert in chunks — asset rows carry base64 photos (~1MB each). */
const CHUNK = 3;

export class SupabaseProvider implements StorageProvider {
    constructor(private url: string, private key: string) {}

    private headers(extra: Record<string, string> = {}): Record<string, string> {
        return {
            apikey: this.key,
            Authorization: `Bearer ${this.key}`,
            'content-type': 'application/json',
            ...extra,
        };
    }

    private async rows<T>(table: string, query = ''): Promise<T[]> {
        const resp = await fetch(`${this.url}/rest/v1/${table}?select=data${query}`, {
            headers: this.headers(),
        });
        if (!resp.ok) throw new Error(`Supabase ${table} read ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
        const raw: Array<{ data: T }> = await resp.json();
        return raw.map(r => r.data);
    }

    /** Rows of the ACTIVE brand only (server-side jsonb filter). */
    private brandRows<T>(table: string, query = ''): Promise<T[]> {
        const bid = encodeURIComponent(getCurrentBrandId());
        return this.rows<T>(table, `&data->>brandId=eq.${bid}${query}`);
    }

    private async upsert(table: string, entries: Array<{ id: string; data: unknown }>): Promise<void> {
        for (let i = 0; i < entries.length; i += CHUNK) {
            const chunk = entries.slice(i, i + CHUNK);
            const resp = await fetch(`${this.url}/rest/v1/${table}?on_conflict=id`, {
                method: 'POST',
                headers: this.headers({ Prefer: 'resolution=merge-duplicates' }),
                body: JSON.stringify(chunk.map(e => ({ id: e.id, data: e.data, updated_at: new Date().toISOString() }))),
            });
            if (!resp.ok) throw new Error(`Supabase ${table} write ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
        }
    }

    private async remove(table: string, id: string): Promise<void> {
        const resp = await fetch(`${this.url}/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`, {
            method: 'DELETE',
            headers: this.headers(),
        });
        if (!resp.ok) throw new Error(`Supabase ${table} delete ${resp.status}`);
    }

    // ---- Assets ----
    async listAssets(): Promise<Asset[]> {
        const all = await this.brandRows<Asset>(TABLE.assets);
        return all.sort((a, b) => b.updatedAt - a.updatedAt);
    }
    upsertAsset(asset: Asset) { return this.upsert(TABLE.assets, [{ id: asset.id, data: asset }]); }
    deleteAsset(id: string) { return this.remove(TABLE.assets, id); }

    // ---- References ----
    async listReferences(kind?: Reference['kind']): Promise<Reference[]> {
        const all = await this.brandRows<Reference>(TABLE.references);
        const filtered = kind ? all.filter(r => r.kind === kind) : all;
        return filtered.sort((a, b) => b.weight - a.weight);
    }
    upsertReference(ref: Reference) { return this.upsert(TABLE.references, [{ id: ref.id, data: ref }]); }
    deleteReference(id: string) { return this.remove(TABLE.references, id); }

    // ---- Elements ----
    async listElements(type?: Element['type']): Promise<Element[]> {
        const all = await this.brandRows<Element>(TABLE.elements);
        const filtered = type ? all.filter(e => e.type === type) : all;
        return filtered.sort((a, b) => b.weight - a.weight);
    }
    upsertElement(element: Element) { return this.upsert(TABLE.elements, [{ id: element.id, data: element }]); }
    deleteElement(id: string) { return this.remove(TABLE.elements, id); }

    // ---- Knowledge ----
    async listRules(): Promise<KnowledgeRule[]> {
        const all = await this.brandRows<KnowledgeRule>(TABLE.rules);
        return all.sort((a, b) => b.confidence - a.confidence);
    }
    upsertRule(rule: KnowledgeRule) { return this.upsert(TABLE.rules, [{ id: rule.id, data: rule }]); }
    deleteRule(id: string) { return this.remove(TABLE.rules, id); }

    // ---- Results + signals ----
    async listResults(limit = 200): Promise<GenerationResult[]> {
        return this.brandRows<GenerationResult>(TABLE.results, `&order=updated_at.desc&limit=${limit}`);
    }
    async getResult(id: string): Promise<GenerationResult | null> {
        const rows = await this.rows<GenerationResult>(TABLE.results, `&id=eq.${encodeURIComponent(id)}`);
        return rows[0] ?? null;
    }
    upsertResult(result: GenerationResult) { return this.upsert(TABLE.results, [{ id: result.id, data: result }]); }
    deleteResult(id: string) { return this.remove(TABLE.results, id); }

    async listSignals(onlyUndistilled = false): Promise<FeedbackSignal[]> {
        const all = await this.brandRows<FeedbackSignal>(TABLE.signals);
        return onlyUndistilled ? all.filter(s => !s.distilled) : all;
    }
    addSignal(signal: FeedbackSignal) { return this.upsert(TABLE.signals, [{ id: signal.id, data: signal }]); }
    async markSignalsDistilled(ids: string[]): Promise<void> {
        const all = await this.listSignals();
        const updates = all
            .filter(s => ids.includes(s.id) && !s.distilled)
            .map(s => ({ id: s.id, data: { ...s, distilled: true } }));
        if (updates.length > 0) await this.upsert(TABLE.signals, updates);
    }

    // ---- Jobs ----
    async listJobs(limit = 50): Promise<PraxisJob[]> {
        return this.brandRows<PraxisJob>(TABLE.jobs, `&order=updated_at.desc&limit=${limit}`);
    }
    upsertJob(job: PraxisJob) { return this.upsert(TABLE.jobs, [{ id: job.id, data: job }]); }

    // ---- kv ----
    async kvGet<T>(key: string): Promise<T | null> {
        const resp = await fetch(`${this.url}/rest/v1/${TABLE.kv}?select=value&key=eq.${encodeURIComponent(key)}`, {
            headers: this.headers(),
        });
        if (!resp.ok) return null;
        const rows: Array<{ value: T }> = await resp.json();
        return rows[0]?.value ?? null;
    }
    async kvSet(key: string, value: unknown): Promise<void> {
        const resp = await fetch(`${this.url}/rest/v1/${TABLE.kv}?on_conflict=key`, {
            method: 'POST',
            headers: this.headers({ Prefer: 'resolution=merge-duplicates' }),
            body: JSON.stringify([{ key, value, updated_at: new Date().toISOString() }]),
        });
        if (!resp.ok) throw new Error(`Supabase kv write ${resp.status}`);
    }

    // ---- Budget (global) ----
    async getBudget(): Promise<BudgetConfig> {
        return (await this.kvGet<BudgetConfig>('budget')) ?? { monthlyUsd: 50, warnAtFraction: 0.8 };
    }
    setBudget(config: BudgetConfig) { return this.kvSet('budget', config); }
    addSpend(record: SpendRecord) { return this.upsert(TABLE.spend, [{ id: record.id, data: record }]); }
    async getMonthSpend(month: string): Promise<number> {
        const all = await this.rows<SpendRecord>(TABLE.spend);
        return all.filter(r => r.month === month).reduce((sum, r) => sum + r.usd, 0);
    }

    // ---- Bulk import ----
    async importBulk(data: Parameters<StorageProvider['importBulk']>[0]): Promise<void> {
        const bid = getCurrentBrandId();
        const withBrand = <T extends { id: string; brandId?: string }>(xs?: T[]) =>
            (xs ?? []).map(x => ({ id: x.id, data: { ...x, brandId: x.brandId ?? bid } }));
        if (data.assets?.length) await this.upsert(TABLE.assets, withBrand(data.assets));
        if (data.references?.length) await this.upsert(TABLE.references, withBrand(data.references));
        if (data.elements?.length) await this.upsert(TABLE.elements, withBrand(data.elements));
        if (data.rules?.length) await this.upsert(TABLE.rules, withBrand(data.rules));
        if (data.results?.length) await this.upsert(TABLE.results, withBrand(data.results));
        if (data.signals?.length) await this.upsert(TABLE.signals, withBrand(data.signals));
    }

    // ---- One-way import from legacy tables (same project) ----
    /** Reads legacy tables directly. Used only by the optional System import.
     *  Never writes to them. */
    async readLegacyTable<T>(table: 'assets' | 'refs' | 'kv', query = ''): Promise<T[]> {
        const select = table === 'kv' ? 'key,value' : 'id,data';
        const resp = await fetch(`${this.url}/rest/v1/${table}?select=${select}${query}`, {
            headers: this.headers(),
        });
        if (!resp.ok) throw new Error(`Legacy ${table} read ${resp.status}`);
        return resp.json();
    }
}
