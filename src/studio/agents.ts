import {
    Asset, ConceptProposal, Element, GenerationParams, GenerationResult,
    PraxisJob, ProductionPlan, Realism, Reference, ReviewReport,
} from '../domain/types';
import { storage } from '../storage/local';
import { getCurrentBrand, getCurrentBrandId } from '../domain/brand';
import { getBrandSoul, getFieldAttributions, SOUL_SCHEMA } from '../brain/soul';
import { getFusionVerdicts } from '../engine/fusion';
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

const directivesBlock = (job: PraxisJob): string =>
    (job.directives ?? []).length > 0
        ? `\n### OWNER DIRECTIVES (interjected during this job — obey ALL; the newest wins on conflict) ###\n${(job.directives ?? []).map(d => `- ${d}`).join('\n')}\n`
        : '';

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

export async function proposeConcepts(job: PraxisJob, inspirationRefs?: Reference[]): Promise<PraxisJob> {
    const brand = await getCurrentBrand();
    const soul = await getBrandSoul();
    const allRefs = (await storage.listReferences())
        .filter(r => r.kind !== 'plate' && r.image.kind === 'data')
        .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
    const selectedRefIds = new Set((inspirationRefs ?? []).map(r => r.id));
    const selectedRefs = (inspirationRefs && inspirationRefs.length > 0
        ? allRefs.filter(r => selectedRefIds.has(r.id))
        : allRefs
    ).slice(0, 8);
    const refName = new Map(allRefs.map(r => [r.id, r.name]));
    const selectedOrTopRefIds = new Set(selectedRefs.map(r => r.id));
    const elements = (await storage.listElements())
        .filter(e => e.enabled)
        .sort((a, b) => {
            const aBoost = selectedOrTopRefIds.has(a.sourceRefId) ? 10 : 0;
            const bBoost = selectedOrTopRefIds.has(b.sourceRefId) ? 10 : 0;
            return (bBoost + (b.weight ?? 0)) - (aBoost + (a.weight ?? 0));
        })
        .slice(0, 48);
    const selectedElements = elements.filter(e => selectedOrTopRefIds.has(e.sourceRefId)).slice(0, 18);
    const crossPollinationElements = elements.filter(e => !selectedOrTopRefIds.has(e.sourceRefId)).slice(0, 30);

    // Weight closed-loop: demoted soul fields carry their recent complaints.
    const demoted = (soul?.fields ?? []).filter(f => f.weight < 1 && !f.locked).map(f => f.key);
    let complaints = '';
    if (demoted.length > 0) {
        const att = await getFieldAttributions().catch(() => []);
        const relevant = att.filter(a => a.keys.some(k => demoted.includes(k))).slice(-5)
            .map(a => `- [${a.keys.join(', ')}] "${a.reason}"`);
        if (relevant.length > 0) complaints = `\n### RECENT FAILURES (avoid repeating) ###\n${relevant.join('\n')}\n`;
    }

    // Fusion Lab memory: which concept COMBINATIONS the owner kept vs threw
    // away — taste at the pairing level, not just per-card weights.
    const verdicts = (await getFusionVerdicts().catch(() => [])).slice(-12);
    const keptV = verdicts.filter(v => v.verdict === 'keep');
    const discV = verdicts.filter(v => v.verdict === 'discard');
    const fusionMemory = verdicts.length > 0 ? `
### FUSION LAB VERDICTS (the owner's taste at the combination level) ###
${keptV.length > 0 ? `KEPT: ${keptV.map(v => v.concepts.map(c => `“${c}”`).join('×')).join(' ; ')}` : ''}
${discV.length > 0 ? `DISCARDED: ${discV.map(v => v.concepts.map(c => `“${c}”`).join('×')).join(' ; ')}` : ''}
Let KEPT pairings inform which concepts you recombine; avoid DISCARDED pairings and close variants.
` : '';

    const prompt = `You are the CREATIVE DIRECTOR of an elite design studio working for "${brand.name}" — ${brand.description}

### CLIENT BRIEF ###
${job.brief.trim() || '(no brief — OPEN EXPLORATION: propose what this brand should make next. Ground every direction in the soul and the inspiration pool; surprise the owner with directions they would not have briefed but will recognize as their own.)'}
${directivesBlock(job)}
### BRAND SOUL (locked fields are red-lines) ###
${(soul?.fields ?? []).filter(f => f.value.trim()).map(f => `${f.key}${f.locked ? ' [LOCKED]' : ''} (w${f.weight}): ${f.value}`).join('\n') || '(no soul yet — derive from brand description)'}
${complaints}${fusionMemory}
### INSPIRATION POOL (attached images, numbered in order) ###
${selectedRefs.length > 0
        ? selectedRefs.map((r, i) => `${i + 1}. "${r.name}"${r.source === 'synthesized' ? ' (kept fusion result)' : ''} weight=${r.weight}`).join('\n')
        : '(none selected — invent from brand soul and brief)'}

Use these attached images as HIGH-WEIGHT VISUAL MEMORY, not as subjects to copy. Read their light, palette, framing, material mood, spatial grammar, and emotional stance. Do not copy objects, layouts, logos, people, or products from inspiration unless they are also selected as Assets.

### EXTRACTED INGREDIENTS FROM THE HIGH-WEIGHT INSPIRATION ###
${selectedElements.length > 0
        ? selectedElements.map(e => `- id=${e.id} [${e.type}] from "${refName.get(e.sourceRefId) ?? 'Inspiration'}" w${e.weight}: "${e.concept}" — ${e.description.slice(0, 150)}${e.principle ? ` Principle: ${e.principle}` : ''}${e.worldview ? ` Worldview: ${e.worldview}` : ''}`).join('\n')
        : '(none extracted yet)'}

### CROSS-POLLINATION INGREDIENTS FROM OTHER INSPIRATION ###
${crossPollinationElements.length > 0
        ? crossPollinationElements.map(e => `- id=${e.id} [${e.type}] from "${refName.get(e.sourceRefId) ?? 'Inspiration'}" w${e.weight}: "${e.concept}" — ${e.description.slice(0, 130)}`).join('\n')
        : '(none available)'}

Design more openly than a literal mood match. Each direction should fuse:
1. one dominant visual memory from the high-weight inspiration,
2. one or two extracted ingredients from either the same image or another inspiration image,
3. a fresh production idea that is not already visible in any single reference.
The result should feel like a new studio concept born from the library, not a collage or a copy.

### CONTEXT MODES (the brand's environment grammars) ###
${brand.contextModes.map(m => `- id=${m.id} [${m.realism}] ${m.label}: ${m.directive}`).join('\n') || '(none — propose your own realism per concept)'}

### TASK ###
Propose exactly 3 DISTINCT creative directions for this brief. Each must serve the brand soul but differ meaningfully in mood, environment logic, or viewing grammar. For each:
- title: 3-6 words
- rationale: 2-3 sentences — why this direction serves the brief AND the brand
- nsiSummary: one compact line per axis (narrative / sensation / viewing) describing this direction's specialization
- refNumbers: 0-3 inspiration image numbers that influenced this direction
- elementIds: 1-5 extracted ingredient ids actually recombined; prefer at least one high-weight ingredient and one cross-pollination ingredient when useful
- contextModeId: one of the context mode ids, or null
- realism: ${REALISMS.join(' | ')}

Output JSON: { "concepts": [ { "title", "rationale", "nsiSummary", "refNumbers": [], "elementIds": [], "contextModeId": string|null, "realism" } ] }`;

    const parsed = await generateJson<{ concepts: Array<Record<string, unknown>> }>(
        prompt,
        selectedRefs.map(r => r.image.value)
    );
    const validElement = new Set(elements.map(e => e.id));
    const validMode = new Set(brand.contextModes.map(m => m.id));

    const concepts: ConceptProposal[] = (parsed?.concepts ?? []).slice(0, 3).map(c => {
        const elementIds = (Array.isArray(c.elementIds) ? c.elementIds : [])
            .filter((id: unknown) => validElement.has(String(id)))
            .map(String);
        const refsFromNumbers = (Array.isArray(c.refNumbers) ? c.refNumbers : [])
            .map((n: unknown) => selectedRefs[Number(n) - 1]?.id)
            .filter((id: string | undefined): id is string => !!id);
        const refsFromElements = elementIds
            .map(id => elements.find(e => e.id === id)?.sourceRefId)
            .filter((id: string | undefined): id is string => !!id);
        return {
            id: crypto.randomUUID(),
            title: String(c.title ?? 'Untitled direction'),
            rationale: String(c.rationale ?? ''),
            nsiSummary: String(c.nsiSummary ?? ''),
            elementIds,
            sourceRefIds: Array.from(new Set([...refsFromNumbers, ...refsFromElements])),
            contextModeId: validMode.has(String(c.contextModeId)) ? String(c.contextModeId) : undefined,
            realism: REALISMS.includes(c.realism as Realism) ? c.realism as Realism : 'photographic',
        };
    });

    const next: PraxisJob = { ...job, concepts, stage: 'concepts', updatedAt: Date.now() };
    await storage.upsertJob(next);
    return next;
}

/** Concept collision (wildcard): deliberately recombine two CONTRADICTORY
 *  concepts — creative tension from conflict, the way real studios find
 *  their best work in "wrong" combinations. Appends 1 collision concept. */
export async function proposeWildcard(job: PraxisJob): Promise<PraxisJob> {
    const brand = await getCurrentBrand();
    const soul = await getBrandSoul();
    const elements = (await storage.listElements()).filter(e => e.enabled);

    const prompt = `You are the CREATIVE DIRECTOR in a late-night experimental mood, working for "${brand.name}" — ${brand.description}

### CLIENT BRIEF ###
${job.brief.trim() || '(no brief — OPEN EXPLORATION: propose what this brand should make next. Ground every direction in the soul and the concept library; surprise the owner with directions they would not have briefed but will recognize as their own.)'}

### CONCEPT LIBRARY ###
${elements.map(e => `- id=${e.id} [${e.type}] "${e.concept}" — ${e.description.slice(0, 100)}`).join('\n') || '(empty — invent two contradictory concepts yourself)'}

### BRAND RED-LINES (never violate) ###
${(soul?.fields ?? []).filter(f => f.locked && f.value.trim()).map(f => `- ${f.key}: ${f.value}`).join('\n') || '(none)'}

### TASK ###
Pick (or invent) TWO concepts that CONTRADICT each other — opposing energies, incompatible logics. Then design ONE direction where their collision produces something the brand has never dared but would recognize as its own. The tension must be productive, not chaotic.

Output JSON: { "title": string, "rationale": string (name the two colliding concepts and why the collision works), "nsiSummary": string, "elementIds": [] (library ids actually used, may be empty), "contextModeId": string|null, "realism": "photographic"|"surreal"|"abstract" }`;

    const c = await generateJson<Record<string, unknown>>(prompt);
    const validElement = new Set(elements.map(e => e.id));
    const validMode = new Set(brand.contextModes.map(m => m.id));
    const wildcard: ConceptProposal = {
        id: crypto.randomUUID(),
        title: `⚡ ${String(c.title ?? 'Collision')}`,
        rationale: String(c.rationale ?? ''),
        nsiSummary: String(c.nsiSummary ?? ''),
        elementIds: (Array.isArray(c.elementIds) ? c.elementIds : []).filter((id: unknown) => validElement.has(String(id))).map(String),
        contextModeId: validMode.has(String(c.contextModeId)) ? String(c.contextModeId) : undefined,
        realism: REALISMS.includes(c.realism as Realism) ? c.realism as Realism : 'surreal',
    };
    const next: PraxisJob = { ...job, concepts: [...job.concepts, wildcard], updatedAt: Date.now() };
    await storage.upsertJob(next);
    return next;
}

/** Reverse brief: decompose a competitor's image — what does it ARGUE, and
 *  how should OUR brand answer in its own voice? Returns a ready brief. */
export async function analyzeCompetitor(imageDataUrl: string): Promise<{ argument: string; counterBrief: string }> {
    const brand = await getCurrentBrand();
    const soul = await getBrandSoul();
    const parsed = await generateJson<{ argument: string; counterBrief: string }>(
        `You are a brand strategist for "${brand.name}" — ${brand.description}

### OUR SOUL (voice + position) ###
${(soul?.fields ?? []).filter(f => f.axis === 'narrative' && f.value.trim()).map(f => `${f.key}: ${f.value}`).join('\n') || '(derive from description)'}

The attached image is a COMPETITOR's marketing image.
1. argument: In 2-3 sentences, decode what this image ARGUES — the claim it makes, the value it asserts, who it flatters.
2. counterBrief: Write a production brief (3-4 sentences) for OUR studio that ANSWERS this argument in our own voice — not imitating, not merely opposing, but reframing the conversation on our terms.

Output JSON: { "argument": string, "counterBrief": string }`,
        [imageDataUrl]
    );
    return {
        argument: String(parsed?.argument ?? ''),
        counterBrief: String(parsed?.counterBrief ?? ''),
    };
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
BRIEF: ${job.brief.trim() || '(open exploration — judge against the brand soul alone)'}
${directivesBlock(job)}CHOSEN CONCEPT: ${concept.title} — ${concept.rationale}
N/S/I: ${concept.nsiSummary}
REALISM: ${concept.realism}
HEROES: ${assets.map(a => `${a.name}${a.category ? ` (${a.category})` : ''}`).join('; ') || '(none picked)'}
CONCEPTS TO RECOMBINE: ${elements.map(e => `[${e.type}] "${e.concept}" (${e.description.slice(0, 80)})`).join('; ') || '(none)'}

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
// Stage 2.5 — Moodboard (cheap flash drafts: pick direction on VISUALS,
// not text; the chosen draft anchors the final pro execution)
// ---------------------------------------------------------------------------

export async function makeMoodboard(
    job: PraxisJob,
    onStatus?: (text: string) => void
): Promise<GenerationResult[]> {
    if (!job.plan) throw new Error('No production plan.');
    const drafts: GenerationResult[] = [];
    for (let i = 0; i < 3; i++) {
        onStatus?.(`Moodboard draft ${i + 1}/3 (flash)…`);
        try {
            const r = await generate(
                { ...job.plan.params, directives: job.directives, modelTier: 'flash', note: `${job.plan.params.note ?? ''} — mood study variant ${i + 1}, prioritize atmosphere over hero perfection.` },
                job.plan.assetIds, onStatus
            );
            await storage.upsertResult({ ...r, jobId: job.id });
            drafts.push({ ...r, jobId: job.id });
        } catch (err) {
            console.warn('[moodboard] draft failed:', err);
        }
    }
    return drafts;
}

/** Anchor a moodboard draft: its pixels lead the final execution. */
export async function anchorMood(job: PraxisJob, resultId: string): Promise<PraxisJob> {
    if (!job.plan) throw new Error('No production plan.');
    const next: PraxisJob = { ...job, plan: { ...job.plan, moodAnchorResultId: resultId }, updatedAt: Date.now() };
    await storage.upsertJob(next);
    return next;
}

// ---------------------------------------------------------------------------
// Stage 3 — Execution
// ---------------------------------------------------------------------------

async function anchorImageOf(job: PraxisJob): Promise<string[]> {
    const id = job.plan?.moodAnchorResultId;
    if (!id) return [];
    const anchor = await storage.getResult(id).catch(() => null);
    return anchor && anchor.image.kind === 'data' ? [anchor.image.value] : [];
}

export async function executeJob(
    job: PraxisJob,
    count: number,
    onStatus?: (text: string) => void,
    opts?: { qualityGate?: boolean }
): Promise<{ job: PraxisJob; results: GenerationResult[] }> {
    if (!job.plan) throw new Error('No production plan.');
    const anchor = await anchorImageOf(job);
    const results: GenerationResult[] = [];
    for (let i = 0; i < count; i++) {
        onStatus?.(count > 1 ? `Executing ${i + 1}/${count}…` : 'Executing…');
        let r = await generate({ ...job.plan.params, directives: job.directives }, job.plan.assetIds, onStatus, anchor);
        // Quality gate (batch only): weak shots get ONE reshoot with the
        // critic's fixes before the owner ever sees them.
        if (opts?.qualityGate && count > 1 && r.image.kind === 'data') {
            try {
                onStatus?.(`Quality gate — checking shot ${i + 1}…`);
                const crit = await critiqueQuick(r.image.value, job);
                if (crit.overall < 60 && crit.suggestions.length > 0) {
                    onStatus?.(`Shot ${i + 1} scored ${crit.overall} — one reshoot with fixes…`);
                    r = await generate({ ...job.plan.params, directives: [...(job.directives ?? []), ...crit.suggestions] }, job.plan.assetIds, onStatus, anchor);
                }
            } catch { /* gate is best-effort — keep the original shot */ }
        }
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

/** Campaign kit: ONE concept executed across all four purposes with
 *  purpose-appropriate ratios — a brand-consistent set in one job. */
const CAMPAIGN_SET: Array<{ purpose: NonNullable<GenerationParams['purpose']>; ratio: GenerationParams['ratio'] }> = [
    { purpose: 'hero', ratio: '16:9' },
    { purpose: 'pdp', ratio: '4:3' },
    { purpose: 'social', ratio: '1:1' },
    { purpose: 'seasonal', ratio: '3:4' },
];

export async function executeCampaign(
    job: PraxisJob,
    onStatus?: (text: string) => void,
    opts?: { qualityGate?: boolean }
): Promise<{ job: PraxisJob; results: GenerationResult[] }> {
    if (!job.plan) throw new Error('No production plan.');
    const anchor = await anchorImageOf(job);
    const results: GenerationResult[] = [];
    for (let i = 0; i < CAMPAIGN_SET.length; i++) {
        const slot = CAMPAIGN_SET[i];
        onStatus?.(`Campaign ${i + 1}/4 — ${slot.purpose}…`);
        try {
            let r = await generate(
                { ...job.plan.params, directives: job.directives, purpose: slot.purpose, ratio: slot.ratio },
                job.plan.assetIds, onStatus, anchor
            );
            if (opts?.qualityGate && r.image.kind === 'data') {
                try {
                    onStatus?.(`Quality gate — checking ${slot.purpose}…`);
                    const crit = await critiqueQuick(r.image.value, job);
                    if (crit.overall < 60 && crit.suggestions.length > 0) {
                        onStatus?.(`${slot.purpose} scored ${crit.overall} — one reshoot with fixes…`);
                        r = await generate(
                            { ...job.plan.params, directives: [...(job.directives ?? []), ...crit.suggestions], purpose: slot.purpose, ratio: slot.ratio },
                            job.plan.assetIds, onStatus, anchor
                        );
                    }
                } catch { /* best-effort */ }
            }
            await storage.upsertResult({ ...r, jobId: job.id });
            results.push({ ...r, jobId: job.id });
        } catch (err) {
            console.warn('[campaign] slot failed:', slot.purpose, err);
        }
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

/** Critic calibration: every time the owner's verdict contradicts the critic,
 *  we remember it — and the critic reads its own miss history before scoring. */
type CritCalibration = { kind: 'liked-low' | 'disliked-high'; overall: number; note: string; at: number };
const calKey = () => `praxis_critic_calibration_${getCurrentBrandId()}`;

export function recordCritCalibration(entry: Omit<CritCalibration, 'at'>): void {
    try {
        const list: CritCalibration[] = JSON.parse(localStorage.getItem(calKey()) ?? '[]');
        list.push({ ...entry, at: Date.now() });
        localStorage.setItem(calKey(), JSON.stringify(list.slice(-20)));
    } catch { /* calibration is best-effort */ }
}

function calibrationBlock(): string {
    try {
        const list: CritCalibration[] = JSON.parse(localStorage.getItem(calKey()) ?? '[]');
        if (list.length === 0) return '';
        const lines = list.slice(-6).map(c => c.kind === 'liked-low'
            ? `- You scored a set ${c.overall}/100, yet the owner KEPT it${c.note ? ` (your harshest note then: ${c.note})` : ''} — you were too strict there.`
            : `- You scored a set ${c.overall}/100, yet the owner REJECTED it${c.note ? ` (their reason: "${c.note}")` : ''} — you missed what mattered to them.`);
        return `\n### CALIBRATION — your past misses vs the owner's verdicts. Score with THEIR taste, not yours ###\n${lines.join('\n')}\n`;
    } catch { return ''; }
}

/** (2) One cheap single-image read — the batch quality gate. */
async function critiqueQuick(image: string, job: PraxisJob): Promise<{ overall: number; suggestions: string[] }> {
    const brand = await getCurrentBrand();
    const soul = await getBrandSoul();
    const prompt = `You are the studio's DESIGN CRITIC doing a fast pre-delivery check of ONE generated image.
BRAND: ${brand.name} — ${brand.description}
BRIEF: ${job.brief.trim() || '(open exploration)'}
### BRAND SOUL ###
${(soul?.fields ?? []).filter(f => f.value.trim()).map(f => `${f.key}: ${f.value}`).join('\n') || '(none)'}
${calibrationBlock()}
Score 0-100 overall against the soul and brief. If below 60, give at most 2 concrete art-direction fixes; otherwise return an empty list.
Output JSON: { "overall": number, "suggestions": [] }`;
    const parsed = await generateJson<{ overall: number; suggestions: string[] }>(prompt, [image]);
    return { overall: Number(parsed?.overall ?? 100), suggestions: (parsed?.suggestions ?? []).map(String).slice(0, 2) };
}

/** (4) Pre-flight: critique the PLAN before any image spend — a text call
 *  that catches soul conflicts 10× cheaper than a wasted generation. */
export async function preflightPlan(job: PraxisJob): Promise<string[]> {
    if (!job.plan) return [];
    const brand = await getCurrentBrand();
    const soul = await getBrandSoul();
    const concept = job.concepts.find(c => c.id === job.chosenConceptId);
    const prompt = `You are the studio's DESIGN CRITIC reviewing a production plan BEFORE the shoot.
BRAND: ${brand.name} — ${brand.description}
BRIEF: ${job.brief.trim() || '(open exploration)'}
CHOSEN DIRECTION: ${concept ? `${concept.title} — ${concept.rationale}` : '(unknown)'}
PLAN NOTE: ${job.plan.params.note || '(none)'}
STEPS:
${job.plan.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}
${directivesBlock(job)}
### BRAND SOUL (locked fields are red-lines) ###
${(soul?.fields ?? []).filter(f => f.value.trim()).map(f => `${f.key}${f.locked ? ' [LOCKED]' : ''}: ${f.value}`).join('\n') || '(none)'}

List UP TO 3 concrete conflicts between this plan and the soul or brief — things that would make the shot off-brand. Each warning ≤ 140 chars, actionable, naming the conflicting element. Empty array if the plan is clean.
Output JSON: { "warnings": [] }`;
    const parsed = await generateJson<{ warnings: string[] }>(prompt);
    return (parsed?.warnings ?? []).map(String).slice(0, 3);
}

/** The critic doesn't just warn — it can rewrite the plan to resolve its
 *  own pre-flight conflicts. Note + steps only; assets, refs and ratio stay. */
export async function revisePlan(job: PraxisJob, fixes: string[]): Promise<PraxisJob> {
    if (!job.plan) throw new Error('No production plan.');
    const brand = await getCurrentBrand();
    const soul = await getBrandSoul();
    const concept = job.concepts.find(c => c.id === job.chosenConceptId);
    const prompt = `You are the studio's DESIGN CRITIC. Your pre-flight review found conflicts in the production plan below. Rewrite the plan so every conflict is resolved while keeping the chosen direction, the brief and all owner directives intact.
BRAND: ${brand.name} — ${brand.description}
BRIEF: ${job.brief.trim() || '(open exploration)'}
CHOSEN DIRECTION: ${concept ? `${concept.title} — ${concept.rationale}` : '(unknown)'}
${directivesBlock(job)}
### BRAND SOUL (locked fields are red-lines) ###
${(soul?.fields ?? []).filter(f => f.value.trim()).map(f => `${f.key}${f.locked ? ' [LOCKED]' : ''}: ${f.value}`).join('\n') || '(none)'}

### CURRENT PLAN ###
NOTE (the one-sentence art direction the image model obeys): ${job.plan.params.note || '(none)'}
STEPS:
${job.plan.steps.map((st, i) => `${i + 1}. ${st}`).join('\n')}

### CONFLICTS TO RESOLVE ###
${fixes.map((f, i) => `${i + 1}. ${f}`).join('\n')}

Rewrite ONLY the note and the steps. Keep the same number of steps (±1), same shot purpose and framing intent. The new note must stay ONE sentence.
Output JSON: { "note": string, "steps": [] }`;
    const parsed = await generateJson<{ note: string; steps: string[] }>(prompt);
    const note = String(parsed?.note ?? '').trim();
    const steps = (parsed?.steps ?? []).map(String).filter(Boolean).slice(0, 8);
    if (!note || steps.length === 0) throw new Error('Critic returned an empty revision.');
    const next: PraxisJob = {
        ...job,
        plan: { ...job.plan, params: { ...job.plan.params, note }, steps },
        planWarnings: undefined,
        updatedAt: Date.now(),
    };
    await storage.upsertJob(next);
    return next;
}

export async function reviewJob(job: PraxisJob, results: GenerationResult[]): Promise<PraxisJob> {
    const brand = await getCurrentBrand();
    const soul = await getBrandSoul();
    const images = results.filter(r => r.image.kind === 'data').slice(0, 4).map(r => r.image.value);
    if (images.length === 0) throw new Error('No images to review.');

    const prompt = `You are the DESIGN CRITIC of the studio. Score the attached generated image(s) against the brand's soul.

BRAND: ${brand.name} — ${brand.description}
BRIEF: ${job.brief.trim() || '(open exploration — judge against the brand soul alone)'}

### BRAND SOUL ###
${(soul?.fields ?? []).filter(f => f.value.trim()).map(f => `${f.key}: ${f.value}`).join('\n') || '(no soul — score against the brand description)'}
${calibrationBlock()}
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
