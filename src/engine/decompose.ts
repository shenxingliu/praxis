import { Element, ElementType, Reference } from '../domain/types';
import { storage } from '../storage/local';
import { getCurrentBrand, getCurrentBrandId } from '../domain/brand';
import { generateJson } from './gemini';

/**
 * Decomposition agent — the "art director's eye".
 *
 * A reference image is not a black-box style blob: it gets decomposed into
 * 4-8 reusable semantic ELEMENTS (light / palette / composition / material
 * / mood / setting / prop / style), each promptable on its own and traced
 * back to its source pixels. Generation then recombines: "this image's
 * light + that image's palette + the product".
 */

const ELEMENT_TYPES: ElementType[] = [
    'light', 'palette', 'composition', 'material', 'mood', 'setting', 'prop', 'style',
];

/** Which N/S/I soul fields each element type informs (for attribution). */
const NSI_OF_TYPE: Record<ElementType, string[]> = {
    light: ['sensation.light'],
    palette: ['sensation.palette'],
    composition: ['viewing.gaze_path', 'viewing.first_impression'],
    material: ['sensation.tactile_implied'],
    mood: ['sensation.atmosphere'],
    setting: ['narrative.genre', 'sensation.atmosphere'],
    prop: ['narrative.genre'],
    style: ['narrative.cultural_lineage', 'narrative.temporality'],
};

interface RawElement {
    type: string;
    description: string;
}

export async function decomposeReference(ref: Reference): Promise<Element[]> {
    if (ref.image.kind !== 'data') throw new Error('Only inline images can be decomposed.');
    const brand = await getCurrentBrand().catch(() => null);

    const prompt = `You are the art director of a design studio${brand ? ` working for "${brand.name}" — ${brand.description}` : ''}.
Decompose the attached reference image into REUSABLE VISUAL ELEMENTS a generation model can apply independently to other images.

For each element:
- type: one of ${ELEMENT_TYPES.join(' | ')}
- description: 1-2 sentences, CONCRETE and promptable (specific hues, light direction and quality, named materials, compositional geometry). Never vague ("nice light" ✗; "low-angle warm golden side light casting long soft shadows, dust motes visible" ✓).

Extract 4-8 elements — only what is genuinely distinctive and transferable. Skip generic observations.

Output JSON: { "elements": [ { "type": string, "description": string } ] }`;

    const parsed = await generateJson<{ elements: RawElement[] }>(prompt, [ref.image.value]);
    const now = Date.now();
    const elements: Element[] = (parsed?.elements ?? [])
        .filter(e => ELEMENT_TYPES.includes(e.type as ElementType) && e.description?.trim())
        .map(e => ({
            id: crypto.randomUUID(),
            brandId: getCurrentBrandId(),
            type: e.type as ElementType,
            description: e.description.trim(),
            sourceRefId: ref.id,
            nsiKeys: NSI_OF_TYPE[e.type as ElementType] ?? [],
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
