/**
 * Praxis domain model — an AI-agent design studio.
 *
 *   Collect → Classify → Decompose → Recombine → Create → Learn
 *
 *   Brand (workspace)         the client. soul + context modes + libraries
 *   Asset (product truth)     zero-deviation source pixels
 *   Reference (aesthetics)    uploaded / promoted imagery
 *   Element (decomposed)      reusable semantic fragments of references
 *   Job (studio workflow)     brief → concepts → plan → execute → review
 *   Knowledge + Signals       the studio's accumulated experience
 *
 * Design notes:
 * - Multi-brand from day one: every record carries brandId; storage
 *   providers filter reads by the active brand.
 * - Single user (per product decision) — ids are UUIDs so multi-user can
 *   be added without migration pain.
 * - LoRA door left open: Result + FeedbackSignal carry full generation
 *   metadata so liked results can be exported as a training set later.
 */

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

export type ImageRef = {
    /** 'data' = base64 data URL inline; 'url' = object storage / CDN. */
    kind: 'data' | 'url';
    value: string;
    width?: number;
    height?: number;
};

export type OutputType = 'scene' | 'silo' | 'detail' | 'fabric';

export type Purpose = 'hero' | 'pdp' | 'social' | 'seasonal';

/** How real the environment is allowed to be — picks the prompt skeleton. */
export type Realism = 'photographic' | 'surreal' | 'abstract';

// ---------------------------------------------------------------------------
// 0. Brand — the workspace / client every other record belongs to
// ---------------------------------------------------------------------------

export interface ContextMode {
    id: string;
    label: string;          // e.g. 'Bedroom' | 'Surreal dreamscape'
    directive: string;      // promptable description of the environment grammar
    realism: Realism;
}

export interface Brand {
    id: string;             // slug, e.g. 'greenington'
    name: string;
    /** One line: category + positioning. The domain variable of every prompt. */
    description: string;
    /** Product-fidelity essentials, e.g. 'solid bamboo grain, joinery, finish'. */
    productEssence: string;
    contextModes: ContextMode[];
    createdAt: number;
    updatedAt: number;
}

// ---------------------------------------------------------------------------
// 1. Asset — product truth (zero-deviation source for generation)
// ---------------------------------------------------------------------------

export type PhotoRole = 'hero' | 'detail' | 'side' | 'back';

export interface AssetPhoto {
    id: string;
    image: ImageRef;
    role: PhotoRole;
}

export interface Asset {
    id: string;
    brandId: string;
    name: string;
    category?: string;
    collection?: string;
    finish?: string;
    tags: string[];
    photos: AssetPhoto[];
    dimensions?: { width?: number; height?: number; depth?: number; unit: 'inch' | 'cm' };
    createdAt: number;
    updatedAt: number;
    /** V1 inventory id when migrated, for traceability. */
    v1Id?: string;
}

// ---------------------------------------------------------------------------
// 2. Reference — aesthetic sources (style / material / lighting / plate)
// ---------------------------------------------------------------------------

export type ReferenceKind = 'style' | 'material' | 'lighting' | 'composition' | 'plate';

export interface Reference {
    id: string;
    brandId: string;
    kind: ReferenceKind;
    name: string;
    image: ImageRef;
    tags: string[];
    /** 'upload' = user provided; 'promoted' = a liked Result promoted into
     *  the reference pool (the strongest learning channel). */
    source: 'upload' | 'promoted';
    /** Selection weight — bumped by likes, decayed by dislikes. */
    weight: number;
    createdAt: number;
    /** Set once the decomposition agent has extracted elements from it. */
    decomposed?: boolean;
}

// ---------------------------------------------------------------------------
// 3. Element — decomposed semantic fragments of references (the recombination
//    vocabulary: "this image's light + that image's palette + the product")
// ---------------------------------------------------------------------------

export type ElementType =
    | 'light' | 'palette' | 'composition' | 'material'
    | 'mood' | 'setting' | 'prop' | 'style';

export interface Element {
    id: string;
    brandId: string;
    type: ElementType;
    /** Concrete, promptable description of the fragment. */
    description: string;
    /** Source reference — lets generation attach the original pixels. */
    sourceRefId: string;
    /** N/S/I soul-field keys this element informs (e.g. 'sensation.light'). */
    nsiKeys: string[];
    /** Selection weight — learning bumps/decays it. */
    weight: number;
    enabled: boolean;
    createdAt: number;
}

// ---------------------------------------------------------------------------
// 4. Knowledge — distilled experience rules (visible, editable, deletable)
// ---------------------------------------------------------------------------

export interface RuleScope {
    outputType?: OutputType;
    purpose?: Purpose;
    room?: string;
    category?: string;
    contextModeId?: string;
}

export interface KnowledgeRule {
    id: string;
    brandId: string;
    scope: RuleScope;
    /** Natural-language directive injected into prompts when scope matches. */
    rule: string;
    polarity: 'must' | 'avoid';
    /** How many signals support this rule — display + pruning heuristics. */
    confidence: number;
    /** FeedbackSignal ids this was distilled from. */
    sources: string[];
    /** Human can switch a bad lesson off without deleting evidence. */
    enabled: boolean;
    createdAt: number;
    updatedAt: number;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export interface GenerationParams {
    outputType: OutputType;
    purpose?: Purpose;
    room?: string;
    focus?: string;
    backdrop?: string;
    ratio: '1:1' | '16:9' | '4:3' | '3:4' | '9:16';
    note?: string;
    modelTier: 'auto' | 'pro' | 'flash';

    /** Environment grammar for this generation (brand's context mode). */
    contextModeId?: string;
    /** Elements explicitly chosen for recombination. */
    elementIds?: string[];

    // --- Studio (expert) controls — ported from V1.3. All optional;
    // 'Auto'/undefined lets brand soul + recipe defaults decide. ---
    camera?: string;    // e.g. 'Hero Front' | '3/4 View' | 'Full Room' | 'Low Angle'
    lens?: string;      // e.g. '55mm' | '85mm' | '100mm' | '120mm'
    lighting?: string;  // e.g. 'Soft Morning' | 'Golden Hour' | 'Overcast' | 'Studio' | 'Night Lamps'
    margin?: number;    // silo: product edge distance %, default 10
    bedding?: string;   // silo: 'none' | 'minimal' | 'styled'
    plateId?: string;   // silo: anchor backdrop plate (Reference id, kind 'plate')
}

export interface GenerationResult {
    id: string;
    brandId: string;
    params: GenerationParams;
    assetIds: string[];
    referenceIds: string[];
    /** Elements recombined into this generation. */
    elementIds?: string[];
    /** Knowledge rules that were active for this generation. */
    appliedRuleIds: string[];
    /** Exact prompt sent — LoRA-door requirement + debugging. */
    fullPrompt: string;
    model: string;
    image: ImageRef;
    estimatedCostUsd: number;
    createdAt: number;
    /** Adoption state — drives the north-star metric. */
    adopted: boolean;
    /** Studio job that produced this, when run through the workflow. */
    jobId?: string;
}

// ---------------------------------------------------------------------------
// 5. Job — the visible studio workflow (brief → concepts → plan → execute
//    → review → done). Every stage is inspectable and editable.
// ---------------------------------------------------------------------------

export type JobStage = 'brief' | 'concepts' | 'plan' | 'execute' | 'review' | 'done';

export interface ConceptProposal {
    id: string;
    title: string;
    /** Why this direction serves the brief + the brand. */
    rationale: string;
    /** Compact N/S/I sketch of the direction. */
    nsiSummary: string;
    /** Elements the concept wants to recombine. */
    elementIds: string[];
    contextModeId?: string;
    realism: Realism;
}

export interface ProductionPlan {
    conceptId: string;
    /** Human-readable steps the producer agent laid out. */
    steps: string[];
    params: GenerationParams;
    assetIds: string[];
    elementIds: string[];
    referenceIds: string[];
}

export interface ReviewReport {
    /** 0-100 vs the brand soul. */
    overall: number;
    axisScores: Array<{ axis: string; score: number; note: string }>;
    verdict: 'pass' | 'revise';
    suggestions: string[];
}

export interface PraxisJob {
    id: string;
    brandId: string;
    brief: string;
    stage: JobStage;
    concepts: ConceptProposal[];
    chosenConceptId?: string;
    plan?: ProductionPlan;
    resultIds: string[];
    review?: ReviewReport;
    createdAt: number;
    updatedAt: number;
}

// ---------------------------------------------------------------------------
// Learning signals
// ---------------------------------------------------------------------------

export type SignalType =
    | 'like'        // explicit 👍
    | 'dislike'     // explicit 👎 (+reason)
    | 'save'        // kept in gallery       → implicit strong positive
    | 'export'      // downloaded            → implicit adoption
    | 'discard'     // deleted w/o saving    → implicit weak negative
    | 'regenerate'; // re-ran same config    → implicit dissatisfaction

export interface FeedbackSignal {
    id: string;
    brandId: string;
    resultId: string;
    type: SignalType;
    reason?: string;
    /** Snapshot of scope so distillation never needs to re-join. */
    scope: RuleScope;
    createdAt: number;
    /** Set once a distillation run has consumed this signal. */
    distilled: boolean;
}

// ---------------------------------------------------------------------------
// Budget — global (one wallet), not per-brand
// ---------------------------------------------------------------------------

export interface BudgetConfig {
    monthlyUsd: number;
    /** Warn when spent/monthly crosses this fraction (default 0.8). */
    warnAtFraction: number;
}

export interface SpendRecord {
    id: string;
    resultId: string;
    usd: number;
    model: string;
    /** YYYY-MM for monthly aggregation. */
    month: string;
    createdAt: number;
}

// ---------------------------------------------------------------------------
// Brand profile — legacy V1 shape, kept only for migration import
// ---------------------------------------------------------------------------

export interface BrandProfile {
    brandName: string;
    identity: string;
    emotionalAnchors: string[];
    environmentSignature: {
        architecture: string[];
        lightCharacter: string[];
        spatialPalette: string[];
    };
    forbiddenMoves: string[];
    /** Raw V1 profile JSON preserved verbatim for anything not modeled yet. */
    v1Raw?: unknown;
}
