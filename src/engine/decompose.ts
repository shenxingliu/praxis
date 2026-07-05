import { Element, ElementType, Reference } from '../domain/types';
import { storage } from '../storage/local';
import { getCurrentBrand, getCurrentBrandId } from '../domain/brand';
import { generateJson } from './gemini';

/**
 * Decomposition agent — the "creative director's eye".
 *
 * A reference image is not read as a photographic checklist (light, props,
 * palette) but analyzed through THREE LENSES into abstract, transferable
 * concept cards:
 *
 *   VISUAL         the formal language — tension, rhythm, geometry, scale,
 *                  emptiness/density, how the frame is organized as form
 *   FEELING        the emotional/atmospheric essence — what it feels like
 *                  to stand inside this image
 *   COMMUNICATION  what the image argues — the claim it makes, the value
 *                  it asserts, what it says without words
 *
 * Each concept carries a concrete MANIFESTATION so generation still gets
 * something obeyable. Abstraction is what makes recombination transferable
 * across contexts, products and even realisms.
 */

const LENSES: ElementType[] = ['visual', 'feeling', 'communication'];

/** Which N/S/I soul axes each lens informs (for feedback attribution). */
const NSI_OF_LENS: Record<ElementType, string[]> = {
    visual: ['viewing.gaze_path', 'viewing.first_impression', 'sensation.meta'],
    feeling: ['sensation.atmosphere', 'sensation.light', 'sensation.palette'],
    communication: ['narrative.voice', 'narrative.position', 'narrative.truth_claim'],
};

interface RawConcept {
    lens: string;
    concept: string;
    analysis: string;
    manifestation: string;
    principle?: string;
    worldview?: string;
}

export async function decomposeReference(ref: Reference): Promise<Element[]> {
    if (ref.image.kind !== 'data') throw new Error('Only inline images can be decomposed.');
    const brand = await getCurrentBrand().catch(() => null);

    const prompt = `You are the CREATIVE DIRECTOR of a design studio${brand ? ` working for "${brand.name}" — ${brand.description}` : ''}.
Decompose the attached reference image into ABSTRACT, TRANSFERABLE CONCEPTS — not photographic facts. A concept must be an idea that could be re-applied to a completely different subject, context, or even level of realism.

Analyze through three lenses:
- visual: the formal language. How the frame works as pure form — tension, rhythm, geometry, negative space, scale relationships, visual hierarchy. NOT "warm side light" but e.g. "weight resting on emptiness".
- feeling: the emotional/atmospheric essence. What it feels like to inhabit this image. E.g. "the stillness after rain", "unhurried morning privacy".
- communication: what the image ARGUES without words. The claim, the value assertion. E.g. "craft is a moral position", "luxury as restraint, not display".

For each concept output the FULL ABSTRACTION LADDER:
- lens: visual | feeling | communication
- concept: L3 — the abstract idea, 2-6 words, transferable to any subject
- analysis: 1-2 sentences — why/how it works through this lens
- manifestation: L1 percept — 1-2 sentences, how to CONCRETELY realize this concept (promptable: composition moves, light behavior, color logic)
- principle: L2 — the formal principle at work, one sentence (e.g. "a single light source creates hierarchy")
- worldview: L4 — the belief the image asserts, under 8 words (e.g. "truth needs shadow")

Transferring at L1 is imitation; transferring at L3/L4 is creation — make every rung genuinely different in abstraction.

Extract 2-3 concepts per lens (6-9 total). Only what is genuinely distinctive — skip generic observations.

Output JSON: { "elements": [ { "lens", "concept", "analysis", "manifestation", "principle", "worldview" } ] }`;

    const parsed = await generateJson<{ elements: RawConcept[] }>(prompt, [ref.image.value]);
    const now = Date.now();
    const elements: Element[] = (parsed?.elements ?? [])
        .filter(e => LENSES.includes(e.lens as ElementType) && e.concept?.trim() && e.manifestation?.trim())
        .map(e => ({
            id: crypto.randomUUID(),
            brandId: getCurrentBrandId(),
            type: e.lens as ElementType,
            concept: e.concept.trim(),
            analysis: (e.analysis ?? '').trim(),
            description: e.manifestation.trim(),
            principle: e.principle?.trim() || undefined,
            worldview: e.worldview?.trim() || undefined,
            sourceRefId: ref.id,
            nsiKeys: NSI_OF_LENS[e.lens as ElementType] ?? [],
            weight: 1,
            enabled: true,
            createdAt: now,
        }));

    for (const el of elements) await storage.upsertElement(el);
    await storage.upsertReference({ ...ref, decomposed: true });
    return elements;
}

/** Decompose every not-yet-decomposed inline reference of the brand. */
export async function decomposeAllPending(
    onStatus?: (text: string) => void
): Promise<{ refs: number; elements: number }> {
    const refs = (await storage.listReferences())
        .filter(r => !r.decomposed && r.image.kind === 'data' && r.source === 'upload');
    let total = 0;
    for (let i = 0; i < refs.length; i++) {
        onStatus?.(`Decomposing ${i + 1}/${refs.length}: ${refs[i].name}…`);
        try {
            total += (await decomposeReference(refs[i])).length;
        } catch (err) {
            console.warn('[decompose] failed for', refs[i].name, err);
        }
    }
    return { refs: refs.length, elements: total };
}
