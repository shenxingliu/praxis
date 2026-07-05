import { GenerationParams, GenerationResult } from '../domain/types';
import { storage } from '../storage/local';
import { brandKey } from '../domain/brand';
import { generate } from './engine';

/**
 * Quick presets — "same look, different product".
 * A preset freezes everything about an approved generation EXCEPT the
 * product: params (context mode, purpose, note, camera…), the concept
 * cards, and the approved image itself as a STYLE ANCHOR whose pixels
 * lead the mood (the image-role manifest keeps product truth separate).
 *
 * Quick flow is two-step by design: DRAFT (flash, cheap) → EXECUTE (pro).
 */

export interface QuickPreset {
    id: string;
    name: string;
    params: GenerationParams;
    elementIds: string[];
    /** The approved image — attached as mood anchor on every quick run. */
    anchorImage: string;
    createdAt: number;
}

const KEY = () => brandKey('presets');

export async function listPresets(): Promise<QuickPreset[]> {
    return (await storage.kvGet<QuickPreset[]>(KEY())) ?? [];
}

export async function savePreset(
    name: string,
    params: GenerationParams,
    elementIds: string[],
    anchorImage: string
): Promise<QuickPreset> {
    const preset: QuickPreset = {
        id: crypto.randomUUID(),
        name,
        params: { ...params },
        elementIds,
        anchorImage,
        createdAt: Date.now(),
    };
    const all = await listPresets();
    await storage.kvSet(KEY(), [...all, preset].slice(-30)); // keep the last 30
    return preset;
}

export async function deletePreset(id: string): Promise<void> {
    const all = await listPresets();
    await storage.kvSet(KEY(), all.filter(p => p.id !== id));
}

/** Run a preset with new products. tier 'flash' = draft, 'pro' = final. */
export async function runPreset(
    preset: QuickPreset,
    assetIds: string[],
    overrides: Partial<Pick<GenerationParams, 'ratio' | 'size' | 'note'>>,
    tier: 'flash' | 'pro',
    onStatus?: (t: string) => void
): Promise<GenerationResult> {
    const params: GenerationParams = {
        ...preset.params,
        ...overrides,
        elementIds: preset.elementIds,
        modelTier: tier,
    };
    return generate(params, assetIds, onStatus, [preset.anchorImage]);
}
