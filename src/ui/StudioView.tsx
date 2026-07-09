import React, { useEffect, useRef, useState } from 'react';
import { Asset, Element, GenerationResult, PraxisJob, Reference } from '../domain/types';
import { storage } from '../storage/local';
import {
    startJob, proposeConcepts, proposeWildcard, analyzeCompetitor, makePlan,
    makeMoodboard, anchorMood, executeJob, executeCampaign, reviewJob, closeJob,
} from '../studio/agents';
import { recordSignal, maybeDistill } from '../learning/learning';
import { attributeFeedback } from '../brain/soul';
import { BudgetExceededError } from '../engine/engine';
import { savePreset } from '../engine/presets';
import { openLightbox } from './lightbox';
import { DropZone } from './dropzone';
import { S, chip } from './styles';

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

export default function StudioView() {
    const [job, setJob] = useState<PraxisJob | null>(null);
    const [assets, setAssets] = useState<Asset[]>([]);
    const [elements, setElements] = useState<Element[]>([]);
    const [selectedAssets, setSelectedAssets] = useState<Set<string>>(new Set());
    const [refs, setRefs] = useState<Reference[]>([]);
    const [selectedRefs, setSelectedRefs] = useState<Set<string>>(new Set());
    const [inspOpen, setInspOpen] = useState(false);
    const [assetsOpen, setAssetsOpen] = useState(true);
    const [noteText, setNoteText] = useState('');
    const [jobs, setJobs] = useState<PraxisJob[]>([]);
    const [brief, setBrief] = useState('');
    const [count, setCount] = useState(2);
    const [results, setResults] = useState<GenerationResult[]>([]);
    const [busy, setBusy] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [feedback, setFeedback] = useState<Map<string, 'like' | 'dislike'>>(new Map());
    const [moodDrafts, setMoodDrafts] = useState<GenerationResult[]>([]);
    const [competitorNote, setCompetitorNote] = useState('');
    const competitorRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        storage.listAssets().then(setAssets);
        storage.listElements().then(setElements);
        storage.listReferences().then(rs => setRefs(rs.filter(r => r?.image?.kind === 'data' && r.kind !== 'plate'))).catch(err => console.warn('[studio] refs load failed:', err));
        storage.listJobs(30).then(setJobs).catch(() => {});
    }, []);

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

    const begin = () => guard('Concept agent thinking…', async () => {
        if (selectedAssets.size === 0) throw new Error('Pick at least one asset.');
        const j = await startJob(brief.trim()); // empty brief = open exploration
        setJob(await say(await proposeConcepts(j), 'agent', 'Three directions on the table — choose one, hit Wildcard for a collision, or type below to steer me.'));
    });

    const choose = (conceptId: string) => guard('Producer drafting the plan…', async () => {
        if (!job) return;
        const planned = await makePlan(job, conceptId, Array.from(selectedAssets));
        const withRefs = planned.plan && selectedRefs.size > 0
            ? { ...planned, plan: { ...planned.plan, params: { ...planned.plan.params, referenceIds: Array.from(selectedRefs) } } }
            : planned;
        setJob(await say(withRefs, 'agent', 'Plan drafted — tune ratio/size, run a cheap moodboard first, or execute.'));
    });

    const wildcard = () => guard('Colliding concepts…', async () => {
        if (!job) return;
        setJob(await proposeWildcard(job));
    });

    const reverseBrief = (files: FileList | File[] | null) => guard('Decoding the competitor…', async () => {
        const f = files?.[0];
        if (!f) return;
        const dataUrl = await new Promise<string>((res, rej) => {
            const r = new FileReader();
            r.onload = () => res(String(r.result));
            r.onerror = rej;
            r.readAsDataURL(f);
        });
        const { argument, counterBrief } = await analyzeCompetitor(dataUrl);
        setCompetitorNote(argument);
        setBrief(counterBrief);
    });

    const moodboard = () => guard('Moodboard…', async () => {
        if (!job) return;
        setMoodDrafts(await makeMoodboard(job, setBusy));
        setJob(await say(job, 'agent', 'Three mood drafts below — anchor the one whose light feels right, then execute.'));
    });

    const anchor = (resultId: string) => guard('Anchoring…', async () => {
        if (!job) return;
        setJob(await anchorMood(job, resultId));
    });

    const campaign = () => guard('Campaign kit…', async () => {
        if (!job) return;
        const { job: j, results: rs } = await executeCampaign(job, setBusy);
        setResults(rs);
        setJob(await say(j, 'agent', 'Campaign kit done — one concept across all four purposes.'));
    });

    const execute = () => guard('Executing…', async () => {
        if (!job) return;
        const { job: j, results: rs } = await executeJob(job, count, setBusy);
        setResults(rs);
        setJob(await say(j, 'agent', `${rs.length} shot${rs.length === 1 ? '' : 's'} done — rate them; if something's off, type it below and re-execute.`));
    });

    const review = () => guard('Critic reviewing…', async () => {
        if (!job) return;
        setJob(await say(await reviewJob(job, results), 'agent', "The critic's read is in — close the job, or step back and iterate."));
    });

    const finish = () => guard('Closing…', async () => {
        if (!job) return;
        setJob(await closeJob(job));
    });

    const reset = () => { setJob(null); setResults([]); setBrief(''); setFeedback(new Map()); setMoodDrafts([]); };

    useEffect(() => {
        storage.listJobs(30).then(setJobs).catch(() => {});
    }, [job?.updatedAt]);

    /** Resume a past job — thread, stage and (recent) results included. */
    const resume = async (j: PraxisJob) => {
        setJob(j);
        setBrief(j.brief);
        setMoodDrafts([]);
        setFeedback(new Map());
        const rs: GenerationResult[] = [];
        for (const id of j.resultIds.slice(-8)) {
            const r = await storage.getResult(id).catch(() => null);
            if (r) rs.push(r);
        }
        setResults(rs);
    };

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

    const rate = async (r: GenerationResult, rating: 'like' | 'dislike') => {
        const reason = rating === 'dislike'
            ? window.prompt('What went wrong? (this teaches the studio — be specific)') ?? undefined
            : undefined;
        await recordSignal(r, rating, reason);
        if (rating === 'dislike' && reason) attributeFeedback(reason); // fire-and-forget
        setFeedback(prev => new Map(prev).set(r.id, rating));
        maybeDistill();
    };

    const download = async (r: GenerationResult) => {
        const a = document.createElement('a');
        a.href = r.image.value;
        a.download = `praxis-${r.id.slice(0, 6)}.png`;
        a.click();
        await recordSignal(r, 'export');
    };

    /** Freeze this result's whole setup as a Quick preset (hero-free). */
    const toPreset = async (r: GenerationResult) => {
        if (!job?.plan) return;
        const name = window.prompt('Preset name:',
            job.concepts.find(c => c.id === job.chosenConceptId)?.title ?? 'My look')?.trim();
        if (!name) return;
        await savePreset(name, job.plan.params, job.plan.elementIds, r.image.value);
        setError(null);
        setBusy('');
        window.alert(`Preset "${name}" saved — use it in the Quick tab: pick heroes, draft, execute.`);
    };

    const stage = job?.stage ?? 'brief';
    const elementById = (id: string) => elements.find(e => e.id === id);

    return (
        <div style={{ maxWidth: 1180, margin: '0 auto', padding: '18px 22px', display: 'flex', gap: 16, alignItems: 'flex-start' }}>
            {/* Job history — every job is a conversation */}
            <aside style={{ width: 200, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8, position: 'sticky', top: 12 }}>
                <button style={{ ...S.btn, width: '100%' }} onClick={reset}>＋ New job</button>
                <span style={S.label}>JOBS</span>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, overflowY: 'auto', maxHeight: 'calc(100vh - 140px)' }}>
                    {jobs.map(j => (
                        <button key={j.id} onClick={() => resume(j)}
                            style={{
                                textAlign: 'left', padding: '7px 10px', borderRadius: 10, cursor: 'pointer',
                                border: job?.id === j.id ? '1.5px solid #18181b' : '1px solid rgba(212,212,216,0.5)',
                                background: 'rgba(255,255,255,0.6)',
                            }}>
                            <div style={{ fontSize: 11, fontWeight: 700, color: '#18181b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {j.brief.trim() ? j.brief.slice(0, 42) : 'Open exploration'}
                            </div>
                            <div style={{ fontSize: 9, color: '#a1a1aa', marginTop: 2 }}>
                                {(STAGE_LABEL[j.stage] ?? j.stage)} · {new Date(j.updatedAt).toLocaleDateString()}
                            </div>
                        </button>
                    ))}
                    {jobs.length === 0 && <span style={{ fontSize: 10.5, color: '#a1a1aa' }}>No jobs yet — describe one below.</span>}
                </div>
            </aside>

        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
            {/* Stage rail */}
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                {STAGES.map((s, i) => (
                    <React.Fragment key={s}>
                        {i > 0 && <span style={{ color: '#d4d4d8' }}>→</span>}
                        <span style={{
                            fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 999,
                            background: stage === s ? '#18181b' : '#f4f4f5',
                            color: stage === s ? '#fff' : '#a1a1aa',
                        }}>{STAGE_LABEL[s]}</span>
                    </React.Fragment>
                ))}
                {job && (
                    <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                        <button style={S.btnGhost} disabled={!!busy} onClick={back} title="Step back one stage">← Back</button>
                        <button style={S.btnGhost} onClick={reset}>New job</button>
                    </span>
                )}
            </div>

            {busy && <div style={{ ...S.card, fontSize: 12, color: '#52525b' }}>{busy}</div>}
            {error && <div style={S.err}>{error}</div>}

            {/* Conversation — the studio reports, the owner steers */}
            {job && (job.transcript ?? []).length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {(job.transcript ?? []).map((m, i) => (
                        <div key={i} style={{
                            alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                            maxWidth: '78%',
                            padding: '7px 12px',
                            borderRadius: m.role === 'user' ? '12px 12px 3px 12px' : '12px 12px 12px 3px',
                            fontSize: 12, lineHeight: 1.5,
                            background: m.role === 'user' ? '#18181b' : 'rgba(255,255,255,0.72)',
                            color: m.role === 'user' ? '#fff' : '#18181b',
                            border: m.role === 'user' ? 'none' : '1px solid rgba(212,212,216,0.5)',
                            backdropFilter: 'blur(18px)', WebkitBackdropFilter: 'blur(18px)',
                            boxShadow: '0 4px 12px rgba(0,0,0,0.05)',
                            animation: 'praxis-pop 240ms cubic-bezier(0.22,1,0.36,1)',
                        }}>
                            {m.text}
                        </div>
                    ))}
                </div>
            )}

            {/* Stage 1 — brief */}
            {!job && (
                <DropZone onFiles={reverseBrief} hint="Drop a competitor's image — reverse brief">
                <div style={{ ...S.card, display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div style={{ textAlign: 'center', padding: '26px 0 10px', display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center' }}>
                        <div style={{ width: 46, height: 46, borderRadius: 999, background: 'radial-gradient(circle at 32% 28%, #d7dce6, #18181b)', boxShadow: '0 12px 26px rgba(0,0,0,0.18)' }} />
                        <div style={{ fontSize: 21, fontWeight: 800, color: '#18181b' }}>What should the studio make?</div>
                        <div style={{ fontSize: 12, color: '#71717a', maxWidth: 420, lineHeight: 1.6 }}>
                            Describe it in the box below — or leave it empty for open exploration. Attach assets & inspiration here, then Send: the studio proposes, plans, shoots and learns from your feedback.
                        </div>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'center', marginTop: 4 }}>
                            {['Spring campaign hero — fresh, optimistic', 'Clean silo set for the newest collection', 'Lifestyle scene for social — quiet morning'].map(sug => (
                                <button key={sug} style={chip(brief === sug)} onClick={() => setBrief(sug)}>{sug}</button>
                            ))}
                        </div>
                    </div>
                    {brief.trim() && <div style={{ fontSize: 11, color: '#3f3f46', background: 'rgba(244,244,245,0.8)', borderRadius: 8, padding: '6px 10px' }}>Brief: {brief}</div>}
                    <button
                        onClick={() => setAssetsOpen(o => !o)}
                        style={{
                            ...S.btnGhost, alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: 6,
                            fontSize: 10, fontWeight: 800, letterSpacing: 0.8, textTransform: 'uppercase', color: '#71717a',
                        }}
                        title="Pick the assets (pixel truth) this job must feature">
                        <span style={{ display: 'inline-block', transition: 'transform 200ms cubic-bezier(0.22,1,0.36,1)', transform: assetsOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}>▸</span>
                        Assets · {selectedAssets.size} selected
                    </button>
                    <div style={{
                        overflow: 'hidden',
                        maxHeight: assetsOpen ? 480 : 0,
                        opacity: assetsOpen ? 1 : 0,
                        transition: 'max-height 320ms cubic-bezier(0.22,1,0.36,1), opacity 200ms ease',
                    }}>
                    {/* Same card grid as the Canvas library — big thumbnails, names below, click to select */}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))', gap: 6, maxHeight: 470, overflowY: 'auto' }}>
                        {assets.map(a => {
                            const on = selectedAssets.has(a.id);
                            return (
                                <button key={a.id} onClick={() => setSelectedAssets(prev => {
                                    const n = new Set(prev); n.has(a.id) ? n.delete(a.id) : n.add(a.id); return n;
                                })}
                                    title={`${a.name}${on ? ' — selected' : ''}`}
                                    style={{
                                        border: on ? '1.5px solid #18181b' : '1px solid rgba(212,212,216,0.58)',
                                        background: 'rgba(255,255,255,0.58)',
                                        borderRadius: 8, padding: 4, cursor: 'pointer',
                                        display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0,
                                    }}>
                                    {a.photos[0] && <img src={a.photos[0].image.value} alt="" draggable={false}
                                        onClick={e => { if (e.altKey) { e.stopPropagation(); openLightbox(a.photos[0].image.value); } }}
                                        style={{ width: '100%', aspectRatio: '1', borderRadius: 5, objectFit: 'cover', display: 'block' }} />}
                                    <span style={{ width: '100%', fontSize: 9, fontWeight: 700, color: '#3f3f46', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }}>
                                        {a.name}{a.photos.length > 1 ? ` · ${a.photos.length}` : ''}
                                    </span>
                                </button>
                            );
                        })}
                        {assets.length === 0 && <span style={{ fontSize: 11, color: '#a1a1aa' }}>No assets yet — add them in Assets.</span>}
                    </div>
                    </div>

                    {/* Inspiration — collapsible; chosen refs lead the aesthetic stack */}
                    <button
                        onClick={() => setInspOpen(o => !o)}
                        style={{
                            ...S.btnGhost, alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: 6,
                            fontSize: 10, fontWeight: 800, letterSpacing: 0.8, textTransform: 'uppercase', color: '#71717a',
                        }}
                        title="Pick inspiration references — their look leads the generation's aesthetic references">
                        <span style={{ display: 'inline-block', transition: 'transform 200ms cubic-bezier(0.22,1,0.36,1)', transform: inspOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}>▸</span>
                        Inspiration · {selectedRefs.size} selected
                    </button>
                    <div style={{
                        overflow: 'hidden',
                        maxHeight: inspOpen ? 480 : 0,
                        opacity: inspOpen ? 1 : 0,
                        transition: 'max-height 320ms cubic-bezier(0.22,1,0.36,1), opacity 200ms ease',
                    }}>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))', gap: 6, maxHeight: 470, overflowY: 'auto' }}>
                            {refs.map(r => {
                                const on = selectedRefs.has(r.id);
                                return (
                                    <button key={r.id} onClick={() => setSelectedRefs(prev => {
                                        const n = new Set(prev); n.has(r.id) ? n.delete(r.id) : n.add(r.id); return n;
                                    })}
                                        title={`${r.name}${on ? ' — selected' : ''}`}
                                        style={{
                                            border: on ? '1.5px solid #18181b' : '1px solid rgba(212,212,216,0.58)',
                                            background: 'rgba(255,255,255,0.58)',
                                            borderRadius: 8, padding: 4, cursor: 'pointer',
                                            display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0,
                                        }}>
                                        <img src={r.image.value} alt="" draggable={false}
                                            style={{ width: '100%', aspectRatio: '1', borderRadius: 5, objectFit: 'cover', display: 'block' }} />
                                        <span style={{ width: '100%', fontSize: 9, fontWeight: 700, color: '#3f3f46', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }}>{r.name}</span>
                                    </button>
                                );
                            })}
                            {refs.length === 0 && <span style={{ fontSize: 11, color: '#a1a1aa' }}>No references yet — collect them in Inspiration.</span>}
                        </div>
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <button style={S.btnGhost} disabled={!!busy} onClick={() => competitorRef.current?.click()}>
                            ↩ Reverse brief — answer a competitor's image
                        </button>
                        <input ref={competitorRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={e => reverseBrief(e.target.files)} />
                    </div>
                    {competitorNote && (
                        <div style={{ fontSize: 11, color: '#92400e', lineHeight: 1.5 }}>
                            Their argument: {competitorNote} — counter-brief drafted above; edit it, pick heroes, then Start.
                        </div>
                    )}
                </div>
                </DropZone>
            )}

            {/* Stage 2 — concepts */}
            {job && stage === 'concepts' && (
                <>
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <button style={S.btnGhost} disabled={!!busy} onClick={wildcard} title="Collide two contradictory concepts">
                        Wildcard — collide two opposites
                    </button>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 10 }}>
                    {job.concepts.map(c => (
                        <div key={c.id} style={{ ...S.card, display: 'flex', flexDirection: 'column', gap: 8 }}>
                            <div style={{ fontSize: 13, fontWeight: 700 }}>{c.title}</div>
                            <div style={{ fontSize: 10, fontWeight: 700, color: '#a1a1aa', letterSpacing: 0.5 }}>
                                {c.realism.toUpperCase()}{c.contextModeId ? ` · ${c.contextModeId}` : ''}
                            </div>
                            <div style={{ fontSize: 11.5, lineHeight: 1.5 }}>{c.rationale}</div>
                            <div style={{ fontSize: 10.5, color: '#71717a', lineHeight: 1.5 }}>{c.nsiSummary}</div>
                            {c.elementIds.some(id => elementById(id)) && (
                                <div style={{ fontSize: 10, color: '#71717a' }}>
                                    Recombines: {c.elementIds.map(id => elementById(id)?.concept).filter(Boolean).map(s => `“${s}”`).join(' + ')}
                                </div>
                            )}
                            <button style={{ ...S.btn, marginTop: 'auto' }} disabled={!!busy} onClick={() => choose(c.id)}>
                                Choose this direction
                            </button>
                        </div>
                    ))}
                </div>
                </>
            )}

            {/* Stage 3 — plan */}
            {job && stage === 'plan' && job.plan && (
                <div style={{ ...S.card, display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <span style={S.label}>PRODUCTION PLAN — {job.concepts.find(c => c.id === job.chosenConceptId)?.title}</span>
                    <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: 1.7 }}>
                        {job.plan.steps.map((s, i) => <li key={i}>{s}</li>)}
                    </ol>
                    <div style={{ fontSize: 11, color: '#71717a', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span>purpose {job.plan.params.purpose} · {job.plan.elementIds.length} elements · note:</span>
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
                        {(['1:1', '16:9', '4:3', '3:4', '9:16'] as const).map(r =>
                            <button key={r} style={chip(job.plan!.params.ratio === r)} disabled={!!busy} onClick={() => updatePlan({ ratio: r })}>{r}</button>)}
                        <span style={{ ...S.label, marginLeft: 8 }}>SIZE</span>
                        {(['1K', '2K', '4K'] as const).map(s =>
                            <button key={s} style={chip((job.plan!.params.size ?? '1K') === s)} disabled={!!busy} onClick={() => updatePlan({ size: s })}>{s}</button>)}
                        <span style={{ fontSize: 10, color: '#a1a1aa' }}>4K needs the pro model; unsupported sizes fall back automatically</span>
                    </div>
                    {/* Moodboard — pick direction on visuals, cheap flash drafts */}
                    <div style={{ borderTop: '1px solid #f4f4f5', paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                            <button style={S.btnGhost} disabled={!!busy} onClick={moodboard}>
                                Moodboard — 3 cheap drafts first
                            </button>
                            {job.plan.moodAnchorResultId && <span style={{ fontSize: 10, color: '#059669' }}>mood anchored — its pixels will lead the final shot</span>}
                        </div>
                        {moodDrafts.length > 0 && (
                            <div style={{ display: 'flex', gap: 8 }}>
                                {moodDrafts.map(d => (
                                    <div key={d.id}
                                        style={{ padding: 2, borderRadius: 10, background: '#fff', border: job.plan!.moodAnchorResultId === d.id ? '2.5px solid #059669' : '1px solid #e4e4e7' }}>
                                        <img src={d.image.value} alt="" onClick={() => openLightbox(d.image.value)}
                                            style={{ width: 130, borderRadius: 8, display: 'block', cursor: 'zoom-in' }} />
                                        <div style={{ display: 'flex', gap: 3, marginTop: 3 }}>
                                            <button onClick={() => anchor(d.id)} disabled={!!busy}
                                                style={{ ...S.btnGhost, flex: 1, fontSize: 10 }}>
                                                {job.plan!.moodAnchorResultId === d.id ? 'Anchored' : 'Anchor'}
                                            </button>
                                            <button title="Save to Gallery" disabled={!!busy}
                                                onClick={async () => { await recordSignal(d, 'save'); window.alert('Saved to Gallery.'); }}
                                                style={{ ...S.btnGhost, fontSize: 10 }}>Gallery</button>
                                            <button title="Download" onClick={() => {
                                                const a = document.createElement('a');
                                                a.href = d.image.value;
                                                a.download = `praxis-mood-${d.id.slice(0, 6)}.png`;
                                                a.click();
                                            }} style={{ ...S.btnGhost, fontSize: 10 }}>Save</button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <span style={S.label}>VARIANTS</span>
                        {[1, 2, 3].map(n => <button key={n} style={chip(count === n)} onClick={() => setCount(n)}>{n}</button>)}
                        <button style={S.btn} disabled={!!busy} onClick={execute}>Approve — execute</button>
                        <button style={S.btnGhost} disabled={!!busy} onClick={campaign} title="hero 16:9 + pdp 4:3 + social 1:1 + seasonal 3:4">
                            Campaign kit — all 4 purposes
                        </button>
                    </div>
                </div>
            )}

            {/* Stage 4/5 — results + review */}
            {job && (stage === 'execute' || stage === 'review' || stage === 'done') && (
                <>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
                        {results.map(r => {
                            const fb = feedback.get(r.id);
                            return (
                                <div key={r.id} style={{ ...S.card, padding: 0, overflow: 'hidden', position: 'relative' }}>
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
                                    <div style={{ padding: '6px 10px', display: 'flex', justifyContent: 'space-between' }}>
                                        <span style={{ display: 'flex', gap: 8 }}>
                                            <button onClick={() => rate(r, 'like')} style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 14, opacity: fb === 'like' ? 1 : 0.35 }}>+</button>
                                            <button onClick={() => rate(r, 'dislike')} style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 14, opacity: fb === 'dislike' ? 1 : 0.35 }}>-</button>
                                        </span>
                                        <span style={{ display: 'flex', gap: 6 }}>
                                            <button style={S.btnGhost} title="Save to Gallery (curated set, used for training export)" onClick={async () => { await recordSignal(r, 'save'); setBusy(''); setError(null); window.alert('Saved — find it in Gallery.'); }}>Gallery</button>
                                            <button style={S.btnGhost} title="Save this whole setup as a Quick preset — same look, swap assets" onClick={() => toPreset(r)}>Preset</button>
                                            <button style={S.btnGhost} onClick={() => download(r)}>Save</button>
                                        </span>
                                    </div>
                                </div>
                            );
                        })}
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
                                <div style={{ fontSize: 11.5, color: '#92400e' }}>
                                    Suggestions: {job.review.suggestions.join(' · ')}
                                </div>
                            )}
                            {stage === 'review' && (
                                <div style={{ display: 'flex', gap: 8 }}>
                                    <button style={S.btn} disabled={!!busy} onClick={finish}>Accept — close job</button>
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

            {/* Interjection composer — always available while a job runs */}
            {job && (
                <div style={{ position: 'sticky', bottom: 10, zIndex: 20, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {(job.directives ?? []).length > 0 && (
                        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                            {(job.directives ?? []).map((d, i) => (
                                <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10, fontWeight: 600, padding: '3px 8px', borderRadius: 999, background: 'rgba(24,24,27,0.06)', border: '1px solid rgba(212,212,216,0.6)', color: '#3f3f46' }}>
                                    {d.length > 48 ? `${d.slice(0, 48)}…` : d}
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
                            onKeyDown={e => { if (e.key === 'Enter') sendNote(); }}
                            placeholder="Interject anytime — “colder morning light”, “leave copy space top-left”… applies to every next step"
                            style={{ ...S.input, flex: 1, border: 'none', background: 'transparent' }}
                        />
                        <button style={S.btn} disabled={!noteText.trim() || !!busy} onClick={sendNote}>Send</button>
                    </div>
                </div>
            )}

            {/* First-message composer — typing here IS the brief */}
            {!job && (
                <div style={{ position: 'sticky', bottom: 10, zIndex: 20, display: 'flex', gap: 6, padding: 6, borderRadius: 12, background: 'rgba(255,255,255,0.82)', backdropFilter: 'blur(24px)', WebkitBackdropFilter: 'blur(24px)', border: '1px solid rgba(212,212,216,0.6)', boxShadow: '0 12px 28px rgba(0,0,0,0.10)' }}>
                    <input
                        value={brief}
                        onChange={e => setBrief(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') begin(); }}
                        placeholder="Describe what the studio should make — or leave empty and Send for open exploration…"
                        style={{ ...S.input, flex: 1, border: 'none', background: 'transparent' }}
                    />
                    <button style={S.btn} disabled={!!busy} onClick={begin}>Send</button>
                </div>
            )}
        </div>
        </div>
    );
}
