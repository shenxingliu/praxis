import { Element, Reference } from '../domain/types';
import { storage } from '../storage/local';
import { getCurrentBrand, getCurrentBrandId, brandKey } from '../domain/brand';
import { getBrandSoul, getFieldAttributions } from '../brain/soul';
import { generateImage, generateJson, MODELS } from './gemini';

/**
 * Fusion Lab — the self-breeding aesthetic loop.
 *
 *   pick concept cards (across references, lenses, generations)
 *   → choose the TRANSFER LEVEL (percept / principle / concept / worldview)
 *   → synthesize a brand-new PURE AESTHETIC reference (no hero)
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

// ---------------------------------------------------------------------------
// Fusion memory — EVERY verdict (keep AND discard) is recorded and fed back
// to the curator. Discards nudge the used concepts' weights down slightly;
// keeps nudge up. This is the fitness function actually being written down.
// ---------------------------------------------------------------------------

export interface FusionVerdict {
    verdict: 'keep' | 'discard';
    concepts: string[];      // concept titles used
    elementIds: string[];
    level: TransferLevel;
    generation: number;
    createdAt: number;
}

export async function recordFusionVerdict(
    draft: FusionDraft,
    elements: Element[],
    level: TransferLevel,
    verdict: 'keep' | 'discard',
    /** For reference-direct fusions (no concept cards): the ref names. */
    refNames: string[] = []
): Promise<void> {
    const v: FusionVerdict = {
        verdict,
        concepts: elements.length > 0 ? elements.map(e => e.concept) : refNames,
        elementIds: elements.map(e => e.id),
        level,
        generation: draft.generation,
        createdAt: Date.now(),
    };
    const hist = (await storage.kvGet<FusionVerdict[]>(brandKey('fusionVerdicts'))) ?? [];
    await storage.kvSet(brandKey('fusionVerdicts'), [...hist, v].slice(-100));

    // Gentle weight nudge — half the strength of a real adoption signal,
    // because a discard often blames the render, not the concepts.
    const delta = verdict === 'keep' ? 0.05 : -0.05;
    for (const el of elements) {
        await storage.upsertElement({
            ...el,
            weight: Math.max(0.1, Math.round((el.weight + delta) * 100) / 100),
        }).catch(() => {});
    }
}

export async function getFusionVerdicts(): Promise<FusionVerdict[]> {
    return (await storage.kvGet<FusionVerdict[]>(brandKey('fusionVerdicts'))) ?? [];
}

// ---------------------------------------------------------------------------
// Auto-Fuse — the curator picks the combination, scored for PRODUCTIVE
// TENSION (not similarity): concepts that rub against each other in ways
// the brand would recognize as its own. Removes the manual-picking burden.
// ---------------------------------------------------------------------------

export interface FusionCombo {
    title: string;
    why: string;
    refIds: string[];
    level: TransferLevel;
    /** One deliberately foreign twist injected for creativity. */
    provocation?: string;
}

/** The curator LOOKS at the reference images themselves (up to 8, newest
 *  first) and proposes combinations — no concept library required. */
export async function proposeCombos(intent?: string, candidateRefs?: Reference[]): Promise<FusionCombo[]> {
    const all = (candidateRefs && candidateRefs.length > 0
        ? candidateRefs
        : await storage.listReferences()
    ).filter(r => r.image.kind === 'data');
    if (all.length < 3) throw new Error('Need at least 3 references to propose fusions — upload more.');
    const pool = [...all].sort((a, b) => (b.weight - a.weight) || (b.createdAt - a.createdAt)).slice(0, 8);
    const brand = await getCurrentBrand();
    const soul = await getBrandSoul().catch(() => null);
    const recentDislikes = (await getFieldAttributions().catch(() => []))
        .slice(-3).map(a => a.reason);

    // Fusion memory: the curator sees what you kept and what you threw away.
    const verdicts = (await getFusionVerdicts().catch(() => [])).slice(-12);
    const kept = verdicts.filter(v => v.verdict === 'keep');
    const discarded = verdicts.filter(v => v.verdict === 'discard');
    const memoryBlock = verdicts.length > 0 ? `
### FUSION HISTORY (the owner's actual verdicts — learn from them) ###
${kept.length > 0 ? `KEPT: ${kept.map(v => `[${v.level}] ${v.concepts.map(c => `“${c}”`).join('×')}`).join(' ; ')}` : ''}
${discarded.length > 0 ? `DISCARDED: ${discarded.map(v => `[${v.level}] ${v.concepts.map(c => `“${c}”`).join('×')}`).join(' ; ')}` : ''}
Favor the patterns behind KEPT combos; do not repeat DISCARDED combinations or close variants of them.
` : '';

    const parsed = await generateJson<{ combos: Array<Record<string, unknown>> }>(
        `You are the CURATOR of a design studio's reference collection, working for "${brand.name}" — ${brand.description}
${intent ? `\nThe owner's intent right now: ${intent}\n` : ''}
### REFERENCE POOL (the ${pool.length} attached images, numbered in order) ###
${pool.map((r, i) => `${i + 1}. "${r.name}"${r.source === 'synthesized' ? ` (fusion gen${r.generation ?? 1})` : ''} (w${r.weight})`).join('\n')}

### BRAND SOUL (locked = untouchable) ###
${(soul?.fields ?? []).filter(f => f.value.trim()).slice(0, 10).map(f => `${f.key}${f.locked ? ' [LOCKED]' : ''}: ${f.value.slice(0, 80)}`).join('\n') || '(none yet)'}
${recentDislikes.length > 0 ? `\n### RECENT COMPLAINTS (avoid these failure modes) ###\n${recentDislikes.map(r => `- ${r}`).join('\n')}` : ''}
${memoryBlock}
### TASK ###
Study the attached images, then propose exactly 3 fusion combinations. Selection criteria, in order:
1. PRODUCTIVE TENSION — images whose visual worlds resist each other interestingly. Never pick images because they are similar; similar + similar = wallpaper.
2. COMPLEMENTARY STRENGTHS — combine what each image is uniquely best at (one's light, another's formal language, another's attitude).
3. Weight-aware — favor rising references (w>1), but each combo may include ONE sleeper as a dark horse.
Make the three combos genuinely different strategies: one SAFE-ADJACENT (closest to current soul), one TENSION-FORWARD, one WILD (still inside locked red-lines).

For each combo:
- title: 3-5 words
- why: 1-2 sentences — name the tension and why the brand would recognize the result as its own
- refNumbers: 2-4 image numbers from the pool above
- level: percept | principle | concept | worldview (higher = more creative freedom; match the combo's strategy)
- provocation: optional — ONE deliberately foreign art-direction twist, max 12 words (e.g. "shot as if underwater", "colors of an overexposed Polaroid")

Output JSON: { "combos": [ { "title", "why", "refNumbers", "level", "provocation" } ] }`,
        pool.map(r => r.image.value)
    );

    const levels: TransferLevel[] = ['percept', 'principle', 'concept', 'worldview'];
    return (parsed?.combos ?? []).slice(0, 3).map(c => ({
        title: String(c.title ?? 'Combo'),
        why: String(c.why ?? ''),
        refIds: (Array.isArray(c.refNumbers) ? c.refNumbers : [])
            .map((n: unknown) => pool[Number(n) - 1]?.id)
            .filter((id: string | undefined): id is string => !!id),
        level: levels.includes(c.level as TransferLevel) ? c.level as TransferLevel : 'concept',
        provocation: c.provocation ? String(c.provocation) : undefined,
    })).filter(c => c.refIds.length >= 2);
}

export interface FusionDraft {
    image: string; // data URL
    prompt: string;
    sourceRefIds: string[];
    elementIds: string[];
    level: TransferLevel;
    generation: number;
    redline?: { pass: boolean; note: string };
}

export async function synthesizeReference(
    elements: Element[],
    level: TransferLevel,
    note?: string,
    onStatus?: (t: string) => void,
    /** References fused DIRECTLY (no pre-decomposition): ONE call derives
     *  each image's strongest idea at the transfer level and fuses — the
     *  token-cheap path that needs no concept library at all. */
    refsToFuse: Reference[] = []
): Promise<FusionDraft> {
    if (elements.length + refsToFuse.length < 2) throw new Error('Pick at least 2 items (concept cards and/or references) to fuse.');
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

    const refFuseImages = refsToFuse
        .filter(r => r.image.kind === 'data')
        .slice(0, 4)
        .map(r => r.image.value);
    const allRefIds = [...new Set([...sourceRefIds, ...refsToFuse.map(r => r.id)])];
    const generation = Math.max(0, ...allRefIds.map(id => refs.find(r => r.id === id)?.generation ?? 0)) + 1;

    const prompt = `Create a single, original AESTHETIC REFERENCE IMAGE for the brand "${brand.name}" — ${brand.description}

This is NOT a hero shot. NO hero, NO furniture staging requirement, NO text, NO logos. It is a pure piece of visual language — a mood/world the brand could live in.

### FUSE THESE IDEAS (transfer level: ${LEVEL_LABEL[level]}) ###
${elements.map((e, i) => `${i + 1}. [${e.type}] ${levelText(e, level)}`).join('\n') || '(no concept cards — all ideas come from the attached reference images)'}
${refFuseImages.length > 0 ? `
### AND FUSE THE ATTACHED REFERENCE IMAGE${refFuseImages.length > 1 ? 'S' : ''} (the last ${refFuseImages.length} attached) ###
For EACH of them, first silently derive its single strongest transferable idea at the same transfer level, then fuse those derived ideas together with the listed ones. ${level === 'percept' || level === 'principle'
        ? 'Their surface behavior may be inherited where the ideas demand it, but the composition must be NEW — never a collage or copy.'
        : 'Do NOT copy their compositions or subjects — transfer only the derived ideas.'}` : ''}
${attachSources && sourceImages.length > 0
        ? `The first ${sourceImages.length} attached image${sourceImages.length > 1 ? 's are' : ' is'} the SOURCE of the listed ideas — inherit visual DNA where the ideas demand it, but the composition must be NEW, not a collage or copy.`
        : refFuseImages.length === 0 ? 'Do not imitate any existing image — realize the ideas from first principles. The more the result surprises while still obeying every idea, the better.' : ''}
${note ? `\nArt direction: ${note}` : ''}

### REQUIREMENTS ###
One coherent image where ALL the fused ideas coexist and reinforce each other. Museum-grade art direction, 8k.`;

    onStatus?.('Synthesizing (flash)…');
    const out = await generateImage({
        prompt,
        referenceImages: [...sourceImages, ...refFuseImages],
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

    return {
        image: out.image, prompt, sourceRefIds: allRefIds,
        elementIds: elements.map(e => e.id), level,
        generation, redline,
    };
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
    // No auto-decomposition: the newborn is immediately fusable as a raw
    // reference; mine concepts from it explicitly (Decomp) only if wanted.
    void onStatus;
    return ref;
}
