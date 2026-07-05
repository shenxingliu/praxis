import {
    GenerationResult, KnowledgeRule, Reference, SignalType,
} from '../domain/types';
import { storage } from '../storage/local';
import { getCurrentBrand, getCurrentBrandId } from '../domain/brand';
import { generateJson } from '../engine/gemini';

/**
 * The learning loop: collect → distill → apply → (prune is human, via the
 * Knowledge page).
 *
 * Apply happens inside the engine (rule scope-matching + promoted-reference
 * weighting). This module owns collect + distill + promote.
 */

const SIGNAL_WEIGHT: Record<SignalType, number> = {
    like: 2, save: 2, export: 3,
    dislike: -2, discard: -1, regenerate: -1,
};

/** Record any signal — explicit or implicit. Cheap, call it everywhere. */
export async function recordSignal(
    result: GenerationResult,
    type: SignalType,
    reason?: string
): Promise<void> {
    await storage.addSignal({
        id: crypto.randomUUID(),
        brandId: getCurrentBrandId(),
        resultId: result.id,
        type,
        reason,
        scope: {
            outputType: result.params.outputType,
            purpose: result.params.purpose,
            room: result.params.room,
        },
        createdAt: Date.now(),
        distilled: false,
    });
    // Adoption tracking for the north-star metric.
    if ((type === 'save' || type === 'export') && !result.adopted) {
        await storage.upsertResult({ ...result, adopted: true });
    }
    // Strong positive → promote the image into the reference pool so future
    // generations literally see what "good" looks like (LoRA door: these
    // promoted refs + their result metadata double as a training set).
    if (type === 'like' || type === 'export') {
        await promoteToReference(result);
    }
}

async function promoteToReference(result: GenerationResult): Promise<void> {
    const existing = await storage.listReferences();
    const already = existing.find(r => r.tags.includes(`result:${result.id}`));
    if (already) {
        await storage.upsertReference({ ...already, weight: already.weight + 1 });
        return;
    }
    const ref: Reference = {
        id: crypto.randomUUID(),
        brandId: getCurrentBrandId(),
        kind: 'style',
        name: `Liked · ${result.params.outputType}${result.params.room ? ` · ${result.params.room}` : ''}`,
        image: result.image,
        tags: [`result:${result.id}`, result.params.outputType, result.params.room ?? '']
            .filter(Boolean),
        source: 'promoted',
        weight: 1,
        createdAt: Date.now(),
    };
    await storage.upsertReference(ref);
}

/** North-star metric: adopted ÷ generated. */
export async function adoptionRate(): Promise<{ adopted: number; total: number; rate: number }> {
    const results = await storage.listResults(1000);
    const adopted = results.filter(r => r.adopted).length;
    return { adopted, total: results.length, rate: results.length ? adopted / results.length : 0 };
}

// ---------------------------------------------------------------------------
// Distillation — compress raw signals into scoped, human-readable rules.
// Trigger: manually from the Knowledge page, or automatically once
// ≥ DISTILL_THRESHOLD undistilled signals accumulate.
// ---------------------------------------------------------------------------

export const DISTILL_THRESHOLD = 25;

interface DistilledRule {
    scope: { outputType?: string; purpose?: string; room?: string; category?: string };
    rule: string;
    polarity: 'must' | 'avoid';
    supportingSignalIds: string[];
}

export async function distill(): Promise<{ newRules: number; consumed: number }> {
    const signals = await storage.listSignals(true);
    const withReason = signals.filter(s => s.reason || SIGNAL_WEIGHT[s.type] < 0 || s.type === 'like');
    if (withReason.length === 0) return { newRules: 0, consumed: 0 };

    const existingRules = await storage.listRules();
    const brand = await getCurrentBrand().catch(() => null);

    const prompt = `You maintain a knowledge base of image-generation rules for the brand "${brand?.name ?? 'the client'}" — ${brand?.description ?? 'a product brand'}.

EXISTING RULES (do not duplicate):
${existingRules.map(r => `- [${r.polarity}] (${JSON.stringify(r.scope)}) ${r.rule}`).join('\n') || '(none)'}

NEW FEEDBACK SIGNALS:
${withReason.map(s => `- id=${s.id} type=${s.type} scope=${JSON.stringify(s.scope)}${s.reason ? ` reason="${s.reason}"` : ''}`).join('\n')}

Distill recurring, actionable lessons into rules. Only create a rule when the evidence is clear (a reasoned dislike, or a repeated pattern). Rules must be short imperative directives usable inside an image prompt, in English. Scope each rule as narrowly as the evidence supports.

Output JSON: { "rules": [ { "scope": {"outputType"?, "purpose"?, "room"?, "category"?}, "rule": string, "polarity": "must"|"avoid", "supportingSignalIds": string[] } ] }`;

    const parsed = await generateJson<{ rules: DistilledRule[] }>(prompt);
    const rules = parsed?.rules ?? [];
    const now = Date.now();
    for (const r of rules) {
        const rule: KnowledgeRule = {
            id: crypto.randomUUID(),
            brandId: getCurrentBrandId(),
            scope: r.scope as KnowledgeRule['scope'],
            rule: r.rule,
            polarity: r.polarity,
            confidence: r.supportingSignalIds.length,
            sources: r.supportingSignalIds,
            enabled: true,
            createdAt: now,
            updatedAt: now,
        };
        await storage.upsertRule(rule);
    }
    await storage.markSignalsDistilled(signals.map(s => s.id));
    return { newRules: rules.length, consumed: signals.length };
}

/** Auto-trigger helper — call after each recordSignal from the UI. */
export async function maybeDistill(): Promise<void> {
    const pending = await storage.listSignals(true);
    if (pending.length >= DISTILL_THRESHOLD) {
        try { await distill(); } catch { /* non-fatal; retry next time */ }
    }
}
