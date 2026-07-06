import {
    Asset,
    Reference,
    Element,
    KnowledgeRule,
    GenerationResult,
    FeedbackSignal,
    PraxisJob,
    BudgetConfig,
    SpendRecord,
} from '../domain/types';

/**
 * StorageProvider — the single seam between the app and its persistence.
 *
 * Brand scoping: every list method returns ONLY records of the active
 * brand (providers read getCurrentBrandId()); writes pass through — the
 * caller sets brandId when creating a record.
 *
 * kv is raw/global — callers build brand-scoped keys via brandKey().
 */
export interface StorageProvider {
    // Assets
    listAssets(): Promise<Asset[]>;
    upsertAsset(asset: Asset): Promise<void>;
    deleteAsset(id: string): Promise<void>;

    // References
    listReferences(kind?: Reference['kind']): Promise<Reference[]>;
    upsertReference(ref: Reference): Promise<void>;
    deleteReference(id: string): Promise<void>;

    // Elements (decomposed reference fragments)
    listElements(type?: Element['type']): Promise<Element[]>;
    upsertElement(element: Element): Promise<void>;
    deleteElement(id: string): Promise<void>;

    // Knowledge
    listRules(): Promise<KnowledgeRule[]>;
    upsertRule(rule: KnowledgeRule): Promise<void>;
    deleteRule(id: string): Promise<void>;

    // Results + signals
    listResults(limit?: number): Promise<GenerationResult[]>;
    getResult(id: string): Promise<GenerationResult | null>;
    upsertResult(result: GenerationResult): Promise<void>;
    deleteResult(id: string): Promise<void>;
    listSignals(onlyUndistilled?: boolean): Promise<FeedbackSignal[]>;
    addSignal(signal: FeedbackSignal): Promise<void>;
    markSignalsDistilled(ids: string[]): Promise<void>;

    // Jobs (studio workflow)
    listJobs(limit?: number): Promise<PraxisJob[]>;
    upsertJob(job: PraxisJob): Promise<void>;

    // Budget (global — one wallet across brands)
    getBudget(): Promise<BudgetConfig>;
    setBudget(config: BudgetConfig): Promise<void>;
    addSpend(record: SpendRecord): Promise<void>;
    getMonthSpend(month: string): Promise<number>;

    // Raw kv (global keys; use brandKey() for per-brand values)
    kvGet<T>(key: string): Promise<T | null>;
    kvSet(key: string, value: unknown): Promise<void>;

    /** Bulk import used by migrations. Missing brandId is filled with the
     *  active brand. */
    importBulk(data: {
        assets?: Asset[];
        references?: Reference[];
        elements?: Element[];
        rules?: KnowledgeRule[];
        results?: GenerationResult[];
        signals?: FeedbackSignal[];
    }): Promise<void>;
}
