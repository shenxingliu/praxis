import {
    Asset, Reference, Element, KnowledgeRule, GenerationParams, GenerationResult,
    Brand, ContextMode, Realism,
} from '../domain/types';
import { storage } from '../storage/local';
import { getCurrentBrand, getCurrentBrandId } from '../domain/brand';
import { generateImage, MODELS, COST_ESTIMATE_USD } from './gemini';
import { RECIPES } from './recipes';

/**
 * Generation engine — ONE pipeline for every output type.
 *
 *   resolve context (assets + references + elements + rules + brand)
 *   → recipe builds the prompt
 *   → budget gate
 *   → generateImage
 *   → record result + spend
 *
 * Recipes are data + a buildPrompt function. Adding output type #5 is a
 * new recipe entry, not a new module.
 */

export interface RecipeContext {
    params: GenerationParams;
    assets: Asset[];
    references: Reference[];
    /** Elements chosen for recombination (with their source refs attached). */
    elements: Element[];
    rules: KnowledgeRule[];
    brand: Brand | null;
    /** The active environment grammar, resolved from params.contextModeId. */
    contextMode?: ContextMode | null;
    /** Anchor backdrop plate (silo) — its image is attached FIRST. */
    plate?: Reference | null;
}

export interface Recipe {
    id: GenerationParams['outputType'];
    name: string;
    /** How many reference-image slots this recipe wants (of the 14). */
    referenceBudget: { assetPhotos: number; aesthetic: number };
    defaultModel: 'pro' | 'flash';
    buildPrompt(ctx: RecipeContext): string;
}

const monthKey = () => new Date().toISOString().slice(0, 7);

const scopeMatches = (rule: KnowledgeRule, params: GenerationParams, assets: Asset[]): boolean => {
    if (!rule.enabled) return false;
    const s = rule.scope;
    if (s.outputType && s.outputType !== params.outputType) return false;
    if (s.purpose && s.purpose !== params.purpose) return false;
    if (s.room && params.room && s.room.toLowerCase() !== params.room.toLowerCase()) return false;
    if (s.contextModeId && s.contextModeId !== params.contextModeId) return false;
    if (s.category && !assets.some(a => (a.category ?? '').toLowerCase() === s.category!.toLowerCase())) return false;
    return true;
};

export class BudgetExceededError extends Error {
    constructor(public spent: number, public budget: number) {
        super(`Monthly budget reached: $${spent.toFixed(2)} of $${budget.toFixed(2)}. Raise it in Settings to continue.`);
    }
}

export async function generate(
    params: GenerationParams,
    assetIds: string[],
    onStatus?: (text: string) => void
): Promise<GenerationResult> {
    const recipe = RECIPES[params.outputType];

    // ---- Resolve context ----
    onStatus?.('Loading context…');
    const [allAssets, allRefs, allElements, allRules, brand] = await Promise.all([
        storage.listAssets(),
        storage.listReferences(),
        storage.listElements(),
        storage.listRules(),
        getCurrentBrand().catch(() => null),
    ]);
    const assets = allAssets.filter(a => assetIds.includes(a.id) && a.photos.length > 0);
    if (assets.length === 0) throw new Error('Pick at least one product with photos.');

    const rules = allRules.filter(r => scopeMatches(r, params, assets));

    // Elements chosen for recombination.
    const elements = (params.elementIds ?? [])
        .map(id => allElements.find(e => e.id === id))
        .filter((e): e is Element => !!e && e.enabled);

    // Environment grammar for this generation.
    const contextMode = params.contextModeId
        ? brand?.contextModes.find(m => m.id === params.contextModeId) ?? null
        : null;

    // Aesthetic references: element source refs FIRST (their pixels carry
    // the fragments being recombined), then highest-weight refs. Promoted
    // (liked) results rank naturally because likes bump weight.
    const elementRefIds = [...new Set(elements.map(e => e.sourceRefId))];
    const elementRefs = elementRefIds
        .map(id => allRefs.find(r => r.id === id && r.image.kind === 'data'))
        .filter((r): r is Reference => !!r);
    const aesthetic = [
        ...elementRefs,
        ...allRefs.filter(r =>
            r.kind !== 'plate' && r.image.kind === 'data' && !elementRefIds.includes(r.id)),
    ].slice(0, recipe.referenceBudget.aesthetic);

    // ---- Budget gate ----
    const budget = await storage.getBudget();
    const spent = await storage.getMonthSpend(monthKey());
    const model = params.modelTier === 'flash'
        ? MODELS.imageFlash
        : params.modelTier === 'pro'
            ? MODELS.imagePro
            : recipe.defaultModel === 'pro' ? MODELS.imagePro : MODELS.imageFlash;
    const cost = COST_ESTIMATE_USD[model] ?? 0.1;
    if (spent + cost > budget.monthlyUsd) throw new BudgetExceededError(spent, budget.monthlyUsd);

    // ---- Prompt + reference images ----
    // Plate anchoring (silo): the chosen backdrop plate goes FIRST in the
    // reference stack so its pixels dominate the backdrop reconstruction.
    const plate = params.plateId
        ? allRefs.find(r => r.id === params.plateId && r.image.kind === 'data') ?? null
        : null;

    const ctx: RecipeContext = { params, assets, references: aesthetic, elements, rules, brand, contextMode, plate };
    const prompt = recipe.buildPrompt(ctx);
    const assetImages = assets.flatMap(a =>
        a.photos.slice(0, Math.ceil(recipe.referenceBudget.assetPhotos / assets.length))
            .map(p => p.image.value)
    );
    const refImages = [
        ...(plate ? [plate.image.value] : []),
        ...aesthetic.map(r => r.image.value),
    ];

    // ---- Generate ----
    onStatus?.('Generating…');
    const out = await generateImage({
        prompt,
        referenceImages: [...assetImages, ...refImages],
        model,
        aspectRatio: params.ratio,
    });

    // ---- Record ----
    const result: GenerationResult = {
        id: crypto.randomUUID(),
        brandId: getCurrentBrandId(),
        params,
        assetIds: assets.map(a => a.id),
        referenceIds: aesthetic.map(r => r.id),
        elementIds: elements.map(e => e.id),
        appliedRuleIds: rules.map(r => r.id),
        fullPrompt: prompt,
        model: out.model,
        image: { kind: 'data', value: out.image },
        estimatedCostUsd: cost,
        createdAt: Date.now(),
        adopted: false,
    };
    await storage.upsertResult(result);
    await storage.addSpend({
        id: crypto.randomUUID(),
        resultId: result.id,
        usd: cost,
        model: out.model,
        month: monthKey(),
        createdAt: Date.now(),
    });
    return result;
}

/** Realism → the opening line + physics rules of the prompt skeleton. */
export const REALISM_SKELETON: Record<Realism, { opener: string; physics: string }> = {
    photographic: {
        opener: 'You are a high-end commercial photography art director. Create a photorealistic photograph.',
        physics: 'Physically plausible space, light and scale. Editorial photography, 8k.',
    },
    surreal: {
        opener: 'You are a visionary art director for conceptual brand imagery. Create a surreal, dreamlike composition — impossible as a place, impeccable as a photograph.',
        physics: 'The PRODUCT obeys real physics and stays perfectly true to its reference photos; the environment may bend space, gravity, scale and weather in service of the concept. Cinematic, 8k.',
    },
    abstract: {
        opener: 'You are an art director for abstract still-life brand imagery. Compose the product within a non-literal, formal environment of pure shape, material and light.',
        physics: 'The PRODUCT stays photorealistic and true to its references; the environment is abstract — geometric forms, fields of color, sculptural light. Gallery-grade, 8k.',
    },
};

/** Shared prompt fragments used by all recipes. */
export const promptBlocks = {
    productFidelity(assets: Asset[], brand: Brand | null): string {
        const essence = brand?.productEssence?.trim();
        return assets.map(a =>
            `PRODUCT: ${a.name}${a.category ? ` (${a.category})` : ''}
SOURCE OF TRUTH: the attached reference photos for this product. Use ONLY them.
FIDELITY RULE: reconstruct the exact product — silhouette, geometry, color, material texture${essence ? `, with special care for: ${essence}` : ''}. ZERO deviation, no creative reinterpretation.`
        ).join('\n\n');
    },
    brand(brand: Brand | null): string {
        if (!brand) return '';
        return `\n### BRAND ###\n${brand.name}: ${brand.description}`;
    },
    /** The recombination directive — elements pulled from decomposed refs. */
    elements(elements: Element[]): string {
        if (elements.length === 0) return '';
        const lines = elements.map(e => `- ${e.type.toUpperCase()}: ${e.description}`);
        return `\n### RECOMBINATION (fragments extracted from the attached aesthetic references — apply each faithfully) ###\n${lines.join('\n')}`;
    },
    /** Environment grammar from the brand's context mode. */
    context(mode: ContextMode | null | undefined): string {
        if (!mode) return '';
        return `\n### ENVIRONMENT ###\n${mode.label}: ${mode.directive}`;
    },
    /** Studio (expert) controls → prompt directives. Empty when all Auto. */
    studio(params: GenerationParams): string {
        const lines = [
            params.camera && params.camera !== 'Auto' && `Camera position: ${params.camera}.`,
            params.lens && params.lens !== 'Auto' && `Lens: ${params.lens} equivalent — respect its perspective compression and depth of field.`,
            params.lighting && params.lighting !== 'Auto' && `Lighting: ${params.lighting}.`,
        ].filter(Boolean);
        return lines.length > 0 ? `\n### CAMERA & LIGHT (user-specified, obey exactly) ###\n${lines.join('\n')}` : '';
    },
    knowledge(rules: KnowledgeRule[]): string {
        if (rules.length === 0) return '';
        const must = rules.filter(r => r.polarity === 'must').map(r => `- ${r.rule}`);
        const avoid = rules.filter(r => r.polarity === 'avoid').map(r => `- ${r.rule}`);
        return `\n### LEARNED RULES (from feedback — obey strictly) ###
${must.length > 0 ? `MUST:\n${must.join('\n')}\n` : ''}${avoid.length > 0 ? `AVOID:\n${avoid.join('\n')}` : ''}`;
    },
};
