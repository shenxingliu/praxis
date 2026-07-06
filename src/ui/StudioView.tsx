import React, { useEffect, useRef, useState } from 'react';
import { Asset, Element, GenerationResult, PraxisJob } from '../domain/types';
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
    execute: '4 · Execute', review: '5 · Review', done: '✓ Done',
};

export default function StudioView() {
    const [job, setJob] = useState<PraxisJob | null>(null);
    const [assets, setAssets] = useState<Asset[]>([]);
    const [elements, setElements] = useState<Element[]>([]);
    const [selectedAssets, setSelectedAssets] = useState<Set<string>>(new Set());
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
    }, []);

    const guard = async (label: string, fn: () => Promise<void>) => {
        setBusy(label); setError(null);
        try { await fn(); } catch (err: any) {
            setError(err instanceof BudgetExceededError ? err.message : err?.message || 'Failed');
        } finally { setBusy(''); }
    };

    const begin = () => guard('Concept agent thinking…', async () => {
        if (!brief.trim()) throw new Error('Write a brief first.');
        if (selectedAssets.size === 0) throw new Error('Pick at least one product.');
        const j = await startJob(brief.trim());
        setJob(await proposeConcepts(j));
    });

    const choose = (conceptId: string) => guard('Producer drafting the plan…', async () => {
        if (!job) return;
        setJob(await makePlan(job, conceptId, Array.from(selectedAssets)));
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
    });

    const anchor = (resultId: string) => guard('Anchoring…', async () => {
        if (!job) return;
        setJob(await anchorMood(job, resultId));
    });

    const campaign = () => guard('Campaign kit…', async () => {
        if (!job) return;
        const { job: j, results: rs } = await executeCampaign(job, setBusy);
        setResults(rs);
        setJob(j);
    });

    const execute = () => guard('Executing…', async () => {
        if (!job) return;
        const { job: j, results: rs } = await executeJob(job, count, setBusy);
        setResults(rs);
        setJob(j);
    });

    const review = () => guard('Critic reviewing…', async () => {
        if (!job) return;
        setJob(await reviewJob(job, results));
    });

    const finish = () => guard('Closing…', async () => {
        if (!job) return;
        setJob(await closeJob(job));
    });

    const reset = () => { setJob(null); setResults([]); setBrief(''); setFeedback(new Map()); setMoodDrafts([]); };

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

    /** Freeze this result's whole setup as a Quick preset (product-free). */
    const toPreset = async (r: GenerationResult) => {
        if (!job?.plan) return;
        const name = window.prompt('Preset name:',
            job.concepts.find(c => c.id === job.chosenConceptId)?.title ?? 'My look')?.trim();
        if (!name) return;
        await savePreset(name, job.plan.params, job.plan.elementIds, r.image.value);
        setError(null);
        setBusy('');
        window.alert(`✓ Preset "${name}" saved — use it in the Quick tab: pick products, draft, execute.`);
    };

    const stage = job?.stage ?? 'brief';
    const elementById = (id: string) => elements.find(e => e.id === id);

    return (
        <div style={{ maxWidth: 900, margin: '0 auto', padding: '22px 28px', display: 'flex', flexDirection: 'column', gap: 14 }}>
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

            {busy && <div style={{ ...S.card, fontSize: 12, color: '#52525b' }}>⏳ {busy}</div>}
            {error && <div style={S.err}>{error}</div>}

            {/* Stage 1 — brief */}
            {!job && (
                <DropZone onFiles={reverseBrief} hint="Drop a competitor's image — reverse brief">
                <div style={{ ...S.card, display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <span style={S.label}>CLIENT BRIEF</span>
                    <textarea
                        style={{ ...S.input, width: '100%', minHeight: 70, boxSizing: 'border-box', resize: 'vertical' }}
                        placeholder='e.g. "Spring campaign hero image for the new collection — fresh, optimistic, must work as a website banner"'
                        value={brief} onChange={e => setBrief(e.target.value)}
                    />
                    <span style={S.label}>PRODUCTS · {selectedAssets.size} selected</span>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {assets.map(a => {
                            const on = selectedAssets.has(a.id);
                            return (
                                <button key={a.id} onClick={() => setSelectedAssets(prev => {
                                    const n = new Set(prev); n.has(a.id) ? n.delete(a.id) : n.add(a.id); return n;
                                })} style={{ ...chip(on), display: 'flex', alignItems: 'center', gap: 6 }}>
                                    {a.photos[0] && <img src={a.photos[0].image.value} alt=""
                                        onClick={e => { e.stopPropagation(); openLightbox(a.photos[0].image.value); }}
                                        style={{ width: 22, height: 22, borderRadius: 4, objectFit: 'cover', cursor: 'zoom-in' }} />}
                                    {a.name}
                                </button>
                            );
                        })}
                        {assets.length === 0 && <span style={{ fontSize: 11, color: '#a1a1aa' }}>No products yet — import them in System.</span>}
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <button style={S.btn} disabled={!!busy} onClick={begin}>
                            Start — propose concepts
                        </button>
                        <button style={S.btnGhost} disabled={!!busy} onClick={() => competitorRef.current?.click()}>
                            ↩ Reverse brief — answer a competitor's image
                        </button>
                        <input ref={competitorRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={e => reverseBrief(e.target.files)} />
                    </div>
                    {competitorNote && (
                        <div style={{ fontSize: 11, color: '#92400e', lineHeight: 1.5 }}>
                            Their argument: {competitorNote} — counter-brief drafted above; edit it, pick products, then Start.
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
                        ⚡ Wildcard — collide two opposites
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
                    <div style={{ fontSize: 11, color: '#71717a' }}>
                        purpose {job.plan.params.purpose} · {job.plan.elementIds.length} elements · note: “{job.plan.params.note}”
                    </div>
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
                                🎨 Moodboard — 3 cheap drafts first
                            </button>
                            {job.plan.moodAnchorResultId && <span style={{ fontSize: 10, color: '#059669' }}>✓ mood anchored — its pixels will lead the final shot</span>}
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
                                                {job.plan!.moodAnchorResultId === d.id ? '✓ Anchored' : '⚓ Anchor'}
                                            </button>
                                            <button title="Save to Gallery" disabled={!!busy}
                                                onClick={async () => { await recordSignal(d, 'save'); window.alert('✓ Saved to Gallery.'); }}
                                                style={{ ...S.btnGhost, fontSize: 10 }}>★</button>
                                            <button title="Download" onClick={() => {
                                                const a = document.createElement('a');
                                                a.href = d.image.value;
                                                a.download = `praxis-mood-${d.id.slice(0, 6)}.png`;
                                                a.click();
                                            }} style={{ ...S.btnGhost, fontSize: 10 }}>⬇</button>
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
                            📦 Campaign kit — all 4 purposes
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
                                            ? `Product inspection passed${r.consistency.retried ? ' (after 1 correction pass)' : ''}`
                                            : `Still off after correction: ${r.consistency.issues.join('; ')}`}
                                            style={{
                                                position: 'absolute', top: 6, left: 6, fontSize: 10, fontWeight: 800,
                                                padding: '2px 7px', borderRadius: 999,
                                                background: r.consistency.pass ? 'rgba(5,150,105,0.92)' : 'rgba(217,119,6,0.92)',
                                                color: '#fff',
                                            }}>
                                            {r.consistency.pass ? (r.consistency.retried ? '✓ fixed' : '✓ exact') : '⚠ check'}
                                        </span>
                                    )}
                                    <div style={{ padding: '6px 10px', display: 'flex', justifyContent: 'space-between' }}>
                                        <span style={{ display: 'flex', gap: 8 }}>
                                            <button onClick={() => rate(r, 'like')} style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 14, opacity: fb === 'like' ? 1 : 0.35 }}>👍</button>
                                            <button onClick={() => rate(r, 'dislike')} style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 14, opacity: fb === 'dislike' ? 1 : 0.35 }}>👎</button>
                                        </span>
                                        <span style={{ display: 'flex', gap: 6 }}>
                                            <button style={S.btnGhost} title="Save to Gallery (curated set, used for training export)" onClick={async () => { await recordSignal(r, 'save'); setBusy(''); setError(null); window.alert('✓ Saved — find it in Gallery.'); }}>★</button>
                                            <button style={S.btnGhost} title="Save this whole setup as a Quick preset — same look, swap products" onClick={() => toPreset(r)}>☆</button>
                                            <button style={S.btnGhost} onClick={() => download(r)}>⬇</button>
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
                                DESIGN CRIT — {job.review.overall}/100 · {job.review.verdict === 'pass' ? '✅ ON BRAND' : '🔶 REVISE'}
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
                            ✓ Job archived. Feedback recorded — the studio learns from every job.
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
