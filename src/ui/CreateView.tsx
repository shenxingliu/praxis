import React, { useEffect, useMemo, useState } from 'react';
import { Asset, GenerationParams, GenerationResult, OutputType, Purpose, Reference } from '../domain/types';
import { storage } from '../storage/local';
import { INVENTORY_CHANGED_EVENT } from './events';
import { generate, BudgetExceededError } from '../engine/engine';
import { recordSignal, maybeDistill } from '../learning/learning';
import { S, chip } from './styles';

/**
 * CREATE — the one-screen flow on top of the 2.0 engine:
 * pick assets → pick output type → purposeful controls → generate →
 * results inline. Every action feeds the learning loop.
 */

const MODES: Array<{ id: OutputType; name: string; hint: string }> = [
    { id: 'scene', name: 'Scene', hint: 'Full styled room' },
    { id: 'silo', name: 'Silo', hint: 'Clean backdrop' },
    { id: 'detail', name: 'Detail', hint: 'Close-up · texture' },
    { id: 'fabric', name: 'Fabric', hint: 'Upholstery render' },
];
const PURPOSES: Array<{ id: Purpose; label: string }> = [
    { id: 'hero', label: 'Hero Shot' },
    { id: 'pdp', label: 'Detail Page' },
    { id: 'social', label: 'Social' },
    { id: 'seasonal', label: 'Seasonal' },
];
const ROOMS = ['Bedroom', 'Living Room', 'Dining Room', 'Office / Study'];
const BACKDROPS = [{ id: 'white', label: 'Pure white' }, { id: 'warm', label: 'Warm gray' }, { id: 'env', label: 'Environmental' }];
const FOCUS = ['Joinery', 'Hardware', 'Wood grain', 'Edges & profile'];
const RATIOS: GenerationParams['ratio'][] = ['1:1', '16:9', '4:3', '3:4', '9:16'];

// Studio (expert) options — ported from V1.3's full control set.
const CAMERAS = ['Auto', 'Hero Front', '3/4 View', 'Full Room', 'Low Angle'];
const LENSES = ['Auto', '55mm', '85mm', '100mm', '120mm'];
const LIGHTS = ['Auto', 'Soft Morning', 'Golden Hour', 'Overcast', 'Studio', 'Night Lamps'];
const MARGINS = [5, 10, 20];
const BEDDINGS = ['none', 'minimal', 'styled'];

export default function CreateView() {
    const [assets, setAssets] = useState<Asset[]>([]);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [query, setQuery] = useState('');

    const [mode, setMode] = useState<OutputType>('scene');
    const [purpose, setPurpose] = useState<Purpose>('pdp');
    const [room, setRoom] = useState('Bedroom');
    const [backdrop, setBackdrop] = useState('white');
    const [focus, setFocus] = useState('Wood grain');
    const [ratio, setRatio] = useState<GenerationParams['ratio']>('16:9');
    const [count, setCount] = useState(1);
    const [note, setNote] = useState('');

    // Studio (expert) controls — hidden behind a toggle, all default Auto.
    const [showStudio, setShowStudio] = useState(false);
    const [camera, setCamera] = useState('Auto');
    const [lens, setLens] = useState('Auto');
    const [lighting, setLighting] = useState('Auto');
    const [margin, setMargin] = useState(10);
    const [bedding, setBedding] = useState('none');
    const [plateId, setPlateId] = useState<string | null>(null);
    const [plates, setPlates] = useState<Reference[]>([]);

    const [isGenerating, setIsGenerating] = useState(false);
    const [status, setStatus] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [results, setResults] = useState<GenerationResult[]>([]);
    const [feedbackGiven, setFeedbackGiven] = useState<Map<string, 'like' | 'dislike'>>(new Map());
    const [adoptedIds, setAdoptedIds] = useState<Set<string>>(new Set());

    const refresh = () => {
        storage.listAssets().then(setAssets);
        storage.listReferences('plate').then(setPlates);
    };
    useEffect(() => {
        refresh();
        storage.listResults(30).then(setResults);
        window.addEventListener(INVENTORY_CHANGED_EVENT, refresh);
        return () => window.removeEventListener(INVENTORY_CHANGED_EVENT, refresh);
    }, []);

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        return q
            ? assets.filter(a => a.name.toLowerCase().includes(q) || (a.category ?? '').toLowerCase().includes(q))
            : assets;
    }, [assets, query]);

    const toggle = (id: string) =>
        setSelected(prev => {
            const n = new Set(prev);
            n.has(id) ? n.delete(id) : n.add(id);
            return n;
        });

    const canGenerate = selected.size > 0 && !isGenerating;

    const run = async () => {
        if (!canGenerate) return;
        setIsGenerating(true);
        setError(null);
        try {
            const params: GenerationParams = {
                outputType: mode,
                purpose: mode === 'scene' ? purpose : undefined,
                room: mode === 'scene' ? room : undefined,
                focus: mode === 'detail' ? focus : undefined,
                backdrop: mode === 'silo' ? backdrop : undefined,
                ratio,
                note: note.trim() || undefined,
                modelTier: 'auto',
                camera: camera !== 'Auto' ? camera : undefined,
                lens: lens !== 'Auto' ? lens : undefined,
                lighting: lighting !== 'Auto' ? lighting : undefined,
                margin: mode === 'silo' ? margin : undefined,
                bedding: mode === 'silo' && bedding !== 'none' ? bedding : undefined,
                plateId: mode === 'silo' ? plateId ?? undefined : undefined,
            };
            for (let i = 0; i < count; i++) {
                setStatus(count > 1 ? `Generating ${i + 1}/${count}…` : 'Generating…');
                const result = await generate(params, Array.from(selected), setStatus);
                setResults(prev => [result, ...prev].slice(0, 60)); // cap in-memory base64 results
            }
        } catch (err: any) {
            setError(err instanceof BudgetExceededError ? err.message : err?.message || 'Generation failed');
        } finally {
            setIsGenerating(false);
            setStatus('');
        }
    };

    const rate = async (r: GenerationResult, rating: 'like' | 'dislike') => {
        const reason = rating === 'dislike'
            ? window.prompt('What went wrong? (this teaches the AI — be specific)') ?? undefined
            : undefined;
        await recordSignal(r, rating, reason);
        setFeedbackGiven(prev => new Map(prev).set(r.id, rating));
        maybeDistill();
    };

    const download = async (r: GenerationResult) => {
        const a = document.createElement('a');
        a.href = r.image.value;
        a.download = `${r.params.outputType}-${r.id.slice(0, 6)}.png`;
        a.click();
        await recordSignal(r, 'export');
        setAdoptedIds(prev => new Set(prev).add(r.id));
    };

    const save = async (r: GenerationResult) => {
        const saved = { ...r, adopted: true, createdAt: Date.now() };
        await storage.upsertResult(saved);
        await recordSignal(saved, 'save').catch(() => {});
        setResults(prev => prev.map(x => x.id === r.id ? saved : x));
        setAdoptedIds(prev => new Set(prev).add(r.id));
    };

    return (
        <div style={{ display: 'flex', height: '100%' }}>
            {/* Assets */}
            <div style={{ width: 230, flexShrink: 0, borderRight: '1px solid #e4e4e7', background: '#fff', display: 'flex', flexDirection: 'column' }}>
                <div style={{ padding: '14px 14px 6px', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <span style={S.label}>1 · Assets</span>
                    <span style={{ fontSize: 10, color: '#a1a1aa' }}>{selected.size} selected</span>
                </div>
                <div style={{ padding: '0 14px 8px' }}>
                    <input style={{ ...S.input, width: '100%', boxSizing: 'border-box' }} placeholder="Search…" value={query} onChange={e => setQuery(e.target.value)} />
                </div>
                <div style={{ flex: 1, overflow: 'auto', padding: '0 14px 14px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {filtered.map(a => {
                        const on = selected.has(a.id);
                        return (
                            <button key={a.id} onClick={() => toggle(a.id)}
                                style={{ display: 'flex', gap: 10, alignItems: 'center', padding: 6, borderRadius: 10, cursor: 'pointer', textAlign: 'left', background: on ? '#f4f4f5' : '#fff', border: on ? '1.5px solid #18181b' : '1px solid #e4e4e7' }}>
                                {a.photos[0] && <img src={a.photos[0].image.value} alt="" style={{ width: 40, height: 40, borderRadius: 8, objectFit: 'cover', flexShrink: 0 }} />}
                                <span style={{ minWidth: 0 }}>
                                    <span style={{ display: 'block', fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
                                    <span style={{ fontSize: 10, color: '#a1a1aa' }}>{a.category || '—'} · {a.photos.length} photo{a.photos.length === 1 ? '' : 's'}</span>
                                </span>
                            </button>
                        );
                    })}
                    {filtered.length === 0 && <p style={{ fontSize: 11, color: '#a1a1aa' }}>No assets. Import V1 data in System tab.</p>}
                </div>
            </div>

            {/* Main */}
            <div style={{ flex: 1, overflow: 'auto' }}>
                <div style={{ maxWidth: 860, margin: '0 auto', padding: '22px 28px', display: 'flex', flexDirection: 'column', gap: 14 }}>

                    <div>
                        <div style={{ ...S.label, marginBottom: 6 }}>2 · Output type</div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
                            {MODES.map(m => {
                                const on = mode === m.id;
                                return (
                                    <button key={m.id} onClick={() => setMode(m.id)}
                                        style={{ textAlign: 'left', padding: '10px 12px', borderRadius: 12, cursor: 'pointer', border: on ? '1.5px solid #18181b' : '1px solid #e4e4e7', background: on ? '#18181b' : '#fff', color: on ? '#fff' : '#3f3f46' }}>
                                        <div style={{ fontSize: 14, fontWeight: 700 }}>{m.name}</div>
                                        <div style={{ fontSize: 10, opacity: 0.7, marginTop: 2 }}>{m.hint}</div>
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    <div style={{ ...S.card, display: 'flex', flexDirection: 'column', gap: 10 }}>
                        {mode === 'scene' && (
                            <>
                                <Row label="Purpose">{PURPOSES.map(p => <button key={p.id} style={chip(purpose === p.id)} onClick={() => setPurpose(p.id)}>{p.label}</button>)}</Row>
                                <Row label="Room">{ROOMS.map(r => <button key={r} style={chip(room === r)} onClick={() => setRoom(r)}>{r}</button>)}</Row>
                            </>
                        )}
                        {mode === 'silo' && <Row label="Backdrop">{BACKDROPS.map(b => <button key={b.id} style={chip(backdrop === b.id)} onClick={() => setBackdrop(b.id)}>{b.label}</button>)}</Row>}
                        {mode === 'detail' && <Row label="Focus">{FOCUS.map(f => <button key={f} style={chip(focus === f)} onClick={() => setFocus(f)}>{f}</button>)}</Row>}
                        <Row label="Ratio">{RATIOS.map(r => <button key={r} style={chip(ratio === r)} onClick={() => setRatio(r)}>{r}</button>)}</Row>
                        <Row label="Count">{[1, 2, 3].map(n => <button key={n} style={chip(count === n)} onClick={() => setCount(n)}>{n}</button>)}</Row>

                        {/* Studio (expert) drawer — everything V1.3 had, collapsed by default */}
                        <div style={{ borderTop: '1px solid #f4f4f5', paddingTop: 8 }}>
                            <button onClick={() => setShowStudio(s => !s)}
                                style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 700, letterSpacing: 1, color: showStudio ? '#18181b' : '#a1a1aa' }}>
                                {showStudio ? '▾' : '▸'} STUDIO CONTROLS
                                <span style={{ fontWeight: 400, letterSpacing: 0, textTransform: 'none', marginLeft: 8, color: '#a1a1aa' }}>
                                    camera · lens · light{mode === 'silo' ? ' · margin · bedding · plate' : ''} — Auto by default
                                </span>
                            </button>
                            {showStudio && (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
                                    <Row label="Camera">{CAMERAS.map(c => <button key={c} style={chip(camera === c)} onClick={() => setCamera(c)}>{c}</button>)}</Row>
                                    <Row label="Lens">{LENSES.map(l => <button key={l} style={chip(lens === l)} onClick={() => setLens(l)}>{l}</button>)}</Row>
                                    <Row label="Light">{LIGHTS.map(l => <button key={l} style={chip(lighting === l)} onClick={() => setLighting(l)}>{l}</button>)}</Row>
                                    {mode === 'silo' && (
                                        <>
                                            <Row label="Margin">{MARGINS.map(m => <button key={m} style={chip(margin === m)} onClick={() => setMargin(m)}>{m}%</button>)}</Row>
                                            <Row label="Bedding">{BEDDINGS.map(b => <button key={b} style={chip(bedding === b)} onClick={() => setBedding(b)}>{b}</button>)}</Row>
                                            {plates.length > 0 && (
                                                <Row label="Plate">
                                                    <button style={chip(plateId === null)} onClick={() => setPlateId(null)}>None</button>
                                                    {plates.map(p => (
                                                        <button key={p.id} onClick={() => setPlateId(plateId === p.id ? null : p.id)} title={p.name}
                                                            style={{ padding: 2, borderRadius: 8, cursor: 'pointer', border: plateId === p.id ? '2px solid #18181b' : '1px solid #d4d4d8', background: '#fff' }}>
                                                            <img src={p.image.value} alt={p.name} style={{ width: 36, height: 36, borderRadius: 6, objectFit: 'cover', display: 'block' }} />
                                                        </button>
                                                    ))}
                                                </Row>
                                            )}
                                        </>
                                    )}
                                </div>
                            )}
                        </div>
                        <div style={{ display: 'flex', gap: 8 }}>
                            <input style={{ ...S.input, flex: 1 }} placeholder='Anything specific? e.g. "morning light", "autumn accents"…' value={note} onChange={e => setNote(e.target.value)} />
                            <button style={{ ...S.btn, opacity: canGenerate ? 1 : 0.4 }} disabled={!canGenerate} onClick={run}>
                                {isGenerating ? 'Generating…' : 'Generate'}
                            </button>
                        </div>
                        <div style={{ fontSize: 10, color: '#a1a1aa' }}>
                            Brand DNA · learned rules · promoted references — applied automatically
                            {selected.size === 0 && ' · pick at least one asset on the left'}
                        </div>
                    </div>

                    {isGenerating && <div style={{ ...S.card, fontSize: 12, color: '#52525b' }}>{status || 'Working…'}</div>}
                    {error && <div style={S.err}>{error}</div>}

                    {results.length > 0 && (
                        <div>
                            <div style={{ ...S.label, marginBottom: 6 }}>Results · {results.length}</div>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
                                {results.map(r => {
                                    const fb = feedbackGiven.get(r.id);
                                    const adopted = adoptedIds.has(r.id) || r.adopted;
                                    return (
                                        <div key={r.id} style={{ ...S.card, padding: 0, overflow: 'hidden' }}>
                                            <img src={r.image.value} alt="" style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', display: 'block' }} />
                                            <div style={{ padding: '8px 10px' }}>
                                                <div style={{ fontSize: 11, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                    {r.params.outputType}{r.params.room ? ` · ${r.params.room}` : ''} · ${r.estimatedCostUsd.toFixed(2)}
                                                </div>
                                                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
                                                    <span style={{ display: 'flex', gap: 8 }}>
                                                        <button title="Like — teaches the AI" onClick={() => rate(r, 'like')} style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 14, opacity: fb === 'like' ? 1 : 0.35 }}>+</button>
                                                        <button title="Dislike — teaches the AI" onClick={() => rate(r, 'dislike')} style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 14, opacity: fb === 'dislike' ? 1 : 0.35 }}>-</button>
                                                    </span>
                                                    <span style={{ display: 'flex', gap: 6 }}>
                                                        <button style={S.btnGhost} title="Download the file" onClick={() => download(r)}>↓</button>
                                                        <button style={{ ...S.btnGhost, ...(adopted ? { opacity: 0.5 } : {}) }} disabled={adopted} onClick={() => save(r)}>{adopted ? 'Done' : 'Save'}</button>
                                                    </span>
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ ...S.label, width: 60, flexShrink: 0 }}>{label}</span>
        {children}
    </div>
);
