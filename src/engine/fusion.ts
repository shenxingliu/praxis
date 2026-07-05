import { Element, Reference } from '../domain/types';
import { storage } from '../storage/local';
import { getCurrentBrand, getCurrentBrandId } from '../domain/brand';
import { getBrandSoul } from '../brain/soul';
import { generateImage, generateJson, MODELS } from './gemini';
import { decomposeReference } from './decompose';

/**
 * Fusion Lab — the self-breeding aesthetic loop.
 *
 *   pick concept cards (across references, lenses, generations)
 *   → choose the TRANSFER LEVEL (percept / principle / concept / worldview)
 *   → synthesize a brand-new PURE AESTHETIC reference (no product)
 *   → red-line check vs locked soul fields
 *   → keep → enters the library as source 'synthesized', gen N+1
 *   → gets decomposed like any reference — new vocabulary for the next round
 *
 * Crossover (recombination) + mutation (wildcard) + selection (your verdicts
 * and adoption) = an aesthetic evolution system whose fitness function is
 * the owner's taste. Guards: generation tags, red-line gate, flash-model
 * economics, low starting weight.
 */

export type TransferLevel = 'percept' | 'principle' | 'concept' | 'worldview';

export const LEVEL_LABEL: Record<TransferLevel, string> = {
    percept: 'L1 Percept — imitate the surface',
    principle: 'L2 Principle — reuse the mechanism',
    concept: 'L3 Concept — transfer the idea',
    worldview: 'L4 Worldview — keep only the belief',
};

const levelText = (e: Element, level: TransferLevel): string => {
    switch (level) {
        case 'percept': return e.description;
        case 'principle': return e.principle ?? e.description;
        case 'concept': return `${e.concept} — ${e.analysis || e.description}`;
        case 'worldview': return e.worldview ?? e.concept;
    }
};

export interface FusionDraft {
    image: string; // data URL
    prompt: string;
    sourceRefIds: string[];
    generation: number;
    redline?: { pass: boolean; note: string };
}

export async function synthesizeReference(
    elements: Element[],
    level: TransferLevel,
    note?: string,
    onStatus?: (t: string) => void
): Promise<FusionDraft> {
    if (elements.length < 2) throw new Error('Pick at least 2 concept cards to fuse.');
    const brand = await getCurrentBrand();
    const refs = await storage.listReferences();

    // Source pixels carry visual DNA (up to 4, only at percept/principle —
    // at concept/worldview level the model must NOT see the sources, or it
    // will imitate instead of create).
    const sourceRefIds = [...new Set(elements.map(e => e.sourceRefId))];
    const attachSources = level === 'percept' || level === 'principle';
    const sourceImages = attachSources
        ? sourceRefIds
            .map(id => refs.find(r => r.id === id && r.image.kind === 'data'))
            .filter((r): r is Reference => !!r)
            .slice(0, 4)
            .map(r => r.image.value)
        : [];

    const generation = Math.max(0, ...sourceRefIds.map(id => refs.find(r => r.id === id)?.generation ?? 0)) + 1;

    const prompt = `Create a single, original AESTHETIC REFERENCE IMAGE for the brand "${brand.name}" — ${brand.description}

This is NOT a product shot. NO product, NO furniture staging requirement, NO text, NO logos. It is a pure piece of visual language — a mood/world the brand could live in.

### FUSE THESE IDEAS (transfer level: ${LEVEL_LABEL[level]}) ###
${elements.map((e, i) => `${i + 1}. [${e.type}] ${levelText(e, level)}`).join('\n')}

${attachSources && sourceImages.length > 0
        ? 'The attached images are the SOURCES of these ideas — inherit their visual DNA where the ideas demand it, but the composition must be NEW, not a collage or copy.'
        : 'Do not imitate any existing image — realize the ideas from first principles. The more the result surprises while still obeying every idea, the better.'}
${note ? `\nArt direction: ${note}` : ''}

### REQUIREMENTS ###
One coherent image where ALL the fused ideas coexist and reinforce each other. Museum-grade art direction, 8k.`;

    onStatus?.('Synthesizing (flash)…');
    const out = await generateImage({
        prompt,
        referenceImages: sourceImages,
        model: MODELS.imageFlash,
        aspectRatio: '4:3',
    });

    // Red-line gate: score only against LOCKED soul fields.
    let redline: FusionDraft['redline'];
    const soul = await getBrandSoul().catch(() => null);
    const locked = (soul?.fields ?? []).filter(f => f.locked && f.value.trim());
    if (locked.length > 0) {
        onStatus?.('Red-line check…');
        try {
            const check = await generateJson<{ pass: boolean; note: string }>(
                `The attached image is a candidate aesthetic reference for "${brand.name}". Check it ONLY against these brand red-lines:
${locked.map(f => `- ${f.key}: ${f.value}`).join('\n')}

Output JSON: { "pass": boolean (true if NO red-line is violated), "note": one sentence — which red-line is at risk, or why it passes }`,
                [out.image]
            );
            redline = { pass: !!check?.pass, note: String(check?.note ?? '') };
        } catch { /* check is best-effort */ }
    }

    return { image: out.image, prompt, sourceRefIds, generation, redline };
}

/** Keep a fusion draft: enters the library (low weight) and gets decomposed. */
export async function keepFusion(
    draft: FusionDraft,
    name: string,
    onStatus?: (t: string) => void
): Promise<Reference> {
    const ref: Reference = {
        id: crypto.randomUUID(),
        brandId: getCurrentBrandId(),
        kind: 'style',
        name: name || `Fusion gen${draft.generation}`,
        image: { kind: 'data', value: draft.image },
        tags: ['fusion', `gen${draft.generation}`],
        source: 'synthesized',
        weight: 0.7, // earns its place through adoption, not by birth
        createdAt: Date.now(),
        generation: draft.generation,
    };
    await storage.upsertReference(ref);
    onStatus?.('Decomposing the newborn…');
    try { await decomposeReference(ref); } catch (err) { console.warn('[fusion] decompose failed:', err); }
    return ref;
}
