import React, { useEffect, useMemo, useState } from 'react';
import { FeedbackSignal, KnowledgeRule, PraxisJob } from '../domain/types';
import { storage } from '../storage/local';
import { getCurrentBrandId } from '../domain/brand';
import { getBrandSoul, SoulField } from '../brain/soul';
import { S } from './styles';

/**
 * GROWTH — makes the moat visible. FLORA-class tools are stateless;
 * Praxis learns. This dashboard shows the learning: taste alignment
 * trending up, rules accumulating, the critic calibrating to the owner.
 * Reads only image-free tables — instant even when the DB is grumpy.
 */

const POSITIVE = new Set(['like', 'save', 'export']);
const NEGATIVE = new Set(['dislike', 'discard', 'regenerate']);

const WEEK_MS = 7 * 86_400_000;

type Cal = { kind: 'liked-low' | 'disliked-high'; overall: number; note: string; at: number };

const weekLabel = (bucketEnd: number): string => {
    const d = new Date(bucketEnd - WEEK_MS + 86_400_000);
    return `${d.getMonth() + 1}/${d.getDate()}`;
};

/** Simple area+line chart. Points are 0..1 (null = no data that week). */
function TrendChart({ points, labels }: { points: Array<number | null>; labels: string[] }) {
    const W = 640, H = 150, PAD = 26;
    const n = points.length;
    const x = (i: number) => PAD + (i * (W - PAD * 2)) / Math.max(1, n - 1);
    const y = (v: number) => H - PAD - v * (H - PAD * 2);
    const known = points.map((p, i) => ({ p, i })).filter((d): d is { p: number; i: number } => d.p !== null);
    const line = known.map((d, k) => `${k === 0 ? 'M' : 'L'}${x(d.i).toFixed(1)},${y(d.p).toFixed(1)}`).join(' ');
    const area = known.length > 1
        ? `${line} L${x(known[known.length - 1].i).toFixed(1)},${y(0)} L${x(known[0].i).toFixed(1)},${y(0)} Z`
        : '';
    return (
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
            {[0, 0.5, 1].map(g => (
                <g key={g}>
                    <line x1={PAD} x2={W - PAD} y1={y(g)} y2={y(g)} stroke="#e4e4e7" strokeWidth={1} strokeDasharray={g === 0 ? '' : '3 4'} />
                    <text x={PAD - 7} y={y(g) + 3.5} textAnchor="end" fontSize={9} fill="#a1a1aa">{Math.round(g * 100)}%</text>
                </g>
            ))}
            {area && <path d={area} fill="rgba(24,24,27,0.06)" />}
            {line && <path d={line} fill="none" stroke="#18181b" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />}
            {known.map(d => (
                <circle key={d.i} cx={x(d.i)} cy={y(d.p)} r={3.2} fill="#18181b" stroke="#fff" strokeWidth={1.4} />
            ))}
            {labels.map((l, i) => (
                <text key={i} x={x(i)} y={H - 8} textAnchor="middle" fontSize={9} fill="#a1a1aa">{l}</text>
            ))}
        </svg>
    );
}

/** Weekly stacked bars: positive up in ink, negative in amber. */
function ActivityChart({ pos, neg, labels }: { pos: number[]; neg: number[]; labels: string[] }) {
    const W = 640, H = 150, PAD = 26;
    const n = pos.length;
    const max = Math.max(1, ...pos.map((p, i) => p + neg[i]));
    const bw = Math.min(34, ((W - PAD * 2) / n) * 0.56);
    const x = (i: number) => PAD + ((i + 0.5) * (W - PAD * 2)) / n - bw / 2;
    const scale = (v: number) => (v / max) * (H - PAD * 2);
    return (
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
            <line x1={PAD} x2={W - PAD} y1={H - PAD} y2={H - PAD} stroke="#e4e4e7" strokeWidth={1} />
            {pos.map((p, i) => {
                const hp = scale(p), hn = scale(neg[i]);
                return (
                    <g key={i}>
                        {p > 0 && <rect x={x(i)} y={H - PAD - hp} width={bw} height={hp} rx={3} fill="#18181b" />}
                        {neg[i] > 0 && <rect x={x(i)} y={H - PAD - hp - hn} width={bw} height={hn} rx={3} fill="rgba(180,83,9,0.55)" />}
                        {(p > 0 || neg[i] > 0) && (
                            <text x={x(i) + bw / 2} y={H - PAD - hp - hn - 5} textAnchor="middle" fontSize={9} fill="#71717a">{p + neg[i]}</text>
                        )}
                    </g>
                );
            })}
            {labels.map((l, i) => (
                <text key={i} x={x(i) + bw / 2} y={H - 8} textAnchor="middle" fontSize={9} fill="#a1a1aa">{l}</text>
            ))}
        </svg>
    );
}

export default function GrowthView() {
    const [signals, setSignals] = useState<FeedbackSignal[]>([]);
    const [rules, setRules] = useState<KnowledgeRule[]>([]);
    const [jobs, setJobs] = useState<PraxisJob[]>([]);
    const [soulFields, setSoulFields] = useState<SoulField[]>([]);
    const [loaded, setLoaded] = useState(false);

    useEffect(() => {
        Promise.all([
            storage.listSignals().catch(() => [] as FeedbackSignal[]),
            storage.listRules().catch(() => [] as KnowledgeRule[]),
            storage.listJobs(100).catch(() => [] as PraxisJob[]),
            getBrandSoul().catch(() => null),
        ]).then(([sg, rl, jb, soul]) => {
            setSignals(sg);
            setRules(rl);
            setJobs(jb);
            setSoulFields((soul?.fields ?? []).filter(f => f.value.trim()));
            setLoaded(true);
        });
    }, []);

    const calibrations: Cal[] = useMemo(() => {
        try { return JSON.parse(localStorage.getItem(`praxis_critic_calibration_${getCurrentBrandId()}`) ?? '[]'); }
        catch { return []; }
    }, []);

    const stats = useMemo(() => {
        const now = Date.now();
        const WEEKS = 10;
        const end = now;

        const posW = Array(WEEKS).fill(0) as number[];
        const negW = Array(WEEKS).fill(0) as number[];
        for (const s of signals) {
            const w = Math.floor((end - s.createdAt) / WEEK_MS);
            if (w < 0 || w >= WEEKS) continue;
            const idx = WEEKS - 1 - w;
            if (POSITIVE.has(s.type)) posW[idx]++;
            else if (NEGATIVE.has(s.type)) negW[idx]++;
        }
        const alignment = posW.map((p, i) => {
            const t = p + negW[i];
            return t === 0 ? null : p / t;
        });
        const labels = Array.from({ length: WEEKS }, (_, i) => weekLabel(end - (WEEKS - 1 - i) * WEEK_MS));

        const within = (days: number) => signals.filter(s => now - s.createdAt < days * 86_400_000);
        const share = (list: FeedbackSignal[]) => {
            const p = list.filter(s => POSITIVE.has(s.type)).length;
            const t = list.filter(s => POSITIVE.has(s.type) || NEGATIVE.has(s.type)).length;
            return t === 0 ? null : p / t;
        };
        const last30 = share(within(30));
        const prev30 = share(signals.filter(s => now - s.createdAt >= 30 * 86_400_000 && now - s.createdAt < 60 * 86_400_000));

        const complaints = new Map<string, number>();
        for (const s of signals) {
            if (s.type === 'dislike' && s.reason?.trim()) {
                const key = s.reason.trim();
                complaints.set(key, (complaints.get(key) ?? 0) + 1);
            }
        }
        const topComplaints = [...complaints.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);

        const distilledRules = rules.filter(r => r.sources.length > 0).length;
        const doneJobs = jobs.filter(j => j.stage === 'done' || j.resultIds.length > 0).length;
        const directives = jobs.reduce((sum, j) => sum + (j.directives?.length ?? 0), 0);

        return { posW, negW, alignment, labels, last30, prev30, topComplaints, distilledRules, doneJobs, directives };
    }, [signals, rules, jobs]);

    const statCard = (label: string, value: React.ReactNode, hint: string) => (
        <div style={{ ...S.card, flex: '1 1 120px', minWidth: 120, padding: '13px 15px', display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ ...S.label, color: '#71717a' }}>{label}</span>
            <span style={{ fontSize: 24, fontWeight: 850, color: '#18181b', letterSpacing: -0.4 }}>{value}</span>
            <span style={{ fontSize: 10, color: '#a1a1aa', lineHeight: 1.4 }}>{hint}</span>
        </div>
    );

    const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);
    const delta = stats.last30 !== null && stats.prev30 !== null ? Math.round((stats.last30 - stats.prev30) * 100) : null;

    const sectionTitle = (t: string, sub: string) => (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 14, fontWeight: 850, color: '#18181b' }}>{t}</span>
            <span style={{ fontSize: 11, color: '#a1a1aa' }}>{sub}</span>
        </div>
    );

    return (
        <div style={{ maxWidth: 860, margin: '0 auto', padding: '22px 26px', display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
                <div style={{ fontSize: 18, fontWeight: 850, color: '#18181b' }}>Brand growth</div>
                <div style={{ fontSize: 12, color: '#71717a', marginTop: 3 }}>
                    Every verdict you give becomes brand memory. This page shows the studio learning your taste.
                </div>
            </div>

            {!loaded && <div style={{ fontSize: 12, color: '#a1a1aa' }}>Reading the learning ledger…</div>}

            {loaded && signals.length === 0 && rules.length === 0 && (
                <div style={{ ...S.card, fontSize: 12.5, color: '#71717a', lineHeight: 1.6 }}>
                    Nothing to measure yet — run a task in Studio and rate the results. Likes, saves, critiques and
                    rules all land here as the studio starts learning your brand.
                </div>
            )}

            {loaded && (signals.length > 0 || rules.length > 0) && (
                <>
                    {/* Headline stats */}
                    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                        {statCard('Taste alignment', (
                            <span>
                                {pct(stats.last30)}
                                {delta !== null && delta !== 0 && (
                                    <span style={{ fontSize: 12, fontWeight: 800, marginLeft: 7, color: delta > 0 ? '#15803d' : '#b45309' }}>
                                        {delta > 0 ? '▲' : '▼'} {Math.abs(delta)}%
                                    </span>
                                )}
                            </span>
                        ), 'positive share of your verdicts, last 30 days vs prior 30')}
                        {statCard('Rules learned', rules.length, `${stats.distilledRules} distilled from your feedback, ${rules.length - stats.distilledRules} set by hand`)}
                        {statCard('Verdicts given', signals.length, 'likes, saves, critiques — every one is training data')}
                        {statCard('Tasks run', stats.doneJobs, `${stats.directives} director notes issued along the way`)}
                        {statCard('Critic calibrations', calibrations.length, 'times your judgment corrected the critic')}
                    </div>

                    {/* Taste alignment trend */}
                    <div style={{ ...S.card, display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {sectionTitle('Taste alignment over time', 'share of positive verdicts per week — up and to the right means the studio is learning')}
                        <TrendChart points={stats.alignment} labels={stats.labels} />
                    </div>

                    {/* Feedback activity */}
                    <div style={{ ...S.card, display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {sectionTitle('Feedback activity', 'weekly verdicts · ink = positive, amber = negative')}
                        <ActivityChart pos={stats.posW} neg={stats.negW} labels={stats.labels} />
                    </div>

                    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'stretch' }}>
                        {/* Brand memory */}
                        <div style={{ ...S.card, flex: '1 1 340px', display: 'flex', flexDirection: 'column', gap: 9 }}>
                            {sectionTitle('Brand memory', `${rules.length} standing rules the studio obeys`)}
                            {rules.length === 0 && <span style={{ fontSize: 11.5, color: '#a1a1aa' }}>No rules yet — save a directive as a rule, or let distillation propose them.</span>}
                            {[...rules].sort((a, b) => b.createdAt - a.createdAt).slice(0, 5).map(r => (
                                <div key={r.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                                    <span style={{
                                        flexShrink: 0, marginTop: 1, padding: '2px 8px', borderRadius: 999, fontSize: 9, fontWeight: 800,
                                        letterSpacing: 0.4, textTransform: 'uppercase',
                                        background: r.polarity === 'must' ? 'rgba(22,163,74,0.10)' : 'rgba(180,83,9,0.10)',
                                        color: r.polarity === 'must' ? '#15803d' : '#92400e',
                                        border: `1px solid ${r.polarity === 'must' ? 'rgba(22,163,74,0.25)' : 'rgba(180,83,9,0.22)'}`,
                                    }}>
                                        {r.polarity}
                                    </span>
                                    <span style={{ fontSize: 11.5, lineHeight: 1.5, color: r.enabled ? '#3f3f46' : '#a1a1aa', textDecoration: r.enabled ? 'none' : 'line-through' }}>
                                        {r.rule.length > 110 ? `${r.rule.slice(0, 110)}…` : r.rule}
                                    </span>
                                </div>
                            ))}
                        </div>

                        {/* Complaints */}
                        <div style={{ ...S.card, flex: '1 1 300px', display: 'flex', flexDirection: 'column', gap: 9 }}>
                            {sectionTitle('What you push back on', 'your most frequent critiques — the studio works on these')}
                            {stats.topComplaints.length === 0 && <span style={{ fontSize: 11.5, color: '#a1a1aa' }}>No critiques recorded yet.</span>}
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                                {stats.topComplaints.map(([reason, count]) => (
                                    <span key={reason} style={{
                                        display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderRadius: 999,
                                        border: '1px solid rgba(180,83,9,0.22)', background: 'rgba(255,251,235,0.9)',
                                        fontSize: 11, color: '#78350f', fontWeight: 600,
                                    }}>
                                        {reason}
                                        <span style={{ fontSize: 9.5, fontWeight: 850, color: '#b45309' }}>×{count}</span>
                                    </span>
                                ))}
                            </div>
                        </div>
                    </div>

                    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'stretch' }}>
                        {/* Soul weights */}
                        <div style={{ ...S.card, flex: '1 1 340px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                            {sectionTitle('Soul field weights', 'what learning has amplified or decayed · 🔒 = red-line, never touched')}
                            {soulFields.length === 0 && <span style={{ fontSize: 11.5, color: '#a1a1aa' }}>No soul defined yet — set it up in Brand.</span>}
                            {[...soulFields].sort((a, b) => b.weight - a.weight).slice(0, 10).map(f => (
                                <div key={f.key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <span style={{ width: 130, flexShrink: 0, fontSize: 10.5, fontWeight: 700, color: '#3f3f46', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                        {f.locked ? '🔒 ' : ''}{f.key}
                                    </span>
                                    <span style={{ flex: 1, height: 7, borderRadius: 999, background: 'rgba(228,228,231,0.8)', overflow: 'hidden' }}>
                                        <span style={{ display: 'block', height: '100%', width: `${Math.min(100, (f.weight / 2) * 100)}%`, borderRadius: 999, background: f.weight >= 1 ? '#18181b' : 'rgba(180,83,9,0.6)' }} />
                                    </span>
                                    <span style={{ width: 30, fontSize: 10, fontWeight: 800, color: f.weight >= 1 ? '#18181b' : '#b45309', textAlign: 'right' }}>{f.weight.toFixed(1)}</span>
                                </div>
                            ))}
                        </div>

                        {/* Critic calibration */}
                        <div style={{ ...S.card, flex: '1 1 300px', display: 'flex', flexDirection: 'column', gap: 9 }}>
                            {sectionTitle('Critic calibration', 'your verdicts teaching the critic its blind spots')}
                            {calibrations.length === 0 && (
                                <span style={{ fontSize: 11.5, color: '#a1a1aa', lineHeight: 1.5 }}>
                                    None yet. When you keep a set the critic scored low (or reject one it praised), the miss is
                                    remembered and every future crit reads it first.
                                </span>
                            )}
                            {calibrations.length > 0 && (
                                <>
                                    <div style={{ display: 'flex', gap: 14 }}>
                                        <span style={{ fontSize: 11.5, color: '#3f3f46' }}>
                                            <strong>{calibrations.filter(c => c.kind === 'liked-low').length}</strong> too strict
                                        </span>
                                        <span style={{ fontSize: 11.5, color: '#3f3f46' }}>
                                            <strong>{calibrations.filter(c => c.kind === 'disliked-high').length}</strong> missed what mattered
                                        </span>
                                    </div>
                                    {calibrations.slice(-3).reverse().map((c, i) => (
                                        <div key={i} style={{ fontSize: 10.5, color: '#71717a', lineHeight: 1.5 }}>
                                            {c.kind === 'liked-low' ? `Critic said ${c.overall}, you kept it` : `Critic said ${c.overall}, you rejected it`}
                                            {c.note ? ` — “${c.note.slice(0, 60)}${c.note.length > 60 ? '…' : ''}”` : ''}
                                        </div>
                                    ))}
                                </>
                            )}
                        </div>
                    </div>
                </>
            )}
        </div>
    );
}
