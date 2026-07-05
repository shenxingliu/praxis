import { storage } from '../storage/local';
import { getCurrentBrand, brandKey } from '../domain/brand';
import { generateJson, appApiHeaders } from '../engine/gemini';

/**
 * Brand Soul — the persistent N/S/I semantic baseline, per brand.
 * Ported from Lumina V1.3 (proven in production), generalized: no domain
 * words in the schema; the brand's own description drives derivation.
 *
 * Axes:
 *   narrative  — what the image says
 *   sensation  — what happens in the viewer's senses
 *   viewing    — how the image and the viewer relate over time
 */

export type SoulAxis = 'narrative' | 'sensation' | 'viewing';

export interface SoulField {
    key: string;
    axis: SoulAxis;
    value: string;
    /** Selection weight for learning. 1 = neutral; dislikes decay it. */
    weight: number;
    /** Brand red-line: learning may never alter a locked field. */
    locked: boolean;
    rationale?: string;
}

export interface BrandSoul {
    version: 1;
    updatedAt: number;
    fields: SoulField[];
}

export interface SoulFieldSpec { key: string; axis: SoulAxis; label: string; hint: string }

export const SOUL_SCHEMA: SoulFieldSpec[] = [
    // --- Narrative ---
    { key: 'narrative.voice', axis: 'narrative', label: 'Voice', hint: 'The personality speaking. Spectra: authority↔democracy, formal↔casual, warm↔cool, certain↔exploratory, urgent↔patient' },
    { key: 'narrative.position', axis: 'narrative', label: 'Position', hint: 'Where it stands culturally/market-wise. premium↔accessible, mainstream↔alternative, established↔emergent, insider↔outsider' },
    { key: 'narrative.stance', axis: 'narrative', label: 'Stance', hint: 'Treats the viewer as: intimate / professional / ceremonial / instructive / companionable + hierarchical distance' },
    { key: 'narrative.temporality', axis: 'narrative', label: 'Temporality', hint: 'Era anchor: timeless / contemporary / era-specific / futuristic + how long it should persist' },
    { key: 'narrative.cultural_lineage', axis: 'narrative', label: 'Cultural lineage', hint: 'Traditions inherited from, with weights, e.g. Japandi(0.5) + Mid-century(0.3) + Wabi-sabi(0.2)' },
    { key: 'narrative.genre', axis: 'narrative', label: 'Genre', hint: 'Reading expectation: documentary / poetic / journalistic / cinematic / scientific / playful / ritual' },
    { key: 'narrative.truth_claim', axis: 'narrative', label: 'Truth claim', hint: 'How seriously to be believed: sincere / knowing / ironic / performative / ambiguous' },
    // --- Sensation ---
    { key: 'sensation.palette', axis: 'sensation', label: 'Palette', hint: 'Concrete color language: hues, contrast level, density' },
    { key: 'sensation.light', axis: 'sensation', label: 'Light', hint: 'warm/cool, hard/soft, directional/diffuse — the brand default light character' },
    { key: 'sensation.tactile_implied', axis: 'sensation', label: 'Implied touch', hint: "How the image suggests touch: hardness, texture, weight, temperature — the product's signature material is core here" },
    { key: 'sensation.atmosphere', axis: 'sensation', label: 'Atmosphere', hint: 'Composite environmental feel: temperature, humidity, openness, time-of-day evocation' },
    { key: 'sensation.scale_to_body', axis: 'sensation', label: 'Body scale', hint: 'Relationship to the body: intimate / human / monumental + posture invitation' },
    { key: 'sensation.meta', axis: 'sensation', label: 'Sensory meta', hint: 'sensory density (sparse↔rich), foregrounded modality, cross-modal coherence — the overall "key" of the image' },
    // --- Viewing ---
    { key: 'viewing.first_impression', axis: 'viewing', label: 'First impression', hint: 'What must land in the first second (thumbnail test): attractor + contact distance' },
    { key: 'viewing.gaze_path', axis: 'viewing', label: 'Gaze path', hint: 'How the eye should travel: entry point, path through depth, where it rests' },
    { key: 'viewing.info_layering', axis: 'viewing', label: 'Info layering', hint: 'flat (one-glance) vs nested (rewards looking longer); what unfolds on the second look' },
    { key: 'viewing.dwell_pace', axis: 'viewing', label: 'Dwell pace', hint: 'Designed viewing duration and pace: grab-in-3s vs sustain-30s; urgent↔steady↔slow' },
    { key: 'viewing.memory_imprint', axis: 'viewing', label: 'Memory imprint', hint: 'What should linger after looking away; the return invitation' },
];

// ---------------------------------------------------------------------------
// Storage (per-brand kv)
// ---------------------------------------------------------------------------

export async function getBrandSoul(): Promise<BrandSoul | null> {
    return storage.kvGet<BrandSoul>(brandKey('soul'));
}

export async function saveBrandSoul(soul: BrandSoul): Promise<void> {
    // Version history: snapshot the previous soul (keep last 5).
    try {
        const prev = await getBrandSoul();
        if (prev) {
            const hist = (await storage.kvGet<BrandSoul[]>(brandKey('soulHistory'))) ?? [];
            await storage.kvSet(brandKey('soulHistory'), [...hist, prev].slice(-5));
        }
    } catch { /* history is best-effort */ }
    await storage.kvSet(brandKey('soul'), { ...soul, updatedAt: Date.now() });
}

// ---------------------------------------------------------------------------
// Derivation — brand archaeology (text evidence + approved imagery pixels)
// ---------------------------------------------------------------------------

export async function deriveBrandSoul(): Promise<BrandSoul> {
    const brand = await getCurrentBrand();
    const [rules, signals, results, refs] = await Promise.all([
        storage.listRules(), storage.listSignals(), storage.listResults(100), storage.listReferences(),
    ]);

    // Visual archaeology: pixels of approved imagery (adopted results first,
    // then promoted references) teach the sensation axis directly.
    const approvedImages = [
        ...results.filter(r => r.adopted && r.image.kind === 'data').map(r => r.image.value),
        ...refs.filter(r => r.source === 'promoted' && r.image.kind === 'data').map(r => r.image.value),
    ].slice(0, 5);

    const evidence = [
        `RULES (distilled from feedback):\n${rules.map(r => `- [${r.polarity}] ${r.rule}`).join('\n') || '(none)'}`,
        `RECENT FEEDBACK REASONS:\n${signals.filter(s => s.reason).slice(-20).map(s => `- (${s.type}) ${s.reason}`).join('\n') || '(none)'}`,
    ].join('\n\n');

    const prompt = `You are a brand semiotician. Derive the visual BRAND SOUL of "${brand.name}" — ${brand.description}
Product fidelity essentials: ${brand.productEssence || '(not specified)'}

${approvedImages.length > 0 ? 'APPROVED BRAND IMAGERY is attached — derive the sensation axis (palette, light, implied touch, atmosphere) primarily from those pixels, not from words.' : ''}

### EVIDENCE ###
${evidence}

### FIELD SCHEMA ###
${SOUL_SCHEMA.map(f => `- ${f.key} (${f.label}): ${f.hint}`).join('\n')}

### TASK ###
For every schema key output:
- value: concrete, promptable, 1-2 sentences, specific to THIS brand (not generic).
- rationale: one line citing which evidence drove it (or "inferred from positioning").
Output JSON: { "fields": [ { "key": string, "value": string, "rationale": string } ] }`;

    const parsed = await generateJson<{ fields: Array<{ key: string; value: string; rationale?: string }> }>(
        prompt, approvedImages
    );
    const allowed = new Map(SOUL_SCHEMA.map(s => [s.key, s]));
    const existing = await getBrandSoul();
    const lockedByKey = new Map((existing?.fields ?? []).filter(f => f.locked).map(f => [f.key, f]));

    const fields: SoulField[] = (parsed?.fields ?? [])
        .filter(f => allowed.has(f.key))
        .map(f => {
            const kept = lockedByKey.get(f.key);
            if (kept) return kept; // locked fields survive re-derivation
            return {
                key: f.key,
                axis: allowed.get(f.key)!.axis,
                value: String(f.value ?? '').trim(),
                weight: 1,
                locked: false,
                rationale: f.rationale?.trim(),
            };
        });

    return { version: 1, updatedAt: Date.now(), fields };
}

// ---------------------------------------------------------------------------
// Website archaeology — derive a soul draft from a brand's live website
// (their words + their imagery), via the server-side /api/fetch-site proxy.
// ---------------------------------------------------------------------------

export interface WebDerivation {
    soul: BrandSoul;
    /** Suggested brand meta extracted from the site — apply if you like it. */
    suggestedDescription: string;
    suggestedEssence: string;
}

export async function deriveSoulFromWebsite(url: string): Promise<WebDerivation> {
    const brand = await getCurrentBrand();

    const resp = await fetch('/api/fetch-site', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...appApiHeaders() },
        body: JSON.stringify({ url }),
    });
    const site = await resp.json();
    if (!resp.ok) throw new Error(site?.error?.message || `Fetch failed (${resp.status})`);

    const images: string[] = (site.images ?? []).map((i: { dataUrl: string }) => i.dataUrl);
    const prompt = `You are a brand semiotician. The attached images and the text below come from a brand's LIVE WEBSITE. Derive its visual BRAND SOUL from what the brand actually says and shows.

### SITE ###
Title: ${site.title || '-'}
Meta description: ${site.description || '-'}
Page text (truncated): ${site.text || '-'}
${images.length > 0 ? `\n${images.length} site image(s) attached — derive the sensation axis primarily from those pixels.` : ''}

### FIELD SCHEMA ###
${SOUL_SCHEMA.map(f => `- ${f.key} (${f.label}): ${f.hint}`).join('\n')}

### TASK ###
1. For every schema key output value (concrete, promptable, 1-2 sentences, specific to THIS brand) + rationale (one line citing site evidence).
2. suggestedDescription: one line — category + positioning, as this site presents itself.
3. suggestedEssence: one line — the product-fidelity essentials (materials, signatures that must never change in imagery).

Output JSON: { "fields": [ { "key", "value", "rationale" } ], "suggestedDescription": string, "suggestedEssence": string }`;

    const parsed = await generateJson<{
        fields: Array<{ key: string; value: string; rationale?: string }>;
        suggestedDescription: string;
        suggestedEssence: string;
    }>(prompt, images);

    const allowed = new Map(SOUL_SCHEMA.map(s => [s.key, s]));
    const existing = await getBrandSoul();
    const lockedByKey = new Map((existing?.fields ?? []).filter(f => f.locked).map(f => [f.key, f]));
    const fields: SoulField[] = (parsed?.fields ?? [])
        .filter(f => allowed.has(f.key))
        .map(f => lockedByKey.get(f.key) ?? ({
            key: f.key,
            axis: allowed.get(f.key)!.axis,
            value: String(f.value ?? '').trim(),
            weight: 1,
            locked: false,
            rationale: f.rationale?.trim() || `From ${new URL(url).hostname}`,
        }));

    if (fields.length === 0) throw new Error('Could not derive fields from this site — try another page (e.g. the About page).');

    return {
        soul: { version: 1, updatedAt: Date.now(), fields },
        suggestedDescription: String(parsed?.suggestedDescription ?? '').trim() || brand.description,
        suggestedEssence: String(parsed?.suggestedEssence ?? '').trim() || brand.productEssence,
    };
}

/** Flat prompt block — used when generation bypasses the semantic fill. */
export function soulPromptBlock(soul: BrandSoul | null): string {
    if (!soul || soul.fields.length === 0) return '';
    const lines = soul.fields
        .filter(f => f.value.trim())
        .map(f => `- ${f.key.split('.')[1] ?? f.key}: ${f.value}`);
    return `\n### BRAND SOUL (persistent identity — obey) ###\n${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Attribution — map dislike reasons onto soul fields; decay their weight
// ---------------------------------------------------------------------------

export interface FieldAttribution { reason: string; keys: string[]; createdAt: number }

export async function getFieldAttributions(): Promise<FieldAttribution[]> {
    return (await storage.kvGet<FieldAttribution[]>(brandKey('fieldAttributions'))) ?? [];
}

export async function attributeFeedback(reason: string): Promise<void> {
    if (!reason.trim()) return;
    const soul = await getBrandSoul();
    if (!soul) return;
    try {
        const parsed = await generateJson<{ keys: string[] }>(
            `A user disliked a generated brand image for this reason: "${reason}"

Which of these semantic fields most plausibly caused the failure? Pick 1-3.
${soul.fields.map(f => `- ${f.key}: ${f.value.slice(0, 100)}`).join('\n')}

Output JSON: { "keys": [ ... ] }`
        );
        const valid = (parsed?.keys ?? []).filter(k => soul.fields.some(f => f.key === k));
        if (valid.length === 0) return;

        const attributions = await getFieldAttributions();
        await storage.kvSet(brandKey('fieldAttributions'),
            [...attributions, { reason, keys: valid, createdAt: Date.now() }].slice(-200));

        // Decay unlocked field weights (min 0.1).
        const fields = soul.fields.map(f =>
            valid.includes(f.key) && !f.locked
                ? { ...f, weight: Math.max(0.1, Math.round((f.weight - 0.1) * 10) / 10) }
                : f);
        await saveBrandSoul({ ...soul, fields });
    } catch (err) {
        console.warn('[soul] attribution failed:', err);
    }
}
