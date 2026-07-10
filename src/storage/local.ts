import { StorageProvider } from './provider';
import {
    Asset, Reference, Element, KnowledgeRule, GenerationResult, FeedbackSignal,
    PraxisJob, BudgetConfig, SpendRecord,
} from '../domain/types';
import { getCurrentBrandId } from '../domain/brand';

/**
 * LocalProvider — IndexedDB implementation for offline dev.
 * One object store per entity, key = id. Brand filtering happens on read.
 */

const DB_NAME = 'praxis';
const DB_VERSION = 1;
const STORES = ['assets', 'references', 'elements', 'rules', 'results', 'signals', 'jobs', 'spend', 'kv'] as const;

const openDb = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            for (const name of STORES) {
                if (!db.objectStoreNames.contains(name)) {
                    db.createObjectStore(name, { keyPath: name === 'kv' ? 'key' : 'id' });
                }
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });

const tx = async <T>(
    store: (typeof STORES)[number],
    mode: IDBTransactionMode,
    fn: (s: IDBObjectStore) => IDBRequest | void
): Promise<T> => {
    const db = await openDb();
    return new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        const req = fn(s);
        t.oncomplete = () => resolve((req as IDBRequest | undefined)?.result as T);
        t.onerror = () => reject(t.error);
    });
};

const getAll = <T>(store: (typeof STORES)[number]): Promise<T[]> =>
    tx<T[]>(store, 'readonly', s => s.getAll());

const put = (store: (typeof STORES)[number], value: unknown): Promise<void> =>
    tx<void>(store, 'readwrite', s => { s.put(value); });

const del = (store: (typeof STORES)[number], id: string): Promise<void> =>
    tx<void>(store, 'readwrite', s => { s.delete(id); });

/** Read all rows of the ACTIVE brand. */
const getBrand = async <T extends { brandId: string }>(store: (typeof STORES)[number]): Promise<T[]> => {
    const all = await getAll<T>(store);
    const bid = getCurrentBrandId();
    return all.filter(x => x.brandId === bid);
};

export class LocalProvider implements StorageProvider {
    async listAssets(): Promise<Asset[]> {
        const all = await getBrand<Asset>('assets');
        return all.sort((a, b) => b.updatedAt - a.updatedAt);
    }
    upsertAsset(asset: Asset) { return put('assets', asset); }
    deleteAsset(id: string) { return del('assets', id); }

    async listReferences(kind?: Reference['kind']): Promise<Reference[]> {
        const all = await getBrand<Reference>('references');
        const filtered = kind ? all.filter(r => r.kind === kind) : all;
        return filtered.sort((a, b) => b.weight - a.weight);
    }
    upsertReference(ref: Reference) { return put('references', ref); }
    deleteReference(id: string) { return del('references', id); }

    async listElements(type?: Element['type']): Promise<Element[]> {
        const all = await getBrand<Element>('elements');
        const filtered = type ? all.filter(e => e.type === type) : all;
        return filtered.sort((a, b) => b.weight - a.weight);
    }
    upsertElement(element: Element) { return put('elements', element); }
    deleteElement(id: string) { return del('elements', id); }

    async listRules(): Promise<KnowledgeRule[]> {
        const all = await getBrand<KnowledgeRule>('rules');
        return all.sort((a, b) => b.confidence - a.confidence);
    }
    upsertRule(rule: KnowledgeRule) { return put('rules', rule); }
    deleteRule(id: string) { return del('rules', id); }

    async listResults(limit = 200): Promise<GenerationResult[]> {
        const all = await getBrand<GenerationResult>('results');
        return all.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
    }
    async getResult(id: string): Promise<GenerationResult | null> {
        const result = (await tx<GenerationResult | undefined>('results', 'readonly', s => s.get(id))) ?? null;
        // Brand-scoped like every other read — an id must not cross brands.
        return result && result.brandId === getCurrentBrandId() ? result : null;
    }
    upsertResult(result: GenerationResult) { return put('results', result); }
    deleteResult(id: string) { return del('results', id); }

    async listSignals(onlyUndistilled = false): Promise<FeedbackSignal[]> {
        const all = await getBrand<FeedbackSignal>('signals');
        return onlyUndistilled ? all.filter(s => !s.distilled) : all;
    }
    addSignal(signal: FeedbackSignal) { return put('signals', signal); }
    async markSignalsDistilled(ids: string[]): Promise<void> {
        const all = await getAll<FeedbackSignal>('signals');
        for (const s of all) {
            if (ids.includes(s.id) && !s.distilled) {
                await put('signals', { ...s, distilled: true });
            }
        }
    }

    async listJobs(limit = 50): Promise<PraxisJob[]> {
        const all = await getBrand<PraxisJob>('jobs');
        return all.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
    }
    upsertJob(job: PraxisJob) { return put('jobs', job); }
    deleteJob(id: string) { return del('jobs', id); }

    async getBudget(): Promise<BudgetConfig> {
        return (await this.kvGet<BudgetConfig>('budget')) ?? { monthlyUsd: 50, warnAtFraction: 0.8 };
    }
    setBudget(config: BudgetConfig) { return this.kvSet('budget', config); }
    addSpend(record: SpendRecord) { return put('spend', record); }
    async getMonthSpend(month: string): Promise<number> {
        const all = await getAll<SpendRecord>('spend');
        return all.filter(r => r.month === month).reduce((sum, r) => sum + r.usd, 0);
    }

    async kvGet<T>(key: string): Promise<T | null> {
        const row = await tx<{ key: string; value: T } | undefined>('kv', 'readonly', s => s.get(key));
        return row?.value ?? null;
    }
    kvSet(key: string, value: unknown): Promise<void> { return put('kv', { key, value }); }

    async importBulk(data: Parameters<StorageProvider['importBulk']>[0]): Promise<void> {
        const bid = getCurrentBrandId();
        for (const a of data.assets ?? []) await put('assets', { ...a, brandId: a.brandId ?? bid });
        for (const r of data.references ?? []) await put('references', { ...r, brandId: r.brandId ?? bid });
        for (const e of data.elements ?? []) await put('elements', { ...e, brandId: e.brandId ?? bid });
        for (const r of data.rules ?? []) await put('rules', { ...r, brandId: r.brandId ?? bid });
        for (const r of data.results ?? []) await put('results', { ...r, brandId: r.brandId ?? bid });
        for (const s of data.signals ?? []) await put('signals', { ...s, brandId: s.brandId ?? bid });
    }
}

import { SupabaseProvider } from './supabase';

/**
 * App-wide singleton. Cloud when VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY
 * are configured; IndexedDB otherwise (offline dev fallback).
 */
const supaUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supaKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isCloud = !!(supaUrl && supaKey);
export const storage: StorageProvider = isCloud
    ? new SupabaseProvider(supaUrl!, supaKey!)
    : new LocalProvider();
