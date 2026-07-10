import React, { useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Asset, Element, GenerationResult, KnowledgeRule, PraxisJob, Reference } from '../domain/types';
import { storage } from '../storage/local';
import { getCurrentBrandId } from '../domain/brand';
import {
    startJob, proposeConcepts, proposeWildcard, analyzeCompetitor, makePlan,
    makeMoodboard, anchorMood, executeJob, executeCampaign, reviewJob, closeJob,
    preflightPlan, recordCritCalibration, revisePlan,
} from '../studio/agents';
import { recordSignal, maybeDistill } from '../learning/learning';
import { attributeFeedback, getBrandSoul } from '../brain/soul';
import { BudgetExceededError } from '../engine/engine';
import { getApiKey } from '../engine/gemini';
import { openLightbox } from './lightbox';
import { DropZone } from './dropzone';
import { S, chip } from './styles';
import { SegmentedControl } from './SegmentedControl';

/**
 * STUDIO — the visible agent workflow:
 * BRIEF → CONCEPTS (pick one) → PLAN (approve) → EXECUTE → REVIEW → DONE.
 * Every stage is inspectable; the user can intervene before the next runs.
 */

const STAGES = ['brief', 'concepts', 'plan', 'execute', 'review', 'done'] as const;
const STAGE_LABEL: Record<string, string> = {
    brief: '1 · Brief', concepts: '2 · Concepts', plan: '3 · Plan',
    execute: '4 · Execute', review: '5 · Review', done: 'Done',
};

type StudioViewProps = {
    assets: Asset[];
    refs: Reference[];
    selectedAssets: Set<string>;
    selectedRefs: Set<string>;
    onNavigate?: (target: 'heroes' | 'library' | 'knowledge' | 'weave' | 'gallery' | 'system') => void;
};

export type StudioViewHandle = {
    reset: () => void;
};

const StudioView = React.forwardRef<StudioViewHandle, StudioViewProps>(function StudioView(
    { assets, refs, selectedAssets, selectedRefs, onNavigate },
    ref,
) {
    const [job, setJob] = useState<PraxisJob | null>(null);
    const [elements, setElements] = useState<Element[]>([]);
    const [noteText, setNoteText] = useState('');
    const [conceptFeedbackId, setConceptFeedbackId] = useState<string | null>(null);
    const [conceptFeedbackText, setConceptFeedbackText] = useState('');
    const [brief, setBrief] = useState('');
    const [count, setCount] = useState(2);
    const [results, setResults] = useState<GenerationResult[]>([]);
    const [busy, setBusy] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [feedback, setFeedback] = useState<Map<string, 'like' | 'dislike'>>(new Map());
    const [critiqueFor, setCritiqueFor] = useState<string | null>(null);
    const [moodDrafts, setMoodDrafts] = useState<GenerationResult[]>([]);
    const [moodFeedbackFor, setMoodFeedbackFor] = useState<string | null>(null);
    const [moodFeedbackText, setMoodFeedbackText] = useState('');
    const [imageSparkNote, setImageSparkNote] = useState('');
    const [critFixes, setCritFixes] = useState<Set<number>>(new Set());
    const [qualityGate, setQualityGate] = useState(true);
    const imageSparkRef = useRef<HTMLInputElement>(null);
    const composerRef = useRef<HTMLTextAreaElement>(null);
    const [composerGlow, setComposerGlow] = useState(false);
    const [noSourceWarn, setNoSourceWarn] = useState(false);
    const [soulCount, setSoulCount] = useState(0);
    const [showSetup, setShowSetup] = useState(false);
    const keyReady = getApiKey() !== null;

    useEffect(() => {
        storage.listElements().then(setElements);
        getBrandSoul().then(soul => setSoulCount((soul?.fields ?? []).filter(f => f.value.trim()).length)).catch(() => {});
    }, []);

    useEffect(() => { setNoSourceWarn(false); }, [selectedAssets, selectedRefs]);

    useEffect(() => {
        setCritFixes(new Set((job?.review?.suggestions ?? []).map((_, i) => i)));
    }, [job?.review]);

    const guard = async (label: string, fn: () => Promise<void>) => {
        setBusy(label); setError(null);
        try { await fn(); } catch (err: any) {
            setError(err instanceof BudgetExceededError ? err.message : err?.message || 'Failed');
        } finally { setBusy(''); }
    };

    /** Append a message to the job's conversation and persist. */
    const say = async (j: PraxisJob, role: 'user' | 'agent', text: string): Promise<PraxisJob> => {
        const next: PraxisJob = { ...j, transcript: [...(j.transcript ?? []), { role, text, at: Date.now() }], updatedAt: Date.now() };
        await storage.upsertJob(next);
        return next;
    };

    /** Owner interjection: lands in the transcript AND the directives that
     *  every subsequent model call obeys. Free — no API call. */
    const sendNote = async () => {
        if (!job || !noteText.trim()) return;
        const text = noteText.trim();
        setNoteText('');
        let next = await say(job, 'user', text);
        next = { ...next, directives: [...(next.directives ?? []), text] };
        next = await say(next, 'agent', 'Noted — this steers every step from here.');
        setJob(next);
    };

    const removeDirective = async (index: number) => {
        if (!job) return;
        const next: PraxisJob = { ...job, directives: (job.directives ?? []).filter((_, i) => i !== index), updatedAt: Date.now() };
        await storage.upsertJob(next);
        setJob(next);
    };

    const saveDirectiveAsRule = async (text: string) => {
        if (!job) return;
        const now = Date.now();
        const rule: KnowledgeRule = {
            id: crypto.randomUUID(),
            brandId: getCurrentBrandId(),
            scope: {},
            rule: text,
            polarity: 'must',
            confidence: 0.9,
            sources: [],
            enabled: true,
            createdAt: now,
            updatedAt: now,
        };
        await storage.upsertRule(rule);
        setJob(await say(job, 'agent', `Saved as a brand rule: "${text.length > 72 ? `${text.slice(0, 72)}...` : text}"`));
    };

    const sendConceptFeedback = async () => {
        if (!job || !conceptFeedbackId || !conceptFeedbackText.trim()) return;
        const concept = job.concepts.find(c => c.id === conceptFeedbackId);
        const text = conceptFeedbackText.trim();
        setConceptFeedbackText('');
        setConceptFeedbackId(null);
        let next = await say(job, 'user', `Feedback on "${concept?.title ?? 'this direction'}": ${text}`);
        next = { ...next, directives: [...(next.directives ?? []), `For direction "${concept?.title ?? conceptFeedbackId}": ${text}`], updatedAt: Date.now() };
        await storage.upsertJob(next);
        setJob(await say(next, 'agent', 'Noted. Choose this direction if you want me to draft the plan with that adjustment, or ask for a wildcard if the set still feels off.'));
    };

    const regenerateConceptsWithNote = () => guard('Regenerating directions…', async () => {
        if (!job) return;
        const text = noteText.trim();
        const existing = job.concepts;
        setNoteText('');
        setConceptFeedbackId(null);
        setConceptFeedbackText('');
        let next = await say(job, 'user', text ? `Overall brainstorm note: ${text}` : 'Generate three more different directions.');
        next = text
            ? { ...next, directives: [...(next.directives ?? []), `For the next concept set: ${text}`], updatedAt: Date.now() }
            : { ...next, updatedAt: Date.now() };
        await storage.upsertJob(next);
        const generated = await proposeConcepts(next, selectedInspirationRefs());
        const merged: PraxisJob = { ...generated, concepts: [...existing, ...generated.concepts], updatedAt: Date.now() };
        await storage.upsertJob(merged);
        setJob(await say(merged, 'agent', text
            ? 'I added three more directions from that note. The earlier ideas are still here, so you can compare or keep brainstorming.'
            : 'I added three more different directions. The earlier ideas are still here, so you can compare or keep brainstorming.'));
    });

    const begin = (opts: { force?: boolean; text?: string } = {}) => {
        if (!keyReady) {
            setError('No Gemini key yet — open System and paste your API key. It stays in this browser only.');
            return;
        }
        const text = (opts.text ?? brief).trim();
        if (!opts.force && selectedAssets.size === 0 && selectedRefs.size === 0 && (assets.length > 0 || refs.length > 0)) {
            setNoSourceWarn(true);
            return;
        }
        setNoSourceWarn(false);
        return guard('Concept agent thinking…', async () => {
        let j = await startJob(text); // empty brief = open exploration
        j = await say(j, 'user', text ? `Brief: ${text}` : 'Start an open exploration.');
        setJob(await say(await proposeConcepts(j, selectedInspirationRefs()), 'agent', 'I have three directions. Pick one to turn into a production plan, or ask for a collision if you want a stranger option.'));
        });
    };

    const choose = (conceptId: string) => guard('Producer drafting the plan…', async () => {
        if (!job) return;
        const concept = job.concepts.find(c => c.id === conceptId);
        const withChoice = await say(job, 'user', `Choose direction: ${concept?.title ?? conceptId}`);
        const planned = await makePlan(withChoice, conceptId, Array.from(selectedAssets));
        const planRefIds = Array.from(new Set([...Array.from(selectedRefs), ...(concept?.sourceRefIds ?? [])]));
        const withRefs = planned.plan && planRefIds.length > 0
            ? { ...planned, plan: { ...planned.plan, params: { ...planned.plan.params, referenceIds: planRefIds } } }
            : planned;
        // Pre-flight: text-only critique of the plan BEFORE any image spend.
        setBusy('Pre-flight — checking the plan against the brand soul…');
        let checked = withRefs;
        try {
            const warnings = await preflightPlan(withRefs);
            if (warnings.length > 0) {
                checked = { ...withRefs, planWarnings: warnings, updatedAt: Date.now() };
                await storage.upsertJob(checked);
            }
        } catch { /* pre-flight is best-effort */ }
        const summary = checked.plan
            ? `Plan drafted: ${checked.plan.params.note || 'a concrete shot plan is ready'}`
            : 'Plan drafted.';
        const warnNote = (checked.planWarnings ?? []).length > 0
            ? ` Pre-flight flagged ${(checked.planWarnings ?? []).length} conflict${(checked.planWarnings ?? []).length === 1 ? '' : 's'} with the brand soul — see the amber notes before spending.`
            : '';
        setJob(await say(checked, 'agent', `${summary}${warnNote} Confirm it, run low-cost mood studies, or adjust the details.`));
    });

    const wildcard = () => guard('Colliding concepts…', async () => {
        if (!job) return;
        const withAsk = await say(job, 'user', 'Give me a wildcard collision.');
        setJob(await say(await proposeWildcard(withAsk), 'agent', 'I added a wilder collision direction to the list.'));
    });

    const reverseBrief = (files: FileList | File[] | null) => guard('Reading the image…', async () => {
        const f = files?.[0];
        if (!f) return;
        const dataUrl = await new Promise<string>((res, rej) => {
            const r = new FileReader();
            r.onload = () => res(String(r.result));
            r.onerror = rej;
            r.readAsDataURL(f);
        });
        const { argument, counterBrief } = await analyzeCompetitor(dataUrl);
        setImageSparkNote(argument);
        setBrief(counterBrief);
    });

    const moodboard = () => guard('Moodboard…', async () => {
        if (!job) return;
        const withChoice = await say(job, 'user', 'Run low-cost mood studies first.');
        setMoodDrafts(await makeMoodboard(job, setBusy));
        setJob(await say(withChoice, 'agent', 'Three mood studies are ready. Anchor the one whose light or atmosphere should lead the final shot.'));
    });

    const reviseMoodboard = (draft?: GenerationResult, quick?: string) => guard('Updating mood studies…', async () => {
        if (!job) return;
        const text = (quick ?? moodFeedbackText).trim();
        if (!text) return;
        const label = draft ? `Mood study ${draft.id.slice(0, 6)}` : 'Mood studies';
        setMoodFeedbackFor(null);
        setMoodFeedbackText('');
        let next = await say(job, 'user', `${label} feedback: ${text}`);
        next = {
            ...next,
            directives: [...(next.directives ?? []), `Mood study revision: ${text}`],
            updatedAt: Date.now(),
        };
        await storage.upsertJob(next);
        const revised = await makeMoodboard(next, setBusy);
        setMoodDrafts(revised);
        setJob(await say(next, 'agent', 'Updated mood studies are ready. Anchor the best one before shooting the final large image.'));
    });

    const anchor = (resultId: string) => guard('Anchoring…', async () => {
        if (!job) return;
        setJob(await say(await anchorMood(job, resultId), 'user', 'Anchor this mood study for the final shot.'));
    });

    const campaign = () => guard('Campaign kit…', async () => {
        if (!job) return;
        const withChoice = await say(job, 'user', 'Execute the full campaign kit.');
        const { job: j, results: rs } = await executeCampaign(withChoice, setBusy, { qualityGate });
        setResults(rs);
        setJob(await say(j, 'agent', 'Campaign kit done — one concept across all four purposes.'));
    });

    const execute = () => guard('Executing…', async () => {
        if (!job) return;
        const withChoice = await say(job, 'user', `Execute ${count} final shot${count === 1 ? '' : 's'}.`);
        const { job: j, results: rs } = await executeJob(withChoice, count, setBusy, { qualityGate });
        setResults(rs);
        setJob(await say(j, 'agent', `${rs.length} shot${rs.length === 1 ? '' : 's'} done. Mark what works, or tell me exactly what broke so the next pass learns from it.`));
    });

    /** (1) Ticked critique suggestions become directives and drive one reshoot. */
    const reshootWithFixes = () => guard('Reshooting with critique fixes…', async () => {
        if (!job?.review) return;
        const fixes = job.review.suggestions.filter((_, i) => critFixes.has(i));
        if (fixes.length === 0) return;
        let next = await say(job, 'user', `Apply critique fixes: ${fixes.join(' · ')}`);
        next = { ...next, directives: [...(next.directives ?? []), ...fixes], stage: 'execute' as const, updatedAt: Date.now() };
        await storage.upsertJob(next);
        const { job: j, results: rs } = await executeJob(next, count, setBusy, { qualityGate });
        setResults(rs);
        setJob(await say(j, 'agent', `Reshot with ${fixes.length} critique fix${fixes.length === 1 ? '' : 'es'} as standing directives. Compare against the last pass.`));
    });

    const adoptWarning = async (i: number) => {
        if (!job) return;
        const w = (job.planWarnings ?? [])[i];
        if (!w) return;
        let next: PraxisJob = { ...job, directives: [...(job.directives ?? []), `Avoid: ${w}`], planWarnings: (job.planWarnings ?? []).filter((_, x) => x !== i), updatedAt: Date.now() };
        await storage.upsertJob(next);
        next = await say(next, 'user', `Adopt pre-flight fix: ${w}`);
        setJob(next);
    };

    /** The critic rewrites note + steps to clear its own warnings, then re-checks. */
    const reviseWithWarnings = () => guard('Critic revising the plan…', async () => {
        if (!job?.plan || (job.planWarnings ?? []).length === 0) return;
        const fixes = job.planWarnings ?? [];
        let next = await say(job, 'user', 'Revise the plan to resolve the pre-flight conflicts.');
        next = await revisePlan(next, fixes);
        setBusy('Re-checking the revised plan…');
        let remaining: string[] = [];
        try { remaining = await preflightPlan(next); } catch { /* best-effort */ }
        if (remaining.length > 0) {
            next = { ...next, planWarnings: remaining, updatedAt: Date.now() };
            await storage.upsertJob(next);
        }
        setJob(await say(next, 'agent', remaining.length === 0
            ? `Plan revised — note and steps rewritten, all ${fixes.length} conflict${fixes.length === 1 ? '' : 's'} cleared on re-check. Read it over, then shoot.`
            : `Plan revised, but re-check still flags ${remaining.length} conflict${remaining.length === 1 ? '' : 's'} — see the amber notes.`));
    });

    const dismissWarning = async (i: number) => {
        if (!job) return;
        const next: PraxisJob = { ...job, planWarnings: (job.planWarnings ?? []).filter((_, x) => x !== i), updatedAt: Date.now() };
        await storage.upsertJob(next);
        setJob(next);
    };

    const review = () => guard('Critic reviewing…', async () => {
        if (!job) return;
        setJob(await say(await reviewJob(job, results), 'agent', "The critic's read is in — close the job, or step back and iterate."));
    });

    const finish = () => guard('Closing…', async () => {
        if (!job) return;
        setJob(await closeJob(job));
    });

    const reset = () => { setJob(null); setResults([]); setBrief(''); setFeedback(new Map()); setMoodDrafts([]); };

    useImperativeHandle(ref, () => ({
        reset,
    }));

    /** Step back one stage — every decision is reversible. */
    const back = async () => {
        if (!job) return;
        const s = job.stage;
        if (s === 'concepts') {
            // Back to the brief: keep the text, abandon this job's concepts.
            setBrief(job.brief);
            const j = { ...job, stage: 'brief' as const, updatedAt: Date.now() };
            await storage.upsertJob(j);
            setJob(null);
            return;
        }
        const prev: Partial<PraxisJob> =
            s === 'plan' ? { stage: 'concepts', plan: undefined, chosenConceptId: undefined }
            : s === 'execute' ? { stage: 'plan' }
            : s === 'review' || s === 'done' ? { stage: 'execute', review: undefined }
            : {};
        if (!prev.stage) return;
        const j = { ...job, ...prev, updatedAt: Date.now() } as PraxisJob;
        await storage.upsertJob(j);
        setJob(j);
        if (prev.stage === 'plan') setResults([]);
    };

    const goToStage = async (target: typeof STAGES[number]) => {
        if (!job || busy) return;
        const currentIndex = STAGES.indexOf(job.stage);
        const targetIndex = STAGES.indexOf(target);
        if (targetIndex < 0 || targetIndex > currentIndex || target === job.stage) return;
        if (target === 'brief') {
            setBrief(job.brief);
            const j = { ...job, stage: 'brief' as const, updatedAt: Date.now() };
            await storage.upsertJob(j);
            setJob(null);
            setResults([]);
            setMoodDrafts([]);
            return;
        }
        const patch: Partial<PraxisJob> =
            target === 'concepts'
                ? { stage: 'concepts', plan: undefined, chosenConceptId: undefined, review: undefined }
                : target === 'plan'
                    ? { stage: 'plan', review: undefined }
                    : target === 'execute'
                        ? { stage: 'execute', review: undefined }
                        : target === 'review' && job.review
                            ? { stage: 'review' }
                            : target === 'done' && job.stage === 'done'
                                ? { stage: 'done' }
                                : {};
        if (!patch.stage) return;
        const j = { ...job, ...patch, updatedAt: Date.now() } as PraxisJob;
        await storage.upsertJob(j);
        setJob(j);
        if (target === 'concepts' || target === 'plan') setResults([]);
        if (target === 'concepts') setMoodDrafts([]);
    };

    /** Edit plan params (ratio / size) before executing. */
    const updatePlan = async (patch: Partial<import('../domain/types').GenerationParams>) => {
        if (!job?.plan) return;
        const j: PraxisJob = {
            ...job,
            plan: { ...job.plan, params: { ...job.plan.params, ...patch } },
            updatedAt: Date.now(),
        };
        await storage.upsertJob(j);
        setJob(j);
    };

    const rate = async (r: GenerationResult, rating: 'like' | 'dislike', reason?: string) => {
        await recordSignal(r, rating, reason);
        // Critic calibration: the owner's verdict vs the critic's score.
        if (job?.review && job.review.axisScores.length > 0) {
            const worst = job.review.axisScores.reduce((w, a) => (a.score < w.score ? a : w), job.review.axisScores[0]);
            if (rating === 'like' && job.review.overall < 65) recordCritCalibration({ kind: 'liked-low', overall: job.review.overall, note: worst?.note ?? '' });
            if (rating === 'dislike' && job.review.overall >= 75) recordCritCalibration({ kind: 'disliked-high', overall: job.review.overall, note: reason ?? '' });
        }
        if (rating === 'dislike' && reason) attributeFeedback(reason); // fire-and-forget
        setFeedback(prev => new Map(prev).set(r.id, rating));
        setCritiqueFor(null);
        if (job) {
            const text = rating === 'like'
                ? `Keep result ${r.id.slice(0, 6)}: this direction works.`
                : `Result ${r.id.slice(0, 6)} needs revision: ${reason ?? 'not right yet'}.`;
            let next = await say(job, 'user', text);
            if (rating === 'dislike' && reason) {
                next = { ...next, directives: [...(next.directives ?? []), reason], updatedAt: Date.now() };
                await storage.upsertJob(next);
            }
            next = await say(next, 'agent', rating === 'like'
                ? 'Logged. I will treat this image as positive taste evidence.'
                : 'Logged. I added that as a working directive for the next pass.');
            setJob(next);
        }
        maybeDistill();
    };

    const saveResult = async (r: GenerationResult) => {
        await recordSignal(r, 'save');
        setFeedback(prev => new Map(prev).set(r.id, 'like'));
        setError(null);
        setBusy('');
        if (job) {
            setJob(await say(job, 'user', `Save result ${r.id.slice(0, 6)} as an approved output.`));
        }
        maybeDistill();
    };

    const discardResult = async (r: GenerationResult) => {
        await recordSignal(r, 'discard');
        setFeedback(prev => new Map(prev).set(r.id, 'dislike'));
        setResults(prev => prev.filter(x => x.id !== r.id));
        setCritiqueFor(null);
        if (job) {
            setJob(await say(job, 'user', `Discard result ${r.id.slice(0, 6)}.`));
        }
        maybeDistill();
    };

    const stage = job?.stage ?? 'brief';
    const elementById = (id: string) => elements.find(e => e.id === id);
    const refById = (id: string) => refs.find(r => r.id === id);
    const selectedInspirationRefs = () => refs.filter(r => selectedRefs.has(r.id));
    const conceptSourceRefs = (c: { sourceRefIds?: string[] }) =>
        (c.sourceRefIds ?? []).map(refById).filter((r): r is Reference => !!r);
    const chosenConcept = job?.concepts.find(c => c.id === job.chosenConceptId);
    const actionChip = (active = false): React.CSSProperties => ({
        ...chip(active),
        minHeight: 28,
        fontSize: 10.5,
        fontWeight: 800,
        borderRadius: 999,
    });
    const agentBubble: React.CSSProperties = {
        alignSelf: 'flex-start',
        maxWidth: '82%',
        padding: '9px 12px',
        borderRadius: '13px 13px 13px 4px',
        fontSize: 12,
        lineHeight: 1.5,
        background: 'rgba(255,255,255,0.72)',
        color: '#18181b',
        border: '1px solid rgba(212,212,216,0.5)',
        backdropFilter: 'blur(18px)',
        WebkitBackdropFilter: 'blur(18px)',
        boxShadow: '0 4px 12px rgba(0,0,0,0.05)',
    };
    const conceptPanel: React.CSSProperties = {
        width: '100%',
        maxWidth: 'none',
        alignSelf: 'stretch',
        padding: 12,
        borderRadius: 14,
        background: 'rgba(255,255,255,0.54)',
        color: '#18181b',
        border: '1px solid rgba(212,212,216,0.52)',
        backdropFilter: 'blur(22px)',
        WebkitBackdropFilter: 'blur(22px)',
        boxShadow: '0 18px 44px rgba(15,23,42,0.06)',
        boxSizing: 'border-box',
    };
    const userBubble: React.CSSProperties = {
        alignSelf: 'flex-end',
        maxWidth: '78%',
        padding: '8px 12px',
        borderRadius: '13px 13px 4px 13px',
        fontSize: 12,
        lineHeight: 1.5,
        background: '#18181b',
        color: '#fff',
        boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
    };
    const critiqueChips = [
        'Product shape is off',
        'Material or texture changed',
        'Light is wrong',
        'Composition feels weak',
        'Too staged',
        'Not close enough to inspiration',
        'Not on brand',
    ];
    const startCards = [
        {
            title: 'Campaign image',
            detail: 'Start with a polished hero shot. Studio will propose directions, draft a production plan, and create final images with copy space.',
            prompt: 'Campaign hero image — brand-led, polished, with clear copy space',
        },
        {
            title: 'Product detail / PDP',
            detail: 'Create clean product-focused imagery for ecommerce, detail pages, launch pages, and catalog systems.',
            prompt: 'Product detail / PDP image — clean, accurate, premium but not over-staged',
        },
        {
            title: 'Image spark',
            detail: 'Drop any image, mood, texture, room, outfit, object, or visual fragment. Studio will turn the vibe into a usable creative brief.',
            prompt: '',
            action: () => imageSparkRef.current?.click(),
        },
        {
            title: 'Open exploration',
            detail: 'Start with no brief. Studio will inspect your selected sources and suggest what the brand should make next.',
            prompt: '',
        },
    ];
    const setupCards = [
        {
            title: 'Manage brand assets',
            detail: 'Upload products, hero objects, people, packaging, or source-of-truth images. These keep generated work visually accurate.',
            action: () => onNavigate?.('heroes'),
            cta: 'Open Assets',
            done: assets.length > 0,
            stat: assets.length > 0 ? `${assets.length} ready` : 'None yet — start here',
        },
        {
            title: 'Build inspiration',
            detail: 'Collect references for lighting, atmosphere, layout, color, materials, and art direction without copying their subjects.',
            action: () => onNavigate?.('library'),
            cta: 'Open Inspiration',
            done: refs.length > 0,
            stat: refs.length > 0 ? `${refs.length} collected` : 'None yet',
        },
        {
            title: 'Define the brand',
            detail: 'Maintain brand memory, rules, essence, and red lines so every task starts with the same strategic baseline.',
            action: () => onNavigate?.('knowledge'),
            cta: 'Open Brand',
            done: soulCount > 0,
            stat: soulCount > 0 ? `${soulCount} soul fields` : 'Not defined yet',
        },
        {
            title: 'Work on Canvas',
            detail: 'Arrange assets, references, notes, and outputs on a persistent visual board when a task needs more structure.',
            action: () => onNavigate?.('weave'),
            cta: 'Open Canvas',
            done: true,
            stat: '',
        },
    ];
    const setupDone = keyReady && assets.length > 0 && refs.length > 0 && soulCount > 0;
    const sourceSummary = `${selectedAssets.size} asset${selectedAssets.size === 1 ? '' : 's'} · ${selectedRefs.size} inspiration`;

    return (
        <div style={{ maxWidth: 1480, margin: '0 auto', padding: '18px 22px', display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
            {/* Stage rail */}
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                {STAGES.map((s, i) => {
                    const currentIndex = STAGES.indexOf(stage as typeof STAGES[number]);
                    const stepIndex = STAGES.indexOf(s);
                    const reached = !!job && stepIndex <= currentIndex;
                    const active = stage === s;
                    const clickable = reached && !active && !busy;
                    return (
                        <React.Fragment key={s}>
                            {i > 0 && <span style={{ color: '#d4d4d8' }}>→</span>}
                            <button
                                type="button"
                                disabled={!clickable}
                                onClick={() => goToStage(s)}
                                title={clickable ? `Go back to ${STAGE_LABEL[s]}` : active ? 'Current step' : 'Not reached yet'}
                                style={{
                                    fontSize: 11,
                                    fontWeight: 700,
                                    padding: '4px 10px',
                                    borderRadius: 999,
                                    border: '1px solid transparent',
                                    background: active ? '#18181b' : reached ? 'rgba(255,255,255,0.72)' : '#f4f4f5',
                                    color: active ? '#fff' : reached ? '#52525b' : '#a1a1aa',
                                    cursor: clickable ? 'pointer' : 'default',
                                    boxShadow: reached && !active ? 'inset 0 1px 0 rgba(255,255,255,0.72)' : 'none',
                                    opacity: reached || active ? 1 : 0.68,
                                }}
                            >
                                {STAGE_LABEL[s]}
                            </button>
                        </React.Fragment>
                    );
                })}
                {job && (
                    <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                        <button style={S.btnGhost} disabled={!!busy} onClick={back} title="Step back one stage">← Back</button>
                        <button style={S.btnGhost} onClick={reset}>New job</button>
                    </span>
                )}
            </div>

            {error && <div style={S.err}>{error}</div>}

            {/* Conversation — the studio reports, the owner steers */}
            {job && (job.transcript ?? []).length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                    {(job.transcript ?? []).map((m, i) => (
                        <div key={i} style={{
                            ...(m.role === 'user' ? userBubble : agentBubble),
                            animation: 'praxis-pop 240ms cubic-bezier(0.22,1,0.36,1)',
                        }}>
                            {m.text}
                        </div>
                    ))}
                    {busy && (
                        <div className="praxis-running praxis-running-card" style={{ ...agentBubble, display: 'inline-flex', alignItems: 'center', gap: 10, color: '#52525b', background: 'rgba(255,255,255,0.82)', border: '1px solid rgba(212,212,216,0.68)' }}>
                            <span className="praxis-busy-dot" />
                            <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                                <span style={{ fontSize: 9.5, fontWeight: 850, letterSpacing: 0.7, textTransform: 'uppercase', color: '#a1a1aa' }}>
                                    Running
                                </span>
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12, color: '#3f3f46' }}>
                                    {busy}
                                    <span className="praxis-busy-dots" aria-hidden="true"><span /><span /><span /></span>
                                </span>
                            </span>
                        </div>
                    )}
                </div>
            )}
            {!job && busy && (
                <div className="praxis-running praxis-running-card" style={{ ...agentBubble, display: 'inline-flex', alignItems: 'center', gap: 10, color: '#52525b', background: 'rgba(255,255,255,0.82)', border: '1px solid rgba(212,212,216,0.68)' }}>
                    <span className="praxis-busy-dot" />
                    <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        <span style={{ fontSize: 9.5, fontWeight: 850, letterSpacing: 0.7, textTransform: 'uppercase', color: '#a1a1aa' }}>
                            Running
                        </span>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12, color: '#3f3f46' }}>
                            {busy}
                            <span className="praxis-busy-dots" aria-hidden="true"><span /><span /><span /></span>
                        </span>
                    </span>
                </div>
            )}

            {/* Stage 1 — brief */}
            {!job && (
                <DropZone onFiles={reverseBrief} hint="Drop any image to spark a creative brief">
                <div style={{ minHeight: 'calc(100vh - 150px)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 18, padding: '26px 0 42px' }}>
                    <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center', maxWidth: 760 }}>
                        <div style={{ width: 52, height: 52, borderRadius: 999, background: 'radial-gradient(circle at 32% 28%, #d7dce6, #5b8def 58%, #18181b)', boxShadow: '0 16px 34px rgba(37,99,235,0.20)' }} />
                        <div style={{ fontSize: 28, fontWeight: 850, color: '#18181b', letterSpacing: -0.2 }}>What are we making today?</div>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center', maxWidth: 720 }}>
                            {[
                                ['1', 'Tick Assets & Inspiration in the left sidebar'],
                                ['2', 'Describe the shot — or drop any image'],
                                ['3', 'Approve & critique — the studio learns your brand'],
                            ].map(([n, t]) => (
                                <span key={n} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '6px 12px', borderRadius: 999, border: '1px solid rgba(212,212,216,0.6)', background: 'rgba(255,255,255,0.6)', fontSize: 11.5, color: '#52525b', fontWeight: 600 }}>
                                    <span style={{ width: 16, height: 16, borderRadius: 999, background: '#18181b', color: '#fff', fontSize: 9.5, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{n}</span>
                                    {t}
                                </span>
                            ))}
                        </div>
                    </div>
                    {!keyReady && (
                        <div style={{ width: 'min(920px, 100%)', display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderRadius: 16, border: '1px solid rgba(180,83,9,0.25)', background: 'rgba(255,251,235,0.92)', boxShadow: '0 12px 30px rgba(180,83,9,0.08)', animation: 'praxis-pop 240ms cubic-bezier(0.22,1,0.36,1)' }}>
                            <span style={{ fontSize: 18 }} aria-hidden="true">🔑</span>
                            <span style={{ flex: 1, minWidth: 240, fontSize: 12, color: '#78350f', lineHeight: 1.55 }}>
                                <b>One step before your first image:</b> connect a Gemini API key. It stays in this browser only — nothing is uploaded anywhere. A finished image costs about $0.04.
                            </span>
                            <button style={{ ...S.btn, minWidth: 150 }} onClick={() => onNavigate?.('system')}>Connect in System →</button>
                        </div>
                    )}
                    <div style={{ width: 'min(920px, 100%)', display: 'flex', flexDirection: 'column', gap: 8, padding: 10, borderRadius: 24, background: 'rgba(255,255,255,0.82)', backdropFilter: 'blur(28px) saturate(1.16)', WebkitBackdropFilter: 'blur(28px) saturate(1.16)', border: '1px solid rgba(212,212,216,0.7)', transition: 'box-shadow 320ms cubic-bezier(0.22,1,0.36,1)', boxShadow: composerGlow ? '0 0 0 3px rgba(91,141,239,0.42), 0 22px 54px rgba(15,23,42,0.16)' : '0 22px 54px rgba(15,23,42,0.12)' }}>
                        <textarea
                            ref={composerRef}
                            value={brief}
                            onChange={e => setBrief(e.target.value)}
                            onKeyDown={e => {
                                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) begin();
                            }}
                            placeholder="Example: Create a premium campaign hero using the selected product assets and the selected lighting references. Keep the product accurate, leave space for headline copy, and make it feel calm, expensive, and launch-ready."
                            style={{ ...S.input, width: '100%', minHeight: 146, border: 'none', background: 'transparent', resize: 'vertical', fontSize: 16, lineHeight: 1.45, padding: '12px 10px' }}
                        />
                        {noSourceWarn && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '9px 12px', borderRadius: 12, background: 'rgba(255,251,235,0.95)', border: '1px solid rgba(180,83,9,0.22)', animation: 'praxis-pop 240ms cubic-bezier(0.22,1,0.36,1)' }}>
                                <span style={{ flex: 1, minWidth: 220, fontSize: 11.5, color: '#78350f', lineHeight: 1.5 }}>
                                    No Assets or Inspiration selected — the studio will invent everything from words alone. Tick sources in the left sidebar to keep products accurate.
                                </span>
                                <button style={S.btnGhost} onClick={() => setNoSourceWarn(false)}>I'll pick sources</button>
                                <button style={{ ...S.btn, minWidth: 132 }} disabled={!!busy} onClick={() => begin({ force: true })}>Generate anyway</button>
                            </div>
                        )}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', borderTop: '1px solid rgba(228,228,231,0.72)', padding: '8px 4px 2px' }}>
                            <span style={{ fontSize: 11, fontWeight: 800, color: '#71717a' }}>Sources · {sourceSummary}</span>
                            <button style={S.btnGhost} disabled={!!busy} onClick={() => imageSparkRef.current?.click()} title="Attach any image to spark a creative brief">Attach image</button>
                            <span style={{ marginLeft: 'auto', fontSize: 10.5, color: '#a1a1aa' }}>⌘ Enter · from ~$0.04/image</span>
                            <button style={{ ...S.btn, minWidth: 82 }} disabled={!!busy} onClick={() => begin()}>Send</button>
                        </div>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10, width: '100%', maxWidth: 920 }}>
                        {startCards.map(card => (
                            <button
                                key={card.title}
                                onClick={() => {
                                    if (card.action) { card.action(); return; }
                                    if (card.title === 'Open exploration') { setBrief(''); begin({ force: true, text: '' }); return; }
                                    setBrief(card.prompt);
                                    setComposerGlow(true);
                                    window.setTimeout(() => composerRef.current?.focus(), 30);
                                    window.setTimeout(() => setComposerGlow(false), 900);
                                }}
                                style={{
                                    minHeight: 128,
                                    textAlign: 'left',
                                    border: brief === card.prompt && card.prompt ? '1.5px solid #18181b' : '1px solid rgba(212,212,216,0.62)',
                                    background: 'rgba(255,255,255,0.62)',
                                    backdropFilter: 'blur(18px)',
                                    WebkitBackdropFilter: 'blur(18px)',
                                    borderRadius: 14,
                                    padding: 14,
                                    cursor: 'pointer',
                                    display: 'flex',
                                    flexDirection: 'column',
                                    gap: 8,
                                    boxShadow: '0 10px 26px rgba(0,0,0,0.05)',
                                }}
                            >
                                <span style={{ fontSize: 12.5, fontWeight: 850, color: '#18181b' }}>{card.title}</span>
                                <span style={{ fontSize: 11, color: '#71717a', lineHeight: 1.45, whiteSpace: 'normal' }}>{card.detail}</span>
                            </button>
                        ))}
                    </div>
                    <div style={{ width: '100%', maxWidth: 920, display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                            <span style={{ ...S.label, color: setupDone ? '#15803d' : '#71717a' }}>{setupDone ? 'PLATFORM READY ✓' : 'SET UP THE PLATFORM'}</span>
                            {setupDone ? (
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                                    <span style={{ fontSize: 11, color: '#a1a1aa' }}>{assets.length} assets · {refs.length} inspiration · {soulCount} brand fields · Gemini connected</span>
                                    <button style={S.btnGhost} onClick={() => setShowSetup(v => !v)}>{showSetup ? 'Hide' : 'Show'}</button>
                                </span>
                            ) : (
                                <span style={{ fontSize: 11, color: '#a1a1aa' }}>These areas make each task smarter before you press Send.</span>
                            )}
                        </div>
                        {(!setupDone || showSetup) && (
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10 }}>
                            {setupCards.map(card => (
                                <button
                                    key={card.title}
                                    onClick={card.action}
                                    style={{
                                        minHeight: 148,
                                        textAlign: 'left',
                                        border: '1px solid rgba(212,212,216,0.68)',
                                        background: 'rgba(255,255,255,0.68)',
                                        borderRadius: 14,
                                        padding: 14,
                                        cursor: 'pointer',
                                        display: 'flex',
                                        flexDirection: 'column',
                                        gap: 9,
                                        boxShadow: '0 10px 26px rgba(0,0,0,0.045)',
                                    }}
                                >
                                    <span style={{ fontSize: 12.5, fontWeight: 850, color: '#18181b' }}>{card.title}</span>
                                    {card.stat && (
                                        <span style={{ alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 8px', borderRadius: 999, fontSize: 9.5, fontWeight: 800, letterSpacing: 0.3, background: card.done ? 'rgba(22,163,74,0.10)' : 'rgba(180,83,9,0.10)', color: card.done ? '#15803d' : '#92400e', border: `1px solid ${card.done ? 'rgba(22,163,74,0.25)' : 'rgba(180,83,9,0.22)'}` }}>
                                            {card.done ? '✓' : '•'} {card.stat}
                                        </span>
                                    )}
                                    <span style={{ flex: 1, fontSize: 11, color: '#71717a', lineHeight: 1.45, whiteSpace: 'normal' }}>{card.detail}</span>
                                    <span style={{ fontSize: 10.5, fontWeight: 850, color: '#18181b' }}>{card.cta} →</span>
                                </button>
                            ))}
                        </div>
                        )}
                    </div>
                    {imageSparkNote && (
                        <div style={{ fontSize: 11, color: '#92400e', lineHeight: 1.5 }}>
                            Visual read: {imageSparkNote} — a draft brief is ready above. Edit it, select sources, then send.
                        </div>
                    )}
                    <input ref={imageSparkRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={e => reverseBrief(e.target.files)} />
                </div>
                </DropZone>
            )}

            {/* Stage 2 — concepts */}
            {job && stage === 'concepts' && (
                <div style={{ ...conceptPanel, display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            <span style={{ ...S.label, color: '#71717a' }}>PICK ONE DIRECTION</span>
                            <span style={{ fontSize: 11, color: '#a1a1aa' }}>{job.concepts.length} brainstorm directions · choose one or keep expanding</span>
                        </div>
                        <button style={actionChip(false)} disabled={!!busy} onClick={wildcard} title="Collide two contradictory concepts">
                            Wildcard collision
                        </button>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 360px), 1fr))', gap: 12, alignItems: 'stretch' }}>
                    {job.concepts.map(c => (
                        <div key={c.id} style={{ border: '1px solid rgba(212,212,216,0.58)', background: 'rgba(255,255,255,0.62)', borderRadius: 12, padding: 14, display: 'flex', flexDirection: 'column', gap: 9, minHeight: 360, boxShadow: '0 12px 30px rgba(15,23,42,0.05)', minWidth: 0 }}>
                            <div style={{ fontSize: 16, fontWeight: 850, lineHeight: 1.2 }}>{c.title}</div>
                            <div style={{ fontSize: 10, fontWeight: 700, color: '#a1a1aa', letterSpacing: 0.5 }}>
                                {c.realism.toUpperCase()}{c.contextModeId ? ` · ${c.contextModeId}` : ''}
                            </div>
                            <div style={{ fontSize: 13, lineHeight: 1.55 }}>{c.rationale}</div>
                            <div style={{ fontSize: 11.5, color: '#71717a', lineHeight: 1.5 }}>{c.nsiSummary}</div>
                            {conceptSourceRefs(c).length > 0 && (
                                <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
                                    <span style={{ fontSize: 9.5, fontWeight: 800, color: '#a1a1aa', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                                        Inspired by
                                    </span>
                                    {conceptSourceRefs(c).map(r => (
                                        <button
                                            key={r.id}
                                            type="button"
                                            title={r.name}
                                            onClick={() => openLightbox(r.image.value)}
                                            style={{
                                                width: 34,
                                                height: 34,
                                                borderRadius: 8,
                                                border: '1px solid rgba(212,212,216,0.75)',
                                                padding: 0,
                                                overflow: 'hidden',
                                                background: 'rgba(255,255,255,0.68)',
                                                cursor: 'zoom-in',
                                                boxShadow: '0 8px 18px rgba(15,23,42,0.08)',
                                            }}
                                        >
                                            <img src={r.image.value} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                                        </button>
                                    ))}
                                </div>
                            )}
                            {c.elementIds.some(id => elementById(id)) && (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
                                    <span style={{ fontSize: 9.5, fontWeight: 800, color: '#a1a1aa', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                                        Mixes
                                    </span>
                                    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', minWidth: 0 }}>
                                        {c.elementIds.map(id => elementById(id)).filter((el): el is Element => !!el).slice(0, 4).map(el => {
                                            const source = refById(el.sourceRefId)?.name;
                                            return (
                                                <span
                                                    key={el.id}
                                                    title={`${el.concept}${source ? ` from ${source}` : ''}`}
                                                    style={{
                                                        maxWidth: '100%',
                                                        minWidth: 0,
                                                        padding: '4px 7px',
                                                        borderRadius: 999,
                                                        border: '1px solid rgba(212,212,216,0.68)',
                                                        background: 'rgba(250,250,250,0.72)',
                                                        fontSize: 10,
                                                        fontWeight: 750,
                                                        color: '#71717a',
                                                        overflow: 'hidden',
                                                        textOverflow: 'ellipsis',
                                                        whiteSpace: 'nowrap',
                                                    }}
                                                >
                                                    {el.concept}
                                                </span>
                                            );
                                        })}
                                        {c.elementIds.length > 4 && (
                                            <span style={{ padding: '4px 7px', borderRadius: 999, background: 'rgba(244,244,245,0.72)', fontSize: 10, fontWeight: 750, color: '#a1a1aa' }}>
                                                +{c.elementIds.length - 4}
                                            </span>
                                        )}
                                    </div>
                                </div>
                            )}
                            <div style={{ display: 'flex', gap: 7, marginTop: 'auto', flexWrap: 'wrap' }}>
                                <button style={{ ...actionChip(false), flex: 1, justifyContent: 'center' }} disabled={!!busy} onClick={() => choose(c.id)}>
                                    Choose
                                </button>
                                <button
                                    style={actionChip(conceptFeedbackId === c.id)}
                                    disabled={!!busy}
                                    onClick={() => {
                                        setConceptFeedbackId(prev => prev === c.id ? null : c.id);
                                        setConceptFeedbackText('');
                                    }}
                                    title="Optional: steer this specific direction before choosing it"
                                >
                                    Feedback
                                </button>
                            </div>
                            {conceptFeedbackId === c.id && (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 7, borderRadius: 8, background: 'rgba(244,244,245,0.72)', border: '1px solid rgba(228,228,231,0.72)' }}>
                                    <div style={{ fontSize: 10, color: '#71717a', lineHeight: 1.45 }}>
                                        Optional: tell Studio how to adjust only this direction before you choose it.
                                    </div>
                                    <div style={{ display: 'flex', gap: 5 }}>
                                        <input
                                            value={conceptFeedbackText}
                                            onChange={e => setConceptFeedbackText(e.target.value)}
                                            onKeyDown={e => { if (e.key === 'Enter') sendConceptFeedback(); }}
                                            placeholder="e.g. keep this, but make it less staged"
                                            style={{ ...S.input, minHeight: 30, flex: 1, fontSize: 11 }}
                                        />
                                        <button style={S.btn} disabled={!conceptFeedbackText.trim() || !!busy} onClick={sendConceptFeedback}>Send</button>
                                    </div>
                                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                                        {['less staged', 'more premium', 'more copy space', 'closer to product truth'].map(s => (
                                            <button key={s} style={actionChip(false)} onClick={() => setConceptFeedbackText(s)}>{s}</button>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    ))}
                    </div>
                </div>
            )}

            {/* Stage 3 — plan */}
            {job && stage === 'plan' && job.plan && (
                <div style={{ ...agentBubble, maxWidth: '100%', display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <span style={{ ...S.label, color: '#71717a' }}>CONFIRM THE PLAN — {chosenConcept?.title}</span>
                    <div style={{ fontSize: 13, lineHeight: 1.55, color: '#18181b' }}>
                        I am preparing to shoot <strong>{job.plan.params.purpose}</strong> in <strong>{job.plan.params.ratio}</strong>: {job.plan.params.note || 'a brand-led scene with the selected assets.'}
                    </div>
                    <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: 1.7 }}>
                        {job.plan.steps.map((s, i) => <li key={i}>{s}</li>)}
                    </ol>
                    {(job.planWarnings ?? []).length > 0 && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '9px 12px', borderRadius: 8, background: 'rgba(255,251,235,0.95)', border: '1px solid rgba(180,83,9,0.22)', animation: 'praxis-pop 240ms cubic-bezier(0.22,1,0.36,1)' }}>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                                <span style={{ ...S.label, color: '#92400e' }}>PRE-FLIGHT — CONFLICTS WITH THE BRAND SOUL</span>
                                <button style={{ ...S.btn, minHeight: 26, fontSize: 10.5, padding: '0 10px' }} disabled={!!busy} onClick={reviseWithWarnings}
                                    title="The critic rewrites the plan note and steps to resolve every conflict, then re-checks its own work">
                                    Let the critic revise the plan
                                </button>
                            </div>
                            {(job.planWarnings ?? []).map((w, i) => (
                                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <span style={{ flex: 1, fontSize: 11.5, color: '#78350f', lineHeight: 1.5 }}>{w}</span>
                                    <button style={{ ...S.btnGhost, minHeight: 26, fontSize: 10.5 }} disabled={!!busy} onClick={() => adoptWarning(i)} title="Turn this warning into a standing directive for every later step">Fix — add as directive</button>
                                    <button style={{ ...S.btnGhost, minHeight: 26, fontSize: 10.5, minWidth: 26, padding: 0 }} disabled={!!busy} onClick={() => dismissWarning(i)} title="Ignore this warning">✕</button>
                                </div>
                            ))}
                        </div>
                    )}
                    <div style={{ fontSize: 11, color: '#71717a', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span>Shot setup · {job.plan.params.purpose} · {job.plan.elementIds.length} mixed elements</span>
                    </div>
                    <textarea
                        value={job.plan.params.note ?? ''}
                        onChange={e => updatePlan({ note: e.target.value })}
                        placeholder="The one-sentence art direction the image model will obey — edit freely"
                        title="Editable — this exact sentence goes into the generation prompt"
                        style={{ ...S.input, width: '100%', minHeight: 44, boxSizing: 'border-box', resize: 'vertical', fontSize: 12, lineHeight: 1.5 }}
                    />
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <span style={S.label}>RATIO</span>
                        <SegmentedControl
                            ariaLabel="Production ratio"
                            disabled={!!busy}
                            value={job.plan!.params.ratio}
                            onChange={ratio => updatePlan({ ratio })}
                            options={(['1:1', '16:9', '4:3', '3:4', '9:16'] as const).map(r => ({ value: r, label: r }))}
                            minWidth={232}
                        />
                        <span style={{ ...S.label, marginLeft: 8 }}>SIZE</span>
                        <SegmentedControl
                            ariaLabel="Production pixel size"
                            disabled={!!busy}
                            value={job.plan!.params.size ?? '1K'}
                            onChange={size => updatePlan({ size })}
                            options={(['1K', '2K', '4K'] as const).map(s => ({ value: s, label: s }))}
                            minWidth={132}
                        />
                        <span style={{ fontSize: 10, color: '#a1a1aa' }}>4K needs the pro model; unsupported sizes fall back automatically</span>
                    </div>
                    {/* Moodboard — pick direction on visuals, cheap flash drafts */}
                    <div style={{ borderTop: '1px solid #f4f4f5', paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                            <button style={actionChip(false)} disabled={!!busy} onClick={moodboard}>
                                See mood studies first
                            </button>
                            {job.plan.moodAnchorResultId && <span style={{ fontSize: 10, color: '#059669' }}>mood anchored — its pixels will lead the final shot</span>}
                        </div>
                        {moodDrafts.length > 0 && (
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 300px))', gap: 12 }}>
                                {moodDrafts.map(d => (
                                    <div key={d.id}
                                        style={{ padding: 4, borderRadius: 12, background: 'rgba(255,255,255,0.72)', border: job.plan!.moodAnchorResultId === d.id ? '2.5px solid #059669' : '1px solid #e4e4e7', display: 'flex', flexDirection: 'column', gap: 5 }}>
                                        <img src={d.image.value} alt="" onClick={() => openLightbox(d.image.value)}
                                            style={{ width: '100%', aspectRatio: '1 / 1', objectFit: 'cover', borderRadius: 8, display: 'block', cursor: 'zoom-in' }} />
                                        <div style={{ display: 'flex', gap: 3, marginTop: 3 }}>
                                            <button onClick={() => anchor(d.id)} disabled={!!busy}
                                                style={{ ...S.btnGhost, flex: 1, fontSize: 10 }}>
                                                {job.plan!.moodAnchorResultId === d.id ? 'Anchored' : 'Anchor'}
                                            </button>
                                            <button
                                                title="Give feedback and regenerate the mood studies"
                                                disabled={!!busy}
                                                onClick={() => {
                                                    setMoodFeedbackFor(prev => prev === d.id ? null : d.id);
                                                    setMoodFeedbackText('');
                                                }}
                                                style={{ ...S.btnGhost, flex: 1, fontSize: 10 }}
                                            >
                                                Feedback
                                            </button>
                                            <button title="Save to Gallery" disabled={!!busy}
                                                onClick={async () => { await recordSignal(d, 'save'); window.alert('Saved to Gallery.'); }}
                                                style={{ ...S.btnGhost, fontSize: 10 }}>Save</button>
                                        </div>
                                        {moodFeedbackFor === d.id && (
                                            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, padding: 6, borderRadius: 8, background: 'rgba(244,244,245,0.75)', border: '1px solid rgba(228,228,231,0.72)' }}>
                                                <input
                                                    value={moodFeedbackText}
                                                    onChange={e => setMoodFeedbackText(e.target.value)}
                                                    placeholder="e.g. warmer light, less empty"
                                                    style={{ ...S.input, minHeight: 28, fontSize: 10.5 }}
                                                />
                                                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                                                    {['warmer light', 'more copy space', 'less staged', 'closer to product truth'].map(s => (
                                                        <button key={s} style={actionChip(moodFeedbackText === s)} disabled={!!busy} onClick={() => setMoodFeedbackText(s)}>{s}</button>
                                                    ))}
                                                </div>
                                                <button style={{ ...S.btn, minHeight: 28, fontSize: 10.5 }} disabled={!moodFeedbackText.trim() || !!busy} onClick={() => reviseMoodboard(d)}>
                                                    Update drafts
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <span style={S.label}>VARIANTS</span>
                        <SegmentedControl
                            ariaLabel="Variant count"
                            value={count}
                            onChange={setCount}
                            options={[1, 2, 3].map(n => ({ value: n, label: String(n) }))}
                            minWidth={112}
                        />
                        <button style={S.btn} disabled={!!busy} onClick={execute}>Yes, shoot it</button>
                        <button style={chip(qualityGate)} disabled={!!busy} onClick={() => setQualityGate(v => !v)}
                            title="Batch shots scoring under 60 vs the brand soul get ONE automatic reshoot with the critic's fixes before you see them (~1 cheap text call per shot)">
                            Quality gate {qualityGate ? 'on' : 'off'}
                        </button>
                        <button style={actionChip(false)} disabled={!!busy} onClick={campaign} title="Generate a matched set from this same plan: hero 16:9 + PDP 4:3 + social 1:1 + seasonal 3:4">
                            Campaign set
                        </button>
                    </div>
                </div>
            )}

            {/* Stage 4/5 — results + review */}
            {job && (stage === 'execute' || stage === 'review' || stage === 'done') && (
                <>
                    <div style={{ ...agentBubble, maxWidth: '100%', display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <span style={{ ...S.label, color: '#71717a' }}>RESULTS · SPEAK TO A SPECIFIC IMAGE</span>
                        <div style={{ fontSize: 11.5, color: '#71717a', lineHeight: 1.5 }}>
                            Feedback steers the next pass. Save approves the image. Discard removes it from this set.
                        </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
                        {results.map(r => {
                            const fb = feedback.get(r.id);
                            return (
                                <div key={r.id} style={{ border: '1px solid rgba(212,212,216,0.58)', background: 'rgba(255,255,255,0.58)', borderRadius: 12, padding: 0, overflow: 'hidden', position: 'relative' }}>
                                    <img src={r.image.value} alt="" onClick={() => openLightbox(r.image.value)}
                                        style={{ width: '100%', display: 'block', cursor: 'zoom-in' }} />
                                    {r.consistency && (
                                        <span title={r.consistency.pass
                                            ? `Hero inspection passed${r.consistency.retried ? ' (after 1 correction pass)' : ''}`
                                            : `Still off after correction: ${r.consistency.issues.join('; ')}`}
                                            style={{
                                                position: 'absolute', top: 6, left: 6, fontSize: 10, fontWeight: 800,
                                                padding: '2px 7px', borderRadius: 999,
                                                background: r.consistency.pass ? 'rgba(5,150,105,0.92)' : 'rgba(217,119,6,0.92)',
                                                color: '#fff',
                                            }}>
                                            {r.consistency.pass ? (r.consistency.retried ? 'fixed' : 'exact') : 'check'}
                                        </span>
                                    )}
                                    <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 7 }}>
                                        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                                            <button
                                                onClick={() => setCritiqueFor(prev => prev === r.id ? null : r.id)}
                                                style={actionChip(fb === 'dislike' || critiqueFor === r.id)}
                                                title="Tell Studio what should change before the next pass"
                                            >
                                                Feedback
                                            </button>
                                            <button
                                                onClick={() => saveResult(r)}
                                                style={actionChip(fb === 'like')}
                                                title="Approve this image and keep it as a saved output"
                                            >
                                                Save
                                            </button>
                                            <button
                                                onClick={() => discardResult(r)}
                                                style={actionChip(false)}
                                                title="Remove this option from the set and record a weak negative signal"
                                            >
                                                Discard
                                            </button>
                                        </div>
                                        {critiqueFor === r.id && (
                                            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', padding: 6, borderRadius: 8, background: 'rgba(244,244,245,0.7)' }}>
                                                <span style={{ flexBasis: '100%', fontSize: 9.5, fontWeight: 800, color: '#71717a', textTransform: 'uppercase', letterSpacing: 0.6 }}>What needs fixing?</span>
                                                {critiqueChips.map(reason => (
                                                    <button key={reason} style={actionChip(false)} disabled={!!busy} onClick={() => rate(r, 'dislike', reason)}>
                                                        {reason}
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                    </div>

                    {stage === 'execute' && (
                        <button style={{ ...S.btn, alignSelf: 'flex-start' }} disabled={!!busy || results.length === 0} onClick={review}>
                            Send to review
                        </button>
                    )}

                    {job.review && (
                        <div style={{ ...S.card, display: 'flex', flexDirection: 'column', gap: 8 }}>
                            <span style={S.label}>
                                DESIGN CRIT — {job.review.overall}/100 · {job.review.verdict === 'pass' ? 'ON BRAND' : 'REVISE'}
                            </span>
                            {job.review.axisScores.map(a => (
                                <div key={a.axis} style={{ fontSize: 11.5 }}>
                                    <strong>{a.axis}</strong> {a.score}/100 — {a.note}
                                </div>
                            ))}
                            {job.review.suggestions.length > 0 && (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                                    <span style={{ ...S.label, color: '#92400e' }}>FIXES — tick the ones you agree with</span>
                                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                                        {job.review.suggestions.map((sug, i) => {
                                            const on = critFixes.has(i);
                                            return (
                                                <button key={i} type="button"
                                                    onClick={() => setCritFixes(prev => { const n = new Set(prev); if (on) n.delete(i); else n.add(i); return n; })}
                                                    style={{ ...chip(on), fontSize: 11, lineHeight: 1.45, maxWidth: '100%', whiteSpace: 'normal', textAlign: 'left', minHeight: 0, padding: '6px 10px' }}>
                                                    {sug}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}
                            {stage === 'review' && (
                                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                    {job.review.suggestions.length > 0 && (
                                        <button style={S.btn} disabled={!!busy || critFixes.size === 0} onClick={reshootWithFixes}
                                            title="Ticked fixes become standing directives and drive one reshoot">
                                            Reshoot with {critFixes.size} fix{critFixes.size === 1 ? '' : 'es'}
                                        </button>
                                    )}
                                    <button style={job.review.suggestions.length > 0 ? S.btnGhost : S.btn} disabled={!!busy} onClick={finish}>Accept — close job</button>
                                    <button style={S.btnGhost} disabled={!!busy} onClick={execute}>Re-execute with same plan</button>
                                </div>
                            )}
                        </div>
                    )}

                    {stage === 'done' && (
                        <div style={{ ...S.card, fontSize: 12, color: '#059669' }}>
                            Job archived. Feedback recorded — the studio learns from every job.
                        </div>
                    )}
                </>
            )}

            {/* Concepts composer — brainstorm/regenerate only. Plan uses mood-study feedback instead. */}
            {job && stage === 'concepts' && (
                <div style={{ position: 'sticky', bottom: 10, zIndex: 20, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {(job.directives ?? []).length > 0 && (
                        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                            <span style={{ ...S.label, alignSelf: 'center', color: '#71717a' }}>DIRECTOR NOTES</span>
                            {(job.directives ?? []).map((d, i) => (
                                <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10, fontWeight: 600, padding: '3px 8px', borderRadius: 999, background: 'rgba(24,24,27,0.06)', border: '1px solid rgba(212,212,216,0.6)', color: '#3f3f46' }}>
                                    {d.length > 48 ? `${d.slice(0, 48)}…` : d}
                                    <button onClick={() => saveDirectiveAsRule(d)} title="Save this note as a permanent brand rule"
                                        style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#52525b', fontSize: 9, padding: 0, lineHeight: 1 }}>Rule</button>
                                    <button onClick={() => removeDirective(i)} title="Stop applying this directive"
                                        style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#a1a1aa', fontSize: 10, padding: 0, lineHeight: 1 }}>✕</button>
                                </span>
                            ))}
                        </div>
                    )}
                    <div style={{ display: 'flex', gap: 6, padding: 6, borderRadius: 12, background: 'rgba(255,255,255,0.82)', backdropFilter: 'blur(24px)', WebkitBackdropFilter: 'blur(24px)', border: '1px solid rgba(212,212,216,0.6)', boxShadow: '0 12px 28px rgba(0,0,0,0.10)' }}>
                        <input
                            value={noteText}
                            onChange={e => setNoteText(e.target.value)}
                            onKeyDown={e => {
                                if (e.key !== 'Enter') return;
                                regenerateConceptsWithNote();
                            }}
                            placeholder="Optional brainstorm note — “give me 3 quieter / more premium directions”…"
                            style={{ ...S.input, flex: 1, border: 'none', background: 'transparent' }}
                        />
                        <button
                            style={S.btn}
                            disabled={!!busy}
                            onClick={regenerateConceptsWithNote}
                        >
                            Generate more directions
                        </button>
                    </div>
                    <div style={{ fontSize: 10.5, color: '#71717a', paddingLeft: 8 }}>
                        Optional: use this box for overall brainstorm guidance, then generate 3 more directions.
                    </div>
                </div>
            )}

        </div>
        </div>
    );
});

export default StudioView;
