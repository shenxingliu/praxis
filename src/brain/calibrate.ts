import { storage } from '../storage/local';
import { brandKey } from '../domain/brand';
import { getBrandSoul, saveBrandSoul } from './soul';
import { generateJson } from '../engine/gemini';

/**
 * Taste calibration — the cold-start game.
 * Show two existing images ("which is more us?"), collect picks, then ONE
 * batched vision call turns preferences into concrete soul refinements.
 * No generation cost: pairs come from references + past results.
 */

export interface TastePick {
    winnerId: string;
    loserId: string;
    createdAt: number;
}

export interface TasteCandidate {
    id: string;
    image: string; // data URL
}

export async function getCandidatePool(): Promise<TasteCandidate[]> {
    const [refs, results] = await Promise.all([
        storage.listReferences(),
        storage.listResults(100),
    ]);
    const pool: TasteCandidate[] = [
        ...refs.filter(r => r.image.kind === 'data').map(r => ({ id: `ref:${r.id}`, image: r.image.value })),
        ...results.filter(r => r.image.kind === 'data').map(r => ({ id: `res:${r.id}`, image: r.image.value })),
    ];
    // Shuffle
    for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool;
}

export async function recordPick(pick: TastePick): Promise<void> {
    const picks = (await storage.kvGet<TastePick[]>(brandKey('tastePicks'))) ?? [];
    await storage.kvSet(brandKey('tastePicks'), [...picks, pick].slice(-200));
}

/**
 * Batch analysis: up to 4 preferred + 4 rejected images in one vision call.
 * Refines UNLOCKED sensation/viewing soul fields to match the taste; locked
 * fields and the narrative axis are never touched by the game.
 */
export async function analyzeTaste(
    winnerImages: string[],
    loserImages: string[]
): Promise<{ summary: string; refined: number }> {
    const soul = await getBrandSoul();
    if (!soul) throw new Error('Derive the brand soul first (Brain → Brand Soul).');

    const editable = soul.fields.filter(f =>
        !f.locked && (f.axis === 'sensation' || f.axis === 'viewing'));

    const w = winnerImages.slice(0, 4);
    const l = loserImages.slice(0, 4);
    const prompt = `You are calibrating a brand's visual taste. The first ${w.length} attached image(s) were PREFERRED by the brand owner; the following ${l.length} were REJECTED in direct comparisons.

### CURRENT SOUL FIELDS (editable) ###
${editable.map(f => `- ${f.key}: ${f.value}`).join('\n')}

### TASK ###
From what visually separates preferred from rejected, refine the fields that need it. Keep each value concrete and promptable; change ONLY fields where the preference evidence is clear (typically 2-5 fields). Also write a 2-3 sentence summary of the owner's taste in plain language.

Output JSON: { "refinements": [ { "key": string, "value": string } ], "summary": string }`;

    const parsed = await generateJson<{ refinements: Array<{ key: string; value: string }>; summary: string }>(
        prompt, [...w, ...l]
    );
    const editableKeys = new Set(editable.map(f => f.key));
    const refinements = (parsed?.refinements ?? []).filter(r => editableKeys.has(r.key) && r.value?.trim());

    if (refinements.length > 0) {
        const byKey = new Map(refinements.map(r => [r.key, r.value.trim()]));
        const fields = soul.fields.map(f =>
            byKey.has(f.key)
                ? { ...f, value: byKey.get(f.key)!, rationale: 'Refined by taste calibration' }
                : f);
        await saveBrandSoul({ ...soul, fields });
    }
    return { summary: String(parsed?.summary ?? ''), refined: refinements.length };
}
