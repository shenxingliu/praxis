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
 * across contexts, heroes and even realisms.
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

    // Dedupe at the source: the model sees what the library already knows
    // and only extracts what is NEW — keeps the library lean by construction.
    const existing = (await storage.listElements()).filter(e => e.enabled);
    const existingBlock = existing.length > 0
        ? `\n### ALREADY IN THE LIBRARY (do NOT re-extract these or near-duplicates — only concepts meaningfully DIFFERENT from all of them) ###\n${existing.slice(0, 60).map(e => `- [${e.type}] ${e.concept}`).join('\n')}\n`
        : '';

    const prompt = `You are the CREATIVE DIRECTOR of a design studio${brand ? ` working for "${brand.name}" — ${brand.description}` : ''}.
${existingBlock}
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

Extract AT MOST 1-2 concepts per lens (3-6 total), and FEWER is better: only what is genuinely distinctive about THIS image and absent from the library. If the image adds nothing new to a lens, return nothing for that lens.

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

/** Re-decompose ONE reference: wipe its old concepts, extract fresh. */
export async function redecomposeReference(ref: Reference): Promise<Element[]> {
    const all = await storage.listElements();
    for (const el of all.filter(e => e.sourceRefId === ref.id)) {
        await storage.deleteElement(el.id);
    }
    return decomposeReference(ref);
}

/**
 * Rebuild the whole library from scratch: wipe every concept, re-decompose
 * every inline reference sequentially (the dedupe-aware prompt keeps the
 * result lean by construction), then auto-curate if it still grew fat.
 * Zero manual selection required.
 */
export async function rebuildLibrary(
    onStatus?: (text: string) => void
): Promise<{ refs: number; elements: number; curated: number }> {
    onStatus?.('Wiping old concepts…');
    for (const el of await storage.listElements()) {
        await storage.deleteElement(el.id);
    }
    const refs = (await storage.listReferences())
        .filter(r => !!r.image.value && r.source !== 'promoted');
    let total = 0;
    for (let i = 0; i < refs.length; i++) {
        onStatus?.(`Decomposing ${i + 1}/${refs.length}: ${refs[i].name}…`);
        try {
            total += (await decomposeReference(refs[i])).length;
        } catch (err) {
            console.warn('[rebuild] failed for', refs[i].name, err);
        }
    }
    let curated = 0;
    if (total > 40) {
        onStatus?.('Auto-curating…');
        try { curated = (await curateLibrary()).disabled; } catch { /* best-effort */ }
    }
    return { refs: refs.length, elements: total, curated };
}

/**
 * Curator agent — one pass over the whole library:
 * merges near-duplicates (keeps the strongest wording, disables the rest)
 * and disables generic concepts that would apply to any brand's imagery.
 * Nothing is deleted — you can re-enable anything by hand.
 */
export async function curateLibrary(): Promise<{ disabled: number; kept: number; note: string }> {
    const all = (await storage.listElements()).filter(e => e.enabled);
    if (all.length < 6) return { disabled: 0, kept: all.length, note: 'Library too small to curate.' };
    const brand = await getCurrentBrand().catch(() => null);

    const parsed = await generateJson<{ disableIds: string[]; note: string }>(
        `You are the LIBRARIAN of a design studio${brand ? ` for "${brand.name}" — ${brand.description}` : ''}. Curate this concept library down to a sharp working vocabulary.

### LIBRARY ###
${all.map(e => `- id=${e.id} [${e.type}] (w${e.weight}) "${e.concept}" — ${e.description.slice(0, 100)}`).join('\n')}

### RULES ###
1. Near-duplicates: keep ONE per cluster — the sharpest, most transferable wording (prefer higher weight) — disable the others.
2. Generic filler: disable concepts that would be true of almost any decent brand image ("clean composition", "soft natural light" with no specific twist).
3. Never disable more than half the library. When in doubt, keep.

Output JSON: { "disableIds": [ids to disable], "note": one sentence summarizing what you pruned }`
    );

    const valid = new Set(all.map(e => e.id));
    const toDisable = (parsed?.disableIds ?? []).filter(id => valid.has(id)).slice(0, Math.floor(all.length / 2));
    for (const id of toDisable) {
        const el = all.find(e => e.id === id)!;
        await storage.upsertElement({ ...el, enabled: false });
    }
    return { disabled: toDisable.length, kept: all.length - toDisable.length, note: String(parsed?.note ?? '') };
}

/** Decompose every not-yet-decomposed inline reference of the brand. */
export async function decomposeAllPending(
    onStatus?: (text: string) => void
): Promise<{ refs: number; elements: number }> {
    const refs = (await storage.listReferences())
        .filter(r => !r.decomposed && !!r.image.value && r.source === 'upload');
    let total = 0;
    for (let i = 0; i < refs.length; i++) {
        onStatus?.(`Decomposing ${i + 1}/${refs.length}: ${refs[i].name}…`);
        try {
            total += (await decomposeReference(refs[i])).length;
        } catch (err) {
            console.warn('[decompose] failed for', refs[i].name, err);
        }
    }
    // Anti-hoarding: if the library got fat, auto-curate without asking.
    try {
        const enabled = (await storage.listElements()).filter(e => e.enabled);
        if (enabled.length > 40) {
            onStatus?.('Auto-curating…');
            await curateLibrary();
        }
    } catch { /* best-effort */ }
    return { refs: refs.length, elements: total };
}
