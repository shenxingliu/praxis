import {
    Asset, ConceptProposal, Element, GenerationParams, GenerationResult,
    PraxisJob, ProductionPlan, Realism, ReviewReport,
} from '../domain/types';
import { storage } from '../storage/local';
import { getCurrentBrand, getCurrentBrandId } from '../domain/brand';
import { getBrandSoul, getFieldAttributions, SOUL_SCHEMA } from '../brain/soul';
import { generateJson } from '../engine/gemini';
import { generate } from '../engine/engine';

/**
 * The studio agents — a simulated elite design team with a visible,
 * interruptible workflow:
 *
 *   CONCEPT agent   (creative director)  brief → 2-3 directions
 *   PRODUCER agent  (producer)           chosen concept → production plan
 *   EXECUTION       (the engine)         plan → images
 *   REVIEW agent    (design crit)        images → scores vs the brand soul
 *
 * Every stage writes back to the PraxisJob so the user can inspect and
 * override before the next stage runs.
 */

const REALISMS: Realism[] = ['photographic', 'surreal', 'abstract'];

// ---------------------------------------------------------------------------
// Stage 1 — Concept agent
// ---------------------------------------------------------------------------

export async function startJob(brief: string): Promise<PraxisJob> {
    const job: PraxisJob = {
        id: crypto.randomUUID(),
        brandId: getCurrentBrandId(),
        brief,
        stage: 'brief',
        concepts: [],
        resultIds: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
    await storage.upsertJob(job);
    return job;
}

export async function proposeConcepts(job: PraxisJob): Promise<PraxisJob> {
    const brand = await getCurrentBrand();
    const soul = await getBrandSoul();
    const elements = (await storage.listElements()).filter(e => e.enabled);

    // Weight closed-loop: demoted soul fields carry their recent complaints.
    const demoted = (soul?.fields ?? []).filter(f => f.weight < 1 && !f.locked).map(f => f.key);
    let complaints = '';
    if (demoted.length > 0) {
        const att = await getFieldAttributions().catch(() => []);
        const relevant = att.filter(a => a.keys.some(k => demoted.includes(k))).slice(-5)
            .map(a => `- [${a.keys.join(', ')}] "${a.reason}"`);
        if (relevant.length > 0) complaints = `\n### RECENT FAILURES (avoid repeating) ###\n${relevant.join('\n')}\n`;
    }

    const prompt = `You are the CREATIVE DIRECTOR of an elite design studio working for "${brand.name}" — ${brand.description}

### CLIENT BRIEF ###
${job.brief}

### BRAND SOUL (locked fields are red-lines) ###
${(soul?.fields ?? []).filter(f => f.value.trim()).map(f => `${f.key}${f.locked ? ' [LOCKED]' : ''} (w${f.weight}): ${f.value}`).join('\n') || '(no soul yet — derive from brand description)'}
${complaints}
### ELEMENT LIBRARY (decomposed fragments available for recombination) ###
${elements.map(e => `- id=${e.id} [${e.type}] (w${e.weight}) ${e.description.slice(0, 140)}`).join('\n') || '(empty — concepts must describe environments from scratch)'}

### CONTEXT MODES (the brand's environment grammars) ###
${brand.contextModes.map(m => `- id=${m.id} [${m.realism}] ${m.label}: ${m.directive}`).join('\n') || '(none — propose your own realism per concept)'}

### TASK ###
Propose exactly 3 DISTINCT creative directions for this brief. Each must serve the brand soul but differ meaningfully in mood, environment logic, or viewing grammar. For each:
- title: 3-6 words
- rationale: 2-3 sentences — why this direction serves the brief AND the brand
- nsiSummary: one compact line per axis (narrative / sensation / viewing) describing this direction's specialization
- elementIds: 0-4 element ids from the library to recombine (only if they truly fit)
- contextModeId: one of the context mode ids, or null
- realism: ${REALISMS.join(' | ')}

Output JSON: { "concepts": [ { "title", "rationale", "nsiSummary", "elementIds": [], "contextModeId": string|null, "realism" } ] }`;

    const parsed = await generateJson<{ concepts: Array<Record<string, unknown>> }>(prompt);
    const validElement = new Set(elements.map(e => e.id));
    const validMode = new Set(brand.contextModes.map(m => m.id));

    const concepts: ConceptProposal[] = (parsed?.concepts ?? []).slice(0, 3).map(c => ({
        id: crypto.randomUUID(),
        title: String(c.title ?? 'Untitled direction'),
        rationale: String(c.rationale ?? ''),
        nsiSummary: String(c.nsiSummary ?? ''),
        elementIds: (Array.isArray(c.elementIds) ? c.elementIds : []).filter((id: unknown) => validElement.has(String(id))).map(String),
        contextModeId: validMode.has(String(c.contextModeId)) ? String(c.contextModeId) : undefined,
        realism: REALISMS.includes(c.realism as Realism) ? c.realism as Realism : 'photographic',
    }));

    const next: PraxisJob = { ...job, concepts, stage: 'concepts', updatedAt: Date.now() };
    await storage.upsertJob(next);
    return next;
}

// ---------------------------------------------------------------------------
// Stage 2 — Producer agent
// ---------------------------------------------------------------------------

export async function makePlan(job: PraxisJob, conceptId: string, assetIds: string[]): Promise<PraxisJob> {
    const concept = job.concepts.find(c => c.id === conceptId);
    if (!concept) throw new Error('Concept not found.');
    const brand = await getCurrentBrand();
    const assets = (await storage.listAssets()).filter(a => assetIds.includes(a.id));
    const elements = (await storage.listElements()).filter(e => concept.elementIds.includes(e.id));

    const prompt = `You are the PRODUCER of a design studio. Turn the chosen concept into a concrete production plan.

BRAND: ${brand.name} — ${brand.description}
BRIEF: ${job.brief}
CHOSEN CONCEPT: ${concept.title} — ${concept.rationale}
N/S/I: ${concept.nsiSummary}
REALISM: ${concept.realism}
PRODUCTS: ${assets.map(a => `${a.name}${a.category ? ` (${a.category})` : ''}`).join('; ') || '(none picked)'}
ELEMENTS TO RECOMBINE: ${elements.map(e => `[${e.type}] ${e.description.slice(0, 100)}`).join('; ') || '(none)'}

### TASK ###
- steps: 3-5 short production steps a human can sanity-check (what happens, in order)
- ratio: best aspect ratio for the concept ("1:1"|"16:9"|"4:3"|"3:4"|"9:16")
- note: ONE dense art-direction sentence for the image model that captures this concept's specific twist (beyond soul + elements)
- purpose: hero | pdp | social | seasonal — best fit for the brief

Output JSON: { "steps": [], "ratio": string, "note": string, "purpose": string }`;

    const parsed = await generateJson<{ steps: string[]; ratio: string; note: string; purpose: string }>(prompt);
    const ratios = ['1:1', '16:9', '4:3', '3:4', '9:16'];
    const purposes = ['hero', 'pdp', 'social', 'seasonal'];

    const params: GenerationParams = {
        outputType: 'scene',
        purpose: purposes.includes(parsed?.purpose) ? parsed.purpose as GenerationParams['purpose'] : 'pdp',
        ratio: (ratios.includes(parsed?.ratio) ? parsed.ratio : '4:3') as GenerationParams['ratio'],
        note: parsed?.note?.slice(0, 500),
        modelTier: 'auto',
        contextModeId: concept.contextModeId,
        elementIds: concept.elementIds,
    };

    const plan: ProductionPlan = {
        conceptId,
        steps: (parsed?.steps ?? []).map(String).slice(0, 6),
        params,
        assetIds,
        elementIds: concept.elementIds,
        referenceIds: [],
    };

    const next: PraxisJob = { ...job, chosenConceptId: conceptId, plan, stage: 'plan', updatedAt: Date.now() };
    await storage.upsertJob(next);
    return next;
}

// ---------------------------------------------------------------------------
// Stage 3 — Execution
// ---------------------------------------------------------------------------

export async function executeJob(
    job: PraxisJob,
    count: number,
    onStatus?: (text: string) => void
): Promise<{ job: PraxisJob; results: GenerationResult[] }> {
    if (!job.plan) throw new Error('No production plan.');
    const results: GenerationResult[] = [];
    for (let i = 0; i < count; i++) {
        onStatus?.(count > 1 ? `Executing ${i + 1}/${count}…` : 'Executing…');
        const r = await generate(job.plan.params, job.plan.assetIds, onStatus);
        await storage.upsertResult({ ...r, jobId: job.id });
        results.push({ ...r, jobId: job.id });
    }
    const next: PraxisJob = {
        ...job,
        stage: 'execute',
        resultIds: [...job.resultIds, ...results.map(r => r.id)],
        updatedAt: Date.now(),
    };
    await storage.upsertJob(next);
    return { job: next, results };
}

// ---------------------------------------------------------------------------
// Stage 4 — Review agent (design crit vs the brand soul)
// ---------------------------------------------------------------------------

export async function reviewJob(job: PraxisJob, results: GenerationResult[]): Promise<PraxisJob> {
    const brand = await getCurrentBrand();
    const soul = await getBrandSoul();
    const images = results.filter(r => r.image.kind === 'data').slice(0, 4).map(r => r.image.value);
    if (images.length === 0) throw new Error('No images to review.');

    const prompt = `You are the DESIGN CRITIC of the studio. Score the attached generated image(s) against the brand's soul.

BRAND: ${brand.name} — ${brand.description}
BRIEF: ${job.brief}

### BRAND SOUL ###
${(soul?.fields ?? []).filter(f => f.value.trim()).map(f => `${f.key}: ${f.value}`).join('\n') || '(no soul — score against the brand description)'}

### TASK ###
- axisScores: for each axis (narrative, sensation, viewing) a 0-100 score + one concrete note citing what you SEE
- overall: 0-100 weighted judgment
- verdict: "pass" (≥70 and no axis below 55) or "revise"
- suggestions: 1-3 specific, actionable art-direction fixes (empty if pass)

Output JSON: { "overall": number, "axisScores": [ { "axis", "score", "note" } ], "verdict": "pass"|"revise", "suggestions": [] }`;

    const parsed = await generateJson<ReviewReport>(prompt, images);
    const review: ReviewReport = {
        overall: Number(parsed?.overall ?? 0),
        axisScores: (parsed?.axisScores ?? []).map(a => ({
            axis: String(a.axis), score: Number(a.score), note: String(a.note ?? ''),
        })),
        verdict: parsed?.verdict === 'pass' ? 'pass' : 'revise',
        suggestions: (parsed?.suggestions ?? []).map(String).slice(0, 3),
    };

    const next: PraxisJob = { ...job, review, stage: 'review', updatedAt: Date.now() };
    await storage.upsertJob(next);
    return next;
}

export async function closeJob(job: PraxisJob): Promise<PraxisJob> {
    const next: PraxisJob = { ...job, stage: 'done', updatedAt: Date.now() };
    await storage.upsertJob(next);
    return next;
}

/** Convenience: soul-field labels for review display. */
export const AXIS_LABEL: Record<string, string> = Object.fromEntries(
    SOUL_SCHEMA.map(s => [s.axis, s.axis[0].toUpperCase() + s.axis.slice(1)])
);
