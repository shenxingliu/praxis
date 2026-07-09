import { Asset, Element, GenerationParams, GenerationResult, KnowledgeRule } from '../domain/types';
import { storage } from '../storage/local';
import { getCurrentBrand, getCurrentBrandId } from '../domain/brand';
import { getBrandSoul } from '../brain/soul';
import { generateImage, generateJson, MODELS, COST_ESTIMATE_USD } from './gemini';
import { BudgetExceededError, pendingSpendUsd, reservePendingSpend, promptBlocks, subjectExclusivityRule, subjectInspectorCriteria } from './engine';

/**
 * Weave — freeform canvas generation (the Figma-Weave-inspired mode).
 *
 * The user composes a board of nodes and everything on it is woven into
 * ONE image:
 *   hero nodes  → source-of-truth pixels, fidelity + exclusivity enforced
 *   element nodes  → abstract concepts to embody
 *   image nodes    → fusion sources: aesthetic ideas to blend, never copy
 *   note           → free art direction
 *
 * Same protections as the Studio engine: image-role manifest, mandatory
 * styling, only-listed-furniture, soul red-lines, and (pro tier) the
 * hero-consistency inspector with one surgical correction pass.
 */

/** One extracted dimension of an image — "take ONLY its light". */
export interface WeaveFacet {
    image: string;      // source image data URL
    dimension: string;  // light | palette | composition | material | texture | mood | space
    description: string;
}

export const FACET_DIMENSIONS = ['light', 'palette', 'composition', 'material', 'texture', 'mood', 'space', 'form', 'camera', 'styling', 'grading', 'narrative'] as const;

/** What each dimension means — keeps the extraction model on-target. */
export const FACET_HINTS: Record<(typeof FACET_DIMENSIONS)[number], string> = {
    light: 'direction, quality (hard/soft), temperature, shadow behavior',
    palette: 'the actual colors and their proportions/logic',
    composition: 'framing geometry, balance, focal placement, negative space',
    material: 'named surface materials and their finish',
    texture: 'tactile surface qualities and grain',
    mood: 'the emotional tone and atmosphere',
    space: 'spatial depth, scale feeling, architectural envelope',
    form: 'the sculptural language of the main subject — silhouette character, geometric vocabulary (curves vs planes), proportions, edge radii, visual weight — described ABSTRACTLY as transferable form language, never naming or reproducing the object itself',
    camera: 'lens language — focal-length feel (wide/normal/tele compression), depth of field, camera height and distance',
    styling: 'propping logic — staging density, prop families, arrangement rhythm and curation style',
    grading: 'color treatment — contrast curve, shadow/highlight tinting, saturation strategy, film-like character (distinct from WHICH colors)',
    narrative: 'the implied story or human moment — time of day, traces of presence, what just happened',
};

/** Dimensional decomposition: ONE vision call for exactly the requested
 *  dimensions (defaults to all of them). */
export async function extractFacets(image: string, dimensions?: ReadonlyArray<string>): Promise<Array<{ dimension: string; description: string }>> {
    const wanted = (dimensions && dimensions.length > 0
        ? FACET_DIMENSIONS.filter(d => dimensions.includes(d))
        : [...FACET_DIMENSIONS]);
    const parsed = await generateJson<{ facets: Array<{ dimension: string; description: string }> }>(
        `Decompose the attached image into ${wanted.length === 1 ? 'this INDEPENDENT visual dimension' : 'these INDEPENDENT visual dimensions'}, so each can be transferred to a different image on its own.

For each dimension output a CONCRETE, promptable description (specific hues, light direction/quality, named materials, compositional geometry — never vague):
${wanted.map(d => `- ${d}: ${FACET_HINTS[d]}`).join('\n')}

Output JSON: { "facets": [ { "dimension", "description" } ] }`,
        [image]
    );
    const allowed = new Set<string>(wanted);
    return (parsed?.facets ?? [])
        .filter(f => allowed.has(String(f.dimension)) && f.description?.trim())
        .map(f => ({ dimension: String(f.dimension), description: String(f.description).trim() }));
}

const angularDistance = (a: number, b: number) => {
    const d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
};

/** Estimate each photo's camera azimuth around the SAME subject
 *  (0 = front, 90 = right, 180 = back, 270 = left; null = can't judge). */
export async function estimateAngles(images: string[]): Promise<Array<number | null>> {
    const parsed = await generateJson<{ angles: Array<number | null> }>(
        `The ${images.length} attached images show the SAME object photographed from different camera positions.
For each image, in order, estimate the camera azimuth in degrees around the object's vertical axis:
0 = the object's FRONT face, 90 = its RIGHT side, 180 = its BACK, 270 = its LEFT side.
If an image is a close-up detail where the overall viewpoint cannot be judged, use null.
Output JSON: { "angles": [${images.map(() => 'number|null').join(', ')}] }`,
        images
    );
    const angles = parsed?.angles ?? [];
    return images.map((_, i) => {
        const value = angles[i];
        return typeof value === 'number' && isFinite(value) ? ((Math.round(value) % 360) + 360) % 360 : null;
    });
}

/** Derive the transferable aesthetic idea of an image (concept role). */
export async function deriveIdea(image: string): Promise<string> {
    const parsed = await generateJson<{ idea: string }>(
        `State the single most transferable AESTHETIC IDEA of the attached image in 1-2 sentences — abstract enough to apply to a different subject, concrete enough to art-direct with (light behavior, palette logic, formal energy, mood). Output JSON: { "idea": string }`,
        [image]
    );
    return String(parsed?.idea ?? '').trim();
}

/** Reverse-engineer a generation prompt from an image. */
export async function describeAsPrompt(image: string): Promise<string> {
    const parsed = await generateJson<{ prompt: string }>(
        `Write the image-generation prompt that would recreate the attached image's LOOK (not its exact subjects): scene type, light direction and quality, palette, materials, composition, camera feel, mood. 3-5 dense sentences, directly usable as a prompt. Output JSON: { "prompt": string }`,
        [image]
    );
    return String(parsed?.prompt ?? '').trim();
}

/**
 * Directed analysis — analyze an image per a specific user instruction,
 * then produce a concrete, promptable generation prompt capturing what
 * the analysis reveals. Unlike describeAsPrompt (generic), this follows
 * an arbitrary user question: "analyze the background materials", "what
 * lighting setup is used", "describe the color palette", etc.
 */
export async function analyzeImage(image: string, instruction: string): Promise<string> {
    const parsed = await generateJson<{ prompt: string }>(
        `You are an expert visual analyst and art director. Analyze the attached image according to this SPECIFIC instruction:

"${instruction}"

Based on your analysis, write a DETAILED, actionable image-generation prompt that captures EXACTLY what the analysis reveals. The prompt must be directly usable to recreate or incorporate the analyzed aspects into a new AI-generated image.

Be concrete and specific: name exact materials (e.g. "quarter-sawn white oak with honey-toned oil finish"), colors with approximate hex codes, textures, lighting direction and quality, spatial geometry, proportions, and any other visually relevant properties the instruction asks about.

Output 3-6 dense, promptable sentences — no preamble, no bullet points, no labels.
Output JSON: { "prompt": string }`,
        [image]
    );
    return String(parsed?.prompt ?? '').trim();
}

/**
 * Turntable rotation — render the SAME subject (hero, object or person)
 * from a new viewpoint, using one or more reference angles. Geometry,
 * materials, colors and identity are preserved exactly; neutral backdrop.
 */
export async function rotateView(
    sourceImages: string[],
    angleDegrees: number,
    opts: { ratio: GenerationParams['ratio']; size?: GenerationParams['size']; tier: 'flash' | 'pro'; pitch?: number; sourceAngles?: Array<number | null> },
    onStatus?: (t: string) => void
): Promise<GenerationResult> {
    if (sourceImages.length === 0) throw new Error('Connect or add at least one image of the subject.');
    const pitch = Math.max(-60, Math.min(60, Math.round(opts.pitch ?? 0)));
    const pitchLine = pitch > 5
        ? `CAMERA ELEVATION: raised camera looking DOWN at the subject by about ${pitch}°.`
        : pitch < -5
            ? `CAMERA ELEVATION: lowered camera looking UP at the subject by about ${Math.abs(pitch)}°.`
            : 'CAMERA ELEVATION: eye-level, straight-on.';
    const model = opts.tier === 'pro' ? MODELS.imagePro : MODELS.imageFlash;
    const cost = COST_ESTIMATE_USD[model] ?? 0.1;
    const month = new Date().toISOString().slice(0, 7);
    const budget = await storage.getBudget();
    const spent = await storage.getMonthSpend(month);
    if (spent + pendingSpendUsd() + cost > budget.monthlyUsd) throw new BudgetExceededError(spent, budget.monthlyUsd);
    const releaseBudget = reservePendingSpend(cost);

    const dir = ((angleDegrees % 360) + 360) % 360;
    const known = (opts.sourceAngles ?? [])
        .map((angle, index) => (angle == null ? null : { index, angle: ((Math.round(angle) % 360) + 360) % 360 }))
        .filter((entry): entry is { index: number; angle: number } => !!entry);
    const nearest = known.length > 0
        ? known.reduce((best, entry) => angularDistance(entry.angle, dir) < angularDistance(best.angle, dir) ? entry : best)
        : null;
    const anglesBlock = nearest ? `
KNOWN CAMERA ANGLES of the attached images (0° = the subject's front): ${known.map(entry => `image ${entry.index + 1} ≈ ${entry.angle}°`).join(', ')}.
Image ${nearest.index + 1} (≈${nearest.angle}°) is the CLOSEST existing view to the ${dir}° target — treat it as the PRIMARY geometric reference and rotate from it; use the other images to confirm materials, colors and hidden-side details.` : '';
    const prompt = `TURNTABLE TASK. The attached image(s) show ONE subject (a hero, object or person) from ${sourceImages.length > 1 ? 'multiple angles' : 'one angle'}.

Render the EXACT SAME subject rotated to the ${dir}° viewpoint (0° = ${nearest ? "the subject's FRONT face" : "the first image's front view"}; rotation is clockwise around the subject's vertical axis, camera distance unchanged).
${pitchLine}${anglesBlock}

STRICT IDENTITY: same geometry, proportions, materials, textures, colors, details${sourceImages.length > 1 ? ' — reconcile all provided angles into one consistent subject' : ''}. Infer hidden sides plausibly and consistently.
BACKDROP: clean neutral studio backdrop, soft even light, gentle grounding shadow. NOTHING else in frame. No text.`;

    onStatus?.(`Rotating to ${dir}°…`);
    const out = await generateImage({
        prompt,
        referenceImages: sourceImages.slice(0, 8),
        model,
        aspectRatio: opts.ratio,
        imageSize: opts.size,
    });

    const result: GenerationResult = {
        id: crypto.randomUUID(),
        brandId: getCurrentBrandId(),
        params: { outputType: 'silo', ratio: opts.ratio, size: opts.size, note: `turntable ${dir}°${pitch !== 0 ? ` / pitch ${pitch}°` : ''}`, modelTier: opts.tier },
        assetIds: [], referenceIds: [], elementIds: [], appliedRuleIds: [],
        fullPrompt: prompt, model,
        image: { kind: 'data', value: out.image },
        estimatedCostUsd: cost,
        createdAt: Date.now(),
        adopted: false,
    };
    await storage.upsertResult(result);
    await storage.addSpend({ id: crypto.randomUUID(), resultId: result.id, usd: cost, model, month, createdAt: Date.now() });
    releaseBudget();
    return result;
}

export interface WeaveInput {
    assets: Asset[];
    elements: Element[];
    /** Fusion source images (data URLs) — canvas image nodes. */
    fusionImages: string[];
    /** Uploaded images marked as HERO — ad-hoc source-of-truth pixels. */
    adhocHeroImages: string[];
    /** Rotate-node views: the hero must appear from EXACTLY these angles. */
    viewpointImages?: string[];
    /** Numeric camera viewpoint from a rotate node — obeyed even without pixels. */
    viewpoint?: { azimuth: number; pitch: number };
    /** Uploaded images marked as CONCEPT — embody the idea, never copy. */
    conceptIdeas: Array<{ image: string; idea: string }>;
    /** Dimension-level extraction: take ONLY these facets of their sources. */
    facets: WeaveFacet[];
    note?: string;
    ratio: GenerationParams['ratio'];
    size?: GenerationParams['size'];
    tier: 'flash' | 'pro';
}

export async function weaveGenerate(
    input: WeaveInput,
    onStatus?: (t: string) => void
): Promise<GenerationResult> {
    const brand = await getCurrentBrand().catch(() => null);
    const soul = await getBrandSoul().catch(() => null);
    const redlines = (soul?.fields ?? []).filter(f => f.locked && f.value.trim());

    const libraryHeroImages = input.assets.flatMap(a => a.photos.slice(0, Math.ceil(8 / Math.max(1, input.assets.length))).map(p => p.image.value));
    const viewpoints = (input.viewpointImages ?? []).slice(0, 2);
    const assetImages = [...libraryHeroImages, ...input.adhocHeroImages].slice(0, 10 - viewpoints.length);
    const hasHeroes = assetImages.length > 0 || viewpoints.length > 0;
    const fusion = input.fusionImages.slice(0, hasHeroes ? 4 : 6);
    const concepts = input.conceptIdeas.slice(0, 4);
    // Facets grouped by source image — each source attached once.
    const facetGroups = new Map<string, WeaveFacet[]>();
    for (const f of input.facets) {
        facetGroups.set(f.image, [...(facetGroups.get(f.image) ?? []), f]);
    }
    const facetImages = [...facetGroups.keys()].slice(0, 4);
    const heroReminder = assetImages[0] ? [assetImages[0]] : [];

    // ---- Budget gate ----
    const model = input.tier === 'pro' ? MODELS.imagePro : MODELS.imageFlash;
    const cost = COST_ESTIMATE_USD[model] ?? 0.1;
    const month = new Date().toISOString().slice(0, 7);
    const budget = await storage.getBudget();
    const spent = await storage.getMonthSpend(month);
    if (spent + pendingSpendUsd() + cost > budget.monthlyUsd) {
        throw new BudgetExceededError(spent, budget.monthlyUsd);
    }
    const releaseBudget = reservePendingSpend(cost);

    // ---- Prompt ----
    const n = assetImages.length;
    const vpStart = n + 1;
    const fusionStart = vpStart + viewpoints.length;
    const conceptStart = fusionStart + fusion.length;
    const facetStart = conceptStart + concepts.length;
    const facetManifest = facetImages.map((img, i) => {
        const dims = (facetGroups.get(img) ?? []).map(f => f.dimension.toUpperCase()).join(' + ');
        return `Image ${facetStart + i}: FACET SOURCE — take ONLY its ${dims} as described in the DIMENSIONAL EXTRACTION section; ignore everything else about this image (subjects, objects, and all other dimensions).`;
    });
    const manifest = [
        n > 0 && `Images 1-${n}: HERO SOURCE OF TRUTH. Reconstruct the hero(es) EXACTLY and ONLY from these. Their decorative styling is disposable staging — restyle it per the direction.`,
        viewpoints.length > 0 && `Image${viewpoints.length > 1 ? `s ${vpStart}-${vpStart + viewpoints.length - 1}` : ` ${vpStart}`}: VIEWPOINT TRUTH — the user chose this exact camera angle on the hero. The hero MUST appear in the final image from EXACTLY this viewpoint (same rotation, same camera elevation). ${n > 0 ? 'Use images 1-' + n + ' only for material and detail fidelity;' : ''} the viewpoint image defines HOW the hero faces the camera.`,
        fusion.length > 0 && `Images ${fusionStart}-${fusionStart + fusion.length - 1}: FUSION SOURCES. Blend their aesthetic ideas — light behavior, palette logic, material language, mood, formal energy — into ONE new coherent image. NEVER copy their subjects, objects or composition literally.`,
        concepts.length > 0 && `Images ${conceptStart}-${conceptStart + concepts.length - 1}: CONCEPT SOURCES. Embody each one's stated idea (see CONCEPT IDEAS section); never copy its composition or subjects.`,
        ...facetManifest,
        hasHeroes && heroReminder.length > 0 && `LAST image: hero repeated as a REMINDER of what the hero must look like.`,
    ].filter(Boolean).join('\n');

    const extractionBlock = facetImages.length > 0 ? `
### DIMENSIONAL EXTRACTION (surgical borrowing — apply each faithfully) ###
${facetImages.flatMap((img, i) =>
        (facetGroups.get(img) ?? []).map(f => `- From image ${facetStart + i}, ${f.dimension.toUpperCase()}: ${f.description}`)
    ).join('\n')}` : '';

    const prompt = `You are the art director at a freeform composition canvas. Weave EVERYTHING on the board into ONE original image.

${hasHeroes ? promptBlocks.heroFidelity(input.assets, brand) : 'No hero on the board — create a pure aesthetic reference image. NO text, NO logos, NO people.'}
${input.adhocHeroImages.length > 0 ? `\nADDITIONAL HERO (uploaded directly): its photos are among images 1-${n}. Same fidelity, styling and exclusivity rules apply — reconstruct it exactly, restyle only its staging.` : ''}
${concepts.length > 0 ? `\n### CONCEPT IDEAS (one per concept source image, in order) ###\n${concepts.map((c, i) => `- Image ${conceptStart + i}: ${c.idea}`).join('\n')}` : ''}
${promptBlocks.brand(brand)}
${promptBlocks.elements(input.elements)}
${extractionBlock}
${redlines.length > 0 ? `\n### BRAND RED-LINES (never violate) ###\n${redlines.map(f => `- ${f.key}: ${f.value}`).join('\n')}` : ''}
${input.viewpoint ? `\n### CAMERA VIEWPOINT (user-selected on the 3D trackball — obey EXACTLY) ###\nShow the hero from azimuth ${Math.round(input.viewpoint.azimuth)}° (0° = the hero's front, rotating clockwise around its vertical axis) with camera elevation ${Math.round(input.viewpoint.pitch)}° (positive = camera raised, looking down). This viewpoint overrides any angle suggested by the hero photos.` : ''}
${input.note ? `\n### ART DIRECTION ###\n${input.note}` : ''}

### ATTACHED IMAGE ROLES (obey strictly) ###
${manifest || '(no images attached — work from the concepts and direction alone)'}

### REQUIREMENTS ###
One coherent, museum-grade image where every board input coexists and reinforces the others. 8k.${hasHeroes ? `
- ${subjectExclusivityRule(input.assets)}
- The hero(es) must be fully styled per the direction (dressed beds, curated surfaces); styling changes, the hero never does.
- FINAL: the hero must be pixel-faithful to its source photos.` : ''}`;

    onStatus?.(input.tier === 'pro' ? 'Weaving (pro)…' : 'Weaving (flash)…');
    let out = await generateImage({
        prompt,
        referenceImages: [...assetImages, ...viewpoints, ...fusion, ...concepts.map(c => c.image), ...facetImages, ...heroReminder],
        model,
        aspectRatio: input.ratio,
        imageSize: input.size,
    });

    // ---- Consistency inspector (pro + heroes only), surgical retry ----
    let consistency: GenerationResult['consistency'];
    if (input.tier === 'pro' && hasHeroes) {
        const check = async (img: string) => {
            const parsed = await generateJson<{ pass: boolean; issues: string[] }>(
                `The first ${Math.min(assetImages.length, 5)} attached image(s) are OFFICIAL HERO PHOTOS. The LAST attached image is AI-generated.
Check: 1) HERO FIDELITY: ${subjectInspectorCriteria(input.assets)} (ignore styling/environment); 2) EXCLUSIVITY: ${subjectExclusivityRule(input.assets)}
Output JSON: { "pass": boolean, "issues": [up to 4 concrete actionable deviations] }`,
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
                onStatus?.('Correcting the hero surgically…');
                out = await generateImage({
                    prompt: `EDIT the FIRST attached image (image-editing task). KEEP the environment, composition, light, styling and mood EXACTLY. FIX ONLY THE HERO to match the hero photos (all images after the first) with zero deviation.
Known defects:\n${first.issues.map(s => `- ${s}`).join('\n')}`,
                    referenceImages: [out.image, ...assetImages.slice(0, 6)],
                    model,
                    aspectRatio: input.ratio,
                    imageSize: input.size,
                });
                const second = await check(out.image).catch(() => (
                    // Re-check failed (network etc.) — report honestly instead of a fake pass.
                    { pass: false, issues: ['Consistency re-check failed — result unverified'] }
                ));
                consistency = { ...second, retried: true };
            }
        } catch { /* inspection is best-effort */ }
    }

    // ---- Record (Gallery / learning / training set all work) ----
    const result: GenerationResult = {
        id: crypto.randomUUID(),
        brandId: getCurrentBrandId(),
        params: {
            outputType: 'scene',
            ratio: input.ratio,
            size: input.size,
            note: input.note?.slice(0, 300),
            modelTier: input.tier,
            elementIds: input.elements.map(e => e.id),
        },
        assetIds: input.assets.map(a => a.id),
        referenceIds: [],
        elementIds: input.elements.map(e => e.id),
        appliedRuleIds: [],
        fullPrompt: prompt,
        model,
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
        usd: result.estimatedCostUsd,
        model,
        month,
        createdAt: Date.now(),
    });
    releaseBudget();
    return result;
}

// ---------------------------------------------------------------------------
// Distill approach — extract the creative strategy from a completed
// generation and persist it as knowledge rules so the brain learns.
// ---------------------------------------------------------------------------

export interface WeaveApproachContext {
    /** Board description: what nodes were connected and their content. */
    boardSummary: string;
    /** The generation result (prompt, image, params). */
    result: GenerationResult;
}

/**
 * Analyze a completed Weave generation, extract the creative approach,
 * and save actionable rules into the knowledge base for future use.
 */
export async function distillWeaveApproach(ctx: WeaveApproachContext): Promise<{ rules: KnowledgeRule[]; summary: string }> {
    const brand = await getCurrentBrand().catch(() => null);
    const existingRules = await storage.listRules();

    const prompt = `You are a brand art director extracting REUSABLE creative rules from a successful image generation session.

BRAND: "${brand?.name ?? 'the brand'}" — ${brand?.description ?? 'a hero brand'}

### BOARD COMPOSITION (what the user assembled) ###
${ctx.boardSummary}

### FULL GENERATION PROMPT (what was sent to the model) ###
${ctx.result.fullPrompt.slice(0, 3000)}

### EXISTING RULES (do not duplicate) ###
${existingRules.slice(0, 30).map(r => `- [${r.polarity}] ${r.rule}`).join('\n') || '(none)'}

### TASK ###
Analyze the attached generated image together with the board composition and prompt. Extract 2-5 ACTIONABLE creative rules that capture the approach's key insights — what made this image work. Rules must be:
1. Concrete and promptable (usable inside a future image prompt)
2. Generalizable beyond this specific scene (not tied to one hero)
3. Non-redundant with existing rules
4. Scoped appropriately (scene / silo / general)

Also provide a one-line summary of the overall creative approach.

Output JSON: {
  "summary": "one line describing the overall creative approach",
  "rules": [
    { "rule": "imperative directive", "polarity": "must", "scope": { "outputType"?: "scene"|"silo" }, "rationale": "why this matters" }
  ]
}`;

    const parsed = await generateJson<{
        summary: string;
        rules: Array<{ rule: string; polarity: 'must' | 'avoid'; scope?: { outputType?: string }; rationale?: string }>;
    }>(prompt, [ctx.result.image.value]);

    const summary = String(parsed?.summary ?? 'Approach distilled.').trim();
    const now = Date.now();
    const brandId = getCurrentBrandId();
    const savedRules: KnowledgeRule[] = [];

    for (const r of (parsed?.rules ?? []).slice(0, 5)) {
        if (!r.rule?.trim()) continue;
        const rule: KnowledgeRule = {
            id: crypto.randomUUID(),
            brandId,
            scope: { outputType: r.scope?.outputType as any },
            rule: r.rule.trim(),
            polarity: r.polarity === 'avoid' ? 'avoid' : 'must',
            confidence: 1,
            sources: [ctx.result.id],
            enabled: true,
            createdAt: now,
            updatedAt: now,
        };
        await storage.upsertRule(rule);
        savedRules.push(rule);
    }

    return { rules: savedRules, summary };
}
