import React, { useEffect, useState } from 'react';
import { KnowledgeRule } from '../domain/types';
import { storage } from '../storage/local';
import { adoptionRate, distill } from '../learning/learning';
import {
    BrandSoul, SoulField, SOUL_SCHEMA, getBrandSoul, saveBrandSoul, deriveBrandSoul,
    deriveSoulFromWebsite, WebDerivation,
} from '../brain/soul';
import { getCurrentBrand, saveBrand } from '../domain/brand';
import { TasteCandidate, getCandidatePool, recordPick, analyzeTaste } from '../brain/calibrate';
import { exportBrandBook } from '../brain/brandBook';
import { openLightbox } from './lightbox';
import { S, chip } from './styles';

/**
 * Knowledge — the visible, editable experience base. Rules the system has
 * learned from feedback; humans prune what it learned wrong. This
 * inspectability is what keeps the learning loop trustworthy.
 */
export default function KnowledgeView() {
    const [panel, setPanel] = useState<'rules' | 'soul' | 'calibrate'>('rules');
    const [rules, setRules] = useState<KnowledgeRule[]>([]);
    const [signals, setSignals] = useState(0);
    const [pending, setPending] = useState(0);
    const [adoption, setAdoption] = useState({ adopted: 0, total: 0, rate: 0 });
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState('');

    const refresh = async () => {
        setRules(await storage.listRules());
        const all = await storage.listSignals();
        setSignals(all.length);
        setPending(all.filter(s => !s.distilled).length);
        setAdoption(await adoptionRate());
    };
    useEffect(() => { refresh(); }, []);

    const toggleRule = async (rule: KnowledgeRule) => {
        await storage.upsertRule({ ...rule, enabled: !rule.enabled, updatedAt: Date.now() });
        refresh();
    };
    const deleteRule = async (rule: KnowledgeRule) => {
        if (!window.confirm(`Delete this rule?\n\n"${rule.rule}"`)) return;
        await storage.deleteRule(rule.id);
        refresh();
    };
    const runDistill = async () => {
        setBusy(true);
        setMsg('Distilling… (5–15s)');
        try {
            const r = await distill();
            setMsg(`Distilled ${r.newRules} new rule${r.newRules === 1 ? '' : 's'} from ${r.consumed} signals`);
        } catch (err: any) {
            setMsg(`${err?.message || err}`);
        } finally {
            setBusy(false);
            refresh();
        }
    };

    const scopeText = (r: KnowledgeRule) =>
        [r.scope.outputType, r.scope.purpose, r.scope.room, r.scope.category].filter(Boolean).join(' · ') || 'all';

    return (
        <div style={{ maxWidth: 860, margin: '0 auto', padding: '22px 28px', display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <button style={chip(panel === 'rules')} onClick={() => setPanel('rules')}>Learned Rules</button>
                <button style={chip(panel === 'soul')} onClick={() => setPanel('soul')}>Brand Soul</button>
                <button style={chip(panel === 'calibrate')} onClick={() => setPanel('calibrate')}>Calibrate Taste</button>
                <button style={{ ...S.btnGhost, marginLeft: 'auto' }} onClick={() => exportBrandBook()}>
                    Export brand book
                </button>
            </div>

            {panel === 'soul' && <SoulPanel />}
            {panel === 'calibrate' && <CalibratePanel />}

            {panel === 'rules' && <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
                <Metric label="Adoption rate (north star)" value={`${(adoption.rate * 100).toFixed(0)}%`} sub={`${adoption.adopted} adopted / ${adoption.total} generated`} />
                <Metric label="Learned rules" value={String(rules.length)} sub={`${rules.filter(r => r.enabled).length} active`} />
                <Metric label="Feedback signals" value={String(signals)} sub={`${pending} awaiting distillation`} />
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={S.label}>Rules — injected into prompts when scope matches</span>
                <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    {msg && <span style={{ fontSize: 11, color: '#059669' }}>{msg}</span>}
                    <button style={{ ...S.btn, opacity: busy || pending === 0 ? 0.4 : 1 }} disabled={busy || pending === 0} onClick={runDistill}>
                        Distill now
                    </button>
                </span>
            </div>

            {rules.length === 0 && (
                <div style={{ ...S.card, fontSize: 12, color: '#a1a1aa' }}>
                    No rules yet. Rate generations in Create (especially dislikes with reasons) and distill.
                </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {rules.map(rule => (
                    <div key={rule.id} style={{ ...S.card, display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', opacity: rule.enabled ? 1 : 0.5 }}>
                        <span style={{
                            fontSize: 9, fontWeight: 800, letterSpacing: 1, padding: '3px 8px', borderRadius: 999, flexShrink: 0,
                            background: rule.polarity === 'must' ? '#ecfdf5' : '#fef2f2',
                            color: rule.polarity === 'must' ? '#047857' : '#b91c1c',
                        }}>
                            {rule.polarity.toUpperCase()}
                        </span>
                        <span style={{ flex: 1, minWidth: 0 }}>
                            <span style={{ display: 'block', fontSize: 13, fontWeight: 600 }}>{rule.rule}</span>
                            <span style={{ fontSize: 10, color: '#a1a1aa' }}>scope: {scopeText(rule)} · evidence: {rule.confidence} signal{rule.confidence === 1 ? '' : 's'}</span>
                        </span>
                        <button style={S.btnGhost} onClick={() => toggleRule(rule)}>{rule.enabled ? 'Disable' : 'Enable'}</button>
                        <button style={{ ...S.btnGhost, color: '#b91c1c' }} onClick={() => deleteRule(rule)}>Delete</button>
                    </div>
                ))}
            </div>
            </>}
        </div>
    );
}

/** Brand Soul — derive from evidence, review per field, lock red-lines. */
const SoulPanel: React.FC = () => {
    const [soul, setSoul] = useState<BrandSoul | null>(null);
    const [busy, setBusy] = useState('');
    const [dirty, setDirty] = useState(false);
    const [webSuggest, setWebSuggest] = useState<WebDerivation | null>(null);

    useEffect(() => { getBrandSoul().then(setSoul); }, []);

    const derive = async () => {
        setBusy('Deriving from brand evidence + approved imagery… (10–30s)');
        try {
            setSoul(await deriveBrandSoul());
            setDirty(true);
            setBusy('');
        } catch (err: any) { setBusy(`${err?.message || err}`); }
    };

    const deriveFromWeb = async () => {
        const url = window.prompt('Brand website URL (their homepage or About page):', 'https://')?.trim();
        if (!url || url === 'https://') return;
        setBusy('Reading the site + its imagery… (15–40s)');
        try {
            const d = await deriveSoulFromWebsite(url);
            setSoul(d.soul);
            setWebSuggest(d);
            setDirty(true);
            setBusy('Draft derived from the website — review below, then Save');
        } catch (err: any) { setBusy(`${err?.message || err}`); }
    };

    const applySuggestion = async () => {
        if (!webSuggest) return;
        const brand = await getCurrentBrand();
        await saveBrand({
            ...brand,
            description: webSuggest.suggestedDescription,
            productEssence: webSuggest.suggestedEssence,
        });
        setWebSuggest(null);
        setBusy('Brand description & essence updated');
    };

    const save = async () => {
        if (!soul) return;
        setBusy('Saving…');
        try { await saveBrandSoul(soul); setDirty(false); setBusy('Saved (previous version archived)'); }
        catch (err: any) { setBusy(`${err?.message || err}`); }
    };

    const update = (key: string, patch: Partial<SoulField>) => {
        if (!soul) return;
        setSoul({ ...soul, fields: soul.fields.map(f => f.key === key ? { ...f, ...patch } : f) });
        setDirty(true);
    };

    const byAxis = (axis: SoulField['axis']) => (soul?.fields ?? []).filter(f => f.axis === axis);
    const specOf = (key: string) => SOUL_SCHEMA.find(s => s.key === key);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <button style={S.btn} onClick={derive}>{soul ? 'Re-derive draft' : 'Derive brand soul'}</button>
                <button style={S.btnGhost} onClick={deriveFromWeb} title="Point at any brand website — its words and imagery become a soul draft">
                    From website
                </button>
                {soul && <button style={{ ...S.btn, opacity: dirty ? 1 : 0.4 }} disabled={!dirty} onClick={save}>Save</button>}
                <span style={{ fontSize: 11, color: '#71717a' }}>{busy}</span>
            </div>
            {webSuggest && (
                <div style={{ ...S.card, fontSize: 12, display: 'flex', flexDirection: 'column', gap: 6, background: '#fffbeb' }}>
                    <span style={{ fontWeight: 700 }}>The site also suggests brand meta — apply?</span>
                    <span>Description: {webSuggest.suggestedDescription}</span>
                    <span>Product essence: {webSuggest.suggestedEssence}</span>
                    <span style={{ display: 'flex', gap: 8 }}>
                        <button style={S.btn} onClick={applySuggestion}>Apply to brand</button>
                        <button style={S.btnGhost} onClick={() => setWebSuggest(null)}>Ignore</button>
                    </span>
                </div>
            )}
            {!soul && <div style={{ ...S.card, fontSize: 12, color: '#a1a1aa' }}>
                No soul yet. Derive it from the brand description, learned rules, feedback and approved imagery — then review, edit, and lock the red-lines.
            </div>}
            {soul && (['narrative', 'sensation', 'viewing'] as const).map(axis => (
                <div key={axis}>
                    <div style={{ ...S.label, margin: '6px 0' }}>{axis.toUpperCase()}</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {byAxis(axis).map(f => (
                            <div key={f.key} style={{ ...S.card, padding: '10px 14px', border: f.locked ? '1.5px solid #d97706' : undefined }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                                    <span style={{ fontSize: 11, fontWeight: 700 }}>
                                        {specOf(f.key)?.label ?? f.key} <span style={{ color: '#a1a1aa', fontWeight: 400 }}>· w{f.weight.toFixed(1)}</span>
                                    </span>
                                    <button style={S.btnGhost} onClick={() => update(f.key, { locked: !f.locked })}>
                                        {f.locked ? 'Locked' : 'Lock'}
                                    </button>
                                </div>
                                <textarea
                                    style={{ ...S.input, width: '100%', boxSizing: 'border-box', minHeight: 40, resize: 'vertical', fontSize: 12 }}
                                    value={f.value}
                                    onChange={e => update(f.key, { value: e.target.value })}
                                />
                                {f.rationale && <div style={{ fontSize: 10, color: '#a1a1aa', marginTop: 3 }}>Basis: {f.rationale}</div>}
                            </div>
                        ))}
                    </div>
                </div>
            ))}
        </div>
    );
};

/** Taste calibration — "which is more us?" Rapid pairs from existing
 *  imagery; one batched vision call turns picks into soul refinements. */
const CalibratePanel: React.FC = () => {
    const [pool, setPool] = useState<TasteCandidate[]>([]);
    const [idx, setIdx] = useState(0);
    const [winners, setWinners] = useState<TasteCandidate[]>([]);
    const [losers, setLosers] = useState<TasteCandidate[]>([]);
    const [busy, setBusy] = useState('');
    const [summary, setSummary] = useState('');

    useEffect(() => { getCandidatePool().then(setPool); }, []);

    const a = pool[idx];
    const b = pool[idx + 1];
    const picks = winners.length;

    const pick = async (winner: TasteCandidate, loser: TasteCandidate) => {
        setWinners(w => [...w, winner]);
        setLosers(l => [...l, loser]);
        setIdx(i => i + 2);
        recordPick({ winnerId: winner.id, loserId: loser.id, createdAt: Date.now() });
    };

    const analyze = async () => {
        setBusy('Analyzing your taste… (one vision call)');
        try {
            const r = await analyzeTaste(winners.map(w => w.image), losers.map(l => l.image));
            setSummary(r.summary);
            setBusy(`Refined ${r.refined} soul field${r.refined === 1 ? '' : 's'} — review them in Brand Soul`);
        } catch (err: any) { setBusy(`${err?.message || err}`); }
    };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <p style={{ fontSize: 12, color: '#71717a', margin: 0 }}>
                Which is more <em>us</em>? Pick at least 5 pairs, then analyze — preferences become concrete soul refinements (sensation & viewing only; locked fields untouched).
            </p>
            {a && b ? (
                <div style={{ display: 'flex', gap: 12 }}>
                    {[{ me: a, other: b }, { me: b, other: a }].map(({ me, other }, i) => (
                        <button key={i} onClick={() => pick(me, other)}
                            style={{ position: 'relative', padding: 4, borderRadius: 14, cursor: 'pointer', border: '1px solid #e4e4e7', background: '#fff' }}>
                            <img src={me.image} alt="" style={{ width: 280, height: 280, objectFit: 'cover', borderRadius: 10, display: 'block' }} />
                            <span onClick={e => { e.stopPropagation(); openLightbox(me.image); }} title="View full size"
                                style={{ position: 'absolute', top: 10, right: 10, background: 'rgba(0,0,0,0.45)', color: '#fff', borderRadius: 8, padding: '2px 7px', fontSize: 13, cursor: 'zoom-in' }}>Zoom</span>
                        </button>
                    ))}
                </div>
            ) : (
                <div style={{ ...S.card, fontSize: 12, color: '#a1a1aa' }}>
                    {pool.length < 2 ? 'Need at least 2 images (references or results) to play.' : 'Pool exhausted — analyze below.'}
                </div>
            )}
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <span style={{ fontSize: 11, color: '#71717a' }}>{picks} pick{picks === 1 ? '' : 's'}</span>
                <button style={{ ...S.btn, opacity: picks >= 5 ? 1 : 0.4 }} disabled={picks < 5 || !!busy} onClick={analyze}>
                    Analyze my taste → refine soul
                </button>
                <span style={{ fontSize: 11, color: '#059669' }}>{busy}</span>
            </div>
            {summary && <div style={{ ...S.card, fontSize: 12.5, lineHeight: 1.6 }}>{summary}</div>}
        </div>
    );
};

const Metric: React.FC<{ label: string; value: string; sub: string }> = ({ label, value, sub }) => (
    <div style={{ background: '#f4f4f5', borderRadius: 12, padding: '12px 16px' }}>
        <div style={{ fontSize: 11, color: '#71717a' }}>{label}</div>
        <div style={{ fontSize: 24, fontWeight: 600, margin: '2px 0' }}>{value}</div>
        <div style={{ fontSize: 10, color: '#a1a1aa' }}>{sub}</div>
    </div>
);
