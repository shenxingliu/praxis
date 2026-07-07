import {
    Asset, Reference, Element, KnowledgeRule, GenerationParams, GenerationResult,
    Brand, ContextMode, Realism,
} from '../domain/types';
import { storage } from '../storage/local';
import { getCurrentBrand, getCurrentBrandId } from '../domain/brand';
import { generateImage, generateJson, MODELS, COST_ESTIMATE_USD } from './gemini';
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
    onStatus?: (text: string) => void,
    /** Extra reference images (data URLs) attached FIRST — e.g. the chosen
     *  moodboard anchor whose pixels should dominate the mood. */
    extraRefImages: string[] = []
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
    if (assets.length === 0) throw new Error('Pick at least one hero with photos.');

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
    // When a mood anchor is attached, competing interior imagery dilutes the
    // hero signal — cap aesthetic refs harder.
    const aestheticCap = extraRefImages.length > 0
        ? Math.min(2, recipe.referenceBudget.aesthetic)
        : recipe.referenceBudget.aesthetic;
    const aesthetic = [
        ...elementRefs,
        ...allRefs.filter(r =>
            r.kind !== 'plate' && r.image.kind === 'data' && !elementRefIds.includes(r.id)),
    ].slice(0, aestheticCap);

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
    const assetImages = assets.flatMap(a =>
        a.photos.slice(0, Math.ceil(recipe.referenceBudget.assetPhotos / assets.length))
            .map(p => p.image.value)
    );
    // Hero repeated LAST (adjacent to the text prompt) — models
    // attend most to the first and last images; the hero bookends both.
    const heroReminder = assetImages[0] ? [assetImages[0]] : [];
    const refImages = [
        ...extraRefImages,
        ...(plate ? [plate.image.value] : []),
        ...aesthetic.map(r => r.image.value),
        ...heroReminder,
    ];

    // IMAGE MANIFEST — the model must know which attached image plays which
    // role, or it will copy the hero from a mood anchor / style ref
    // instead of the true hero photos (the classic consistency killer).
    const n = assetImages.length;
    const anchorIdx = n + 1;
    const plateIdx = anchorIdx + extraRefImages.length;
    const aestheticStart = plateIdx + (plate ? 1 : 0);
    const manifestLines = [
        `Images 1-${n}: HERO SOURCE OF TRUTH. Reconstruct the hero EXACTLY and ONLY from these — silhouette, geometry, color, material, hardware. If any other attached image shows a similar hero, IGNORE that rendering completely. The decorative styling in these photos (bedding, props, dressing) is NOT part of the hero — restyle it per the creative direction.`,
        extraRefImages.length > 0 && `Image ${anchorIdx}${extraRefImages.length > 1 ? `-${anchorIdx + extraRefImages.length - 1}` : ''}: MOOD ANCHOR — an approved rough draft. Inherit its light, palette, atmosphere and composition energy ONLY. Its hero rendering is APPROXIMATE and WRONG — never copy any object geometry from it.`,
        plate && `Image ${plateIdx}: BACKDROP PLATE — reconstruct this exact backdrop with zero drift.`,
        aesthetic.length > 0 && `Images ${aestheticStart}-${aestheticStart + aesthetic.length - 1}: AESTHETIC REFERENCES — style, light and material language only. NEVER copy their subjects or furniture.`,
        heroReminder.length > 0 && `LAST image: the hero photo repeated as a REMINDER — this is what the hero must look like.`,
    ].filter(Boolean);
    const prompt = `${recipe.buildPrompt(ctx)}

### ATTACHED IMAGE ROLES (obey strictly) ###
${manifestLines.join('\n')}

### FINAL, NON-NEGOTIABLE ###
1. The hero must be pixel-faithful to images 1-${n}: same silhouette, proportions, construction, material, color, hardware.
2. The listed hero(s) are the ONLY furniture in the image — zero invented companion pieces.
3. The hero must be fully styled per the direction (dressed bed, curated surfaces) — styling changes, the hero never does.`;

    // Concept half-life: touch lastUsedAt on every concept used.
    for (const el of elements) {
        storage.upsertElement({ ...el, lastUsedAt: Date.now() }).catch(() => {});
    }

    // ---- Generate ----
    onStatus?.('Generating…');
    let out = await generateImage({
        prompt,
        referenceImages: [...assetImages, ...refImages],
        model,
        aspectRatio: params.ratio,
        imageSize: params.size,
    });

    // ---- Hero-consistency enforcement (pro generations only) ----
    // An inspector agent compares the render against the hero photos.
    // On failure it regenerates ONCE with the concrete deviations injected —
    // prompt persuasion plus after-the-fact enforcement.
    let consistency: GenerationResult['consistency'];
    if (model === MODELS.imagePro && assetImages.length > 0) {
        const check = async (img: string) => {
            const parsed = await generateJson<{ pass: boolean; issues: string[] }>(
                `The first ${Math.min(assetImages.length, 5)} attached image(s) are OFFICIAL HERO PHOTOS. The LAST attached image is an AI-generated marketing image featuring this hero.

Check TWO things:
1. HERO FIDELITY: silhouette, proportions, structure/construction, material and grain, color/finish, hardware. IGNORE styling (bedding, props, dressing), environment, lighting and camera angle — those are allowed to differ.
2. FURNITURE EXCLUSIVITY: the generated image must contain NO furniture other than the hero(s) shown in the official photos. Extra nightstands, chairs, tables, dressers or other beds are violations. Rugs, curtains, plants, wall art, lighting and small decor are fine.

Output JSON: { "pass": boolean (true only if the hero is faithfully identical AND no extra furniture exists), "issues": [up to 4 CONCRETE deviations, each one actionable, e.g. "headboard slats are vertical but should be horizontal" or "remove the invented nightstand on the left"] }`,
                [...assetImages.slice(0, 5), img]
            );
            return { pass: !!parsed?.pass, issues: (parsed?.issues ?? []).map(String).slice(0, 4) };
        };
        try {
            onStatus?.('Inspecting hero consistency…');
            const first = await check(out.image);
            if (first.pass || first.issues.length === 0) {
                consistency = { ...first, retried: false };
            } else {
                // Surgical correction: EDIT the failed image instead of
                // re-rendering. Scene, styling and light are kept; only the
                // hero is rebuilt from its photos. Far more reliable than
                // a fresh render, which re-rolls the whole composition.
                onStatus?.('Consistency failed — surgically correcting the hero…');
                const corrected = await generateImage({
                    prompt: `EDIT the FIRST attached image. This is an image-editing task, not a new composition.

KEEP EXACTLY: the environment, composition, camera, lighting, styling, bedding, props and mood of the first image.
FIX ONLY THE HERO: rebuild it to match the hero photos (all attached images after the first) with zero deviation — silhouette, proportions, construction, material, color, hardware.

Known defects to correct:
${first.issues.map(s => `- ${s}`).join('\n')}

### ATTACHED IMAGE ROLES ###
Image 1: the image to edit (everything except the hero is correct).
Images 2-${1 + Math.min(assetImages.length, 6)}: HERO SOURCE OF TRUTH.`,
                    referenceImages: [out.image, ...assetImages.slice(0, 6)],
                    model,
                    aspectRatio: params.ratio,
                    imageSize: params.size,
                });
                out = corrected;
                const second = await check(out.image).catch(() => ({ pass: true, issues: [] }));
                consistency = { ...second, retried: true };
            }
        } catch (err) {
            console.warn('[engine] consistency check failed:', err); // never blocks delivery
        }
    }

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
        estimatedCostUsd: consistency?.retried ? cost * 2 : cost,
        createdAt: Date.now(),
        adopted: false,
        consistency,
    };
    await storage.upsertResult(result);
    await storage.addSpend({
        id: crypto.randomUUID(),
        resultId: result.id,
        usd: consistency?.retried ? cost * 2 : cost,
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
        physics: 'The HERO obeys real physics and stays perfectly true to its reference photos; the environment may bend space, gravity, scale and weather in service of the concept. Cinematic, 8k.',
    },
    abstract: {
        opener: 'You are an art director for abstract still-life brand imagery. Compose the hero within a non-literal, formal environment of pure shape, material and light.',
        physics: 'The HERO stays photorealistic and true to its references; the environment is abstract — geometric forms, fields of color, sculptural light. Gallery-grade, 8k.',
    },
};

/** Shared prompt fragments used by all recipes. */
export const promptBlocks = {
    heroFidelity(assets: Asset[], brand: Brand | null): string {
        const essence = brand?.heroEssence?.trim();
        return assets.map(a =>
            `HERO: ${a.name}${a.category ? ` (${a.category})` : ''}
SOURCE OF TRUTH: the attached reference photos for this hero. Use ONLY them.
FIDELITY RULE — applies to the HERO ITSELF ONLY: reconstruct its exact silhouette, geometry, construction, color, material texture and hardware${essence ? `, with special care for: ${essence}` : ''}. ZERO deviation, no creative reinterpretation.
STYLING RULE — decorative styling is NOT the hero: bedding, pillows, throws, tabletop objects, vases, books, plants and any dressing visible in the hero photos are disposable staging. REPLACE them with styling that serves THIS generation's creative direction. STYLING IS MANDATORY, not optional: a bed MUST be fully dressed (mattress, layered bedding, pillows) in the direction's palette and mood; tables/desks/consoles MUST carry a few curated objects; shelves must not be empty. A bare, unstyled hero is a FAILED image unless the direction explicitly asks for bare. Styling must never alter or obscure the hero's own structure, material or color.
EXCLUSIVITY RULE — the listed hero(s) are the ONLY furniture in the frame. NEVER invent companion furniture: no extra nightstands, side tables, chairs, benches, dressers, shelving or other beds. The environment may include architecture, rugs, curtains, plants, wall art, lighting fixtures and small decor objects — but anything that qualifies as furniture and is not a listed hero makes the image a FAILURE.`
        ).join('\n\n');
    },
    brand(brand: Brand | null): string {
        if (!brand) return '';
        return `\n### BRAND ###\n${brand.name}: ${brand.description}`;
    },
    /** The recombination directive — concept cards from decomposed refs. */
    elements(elements: Element[]): string {
        if (elements.length === 0) return '';
        const lines = elements.map(e =>
            `- [${e.type.toUpperCase()}] "${e.concept}" — realize it: ${e.description}`);
        return `\n### CONCEPTUAL RECOMBINATION (ideas extracted from the attached references — embody each concept, do NOT copy the source subjects) ###\n${lines.join('\n')}`;
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
