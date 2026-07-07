import React, { useEffect, useState } from 'react';
import { Asset, GenerationParams, GenerationResult } from '../domain/types';
import { storage } from '../storage/local';
import { QuickPreset, listPresets, deletePreset, runPreset } from '../engine/presets';
import { recordSignal, maybeDistill } from '../learning/learning';
import { attributeFeedback } from '../brain/soul';
import { BudgetExceededError } from '../engine/engine';
import { INVENTORY_CHANGED_EVENT } from './events';
import { openLightbox } from './lightbox';
import { S, chip } from './styles';

/**
 * QUICK — preset-based generation: same approved look, different hero.
 * Two steps by design: DRAFT (flash, cheap) → EXECUTE (pro, final).
 * Presets are saved from Studio results (Save as preset).
 */

const RATIOS: GenerationParams['ratio'][] = ['1:1', '16:9', '4:3', '3:4', '9:16'];
const SIZES: NonNullable<GenerationParams['size']>[] = ['1K', '2K', '4K'];

export default function QuickView() {
    const [presets, setPresets] = useState<QuickPreset[]>([]);
    const [assets, setAssets] = useState<Asset[]>([]);
    const [presetId, setPresetId] = useState<string | null>(null);
    const [selectedAssets, setSelectedAssets] = useState<Set<string>>(new Set());
    const [ratio, setRatio] = useState<GenerationParams['ratio'] | null>(null);
    const [size, setSize] = useState<NonNullable<GenerationParams['size']> | null>(null);
    const [note, setNote] = useState('');
    const [results, setResults] = useState<Array<GenerationResult & { tier: 'flash' | 'pro' }>>([]);
    const [busy, setBusy] = useState('');
    const [notice, setNotice] = useState('');
    const [feedback, setFeedback] = useState<Map<string, 'like' | 'dislike'>>(new Map());

    const refresh = () => {
        listPresets().then(setPresets);
        storage.listAssets().then(setAssets);
    };
    useEffect(() => {
        refresh();
        window.addEventListener(INVENTORY_CHANGED_EVENT, refresh);
        return () => window.removeEventListener(INVENTORY_CHANGED_EVENT, refresh);
    }, []);

    const preset = presets.find(p => p.id === presetId) ?? null;
    const effRatio = ratio ?? preset?.params.ratio ?? '4:3';
    const effSize = size ?? preset?.params.size ?? '1K';

    const runTier = async (tier: 'flash' | 'pro') => {
        if (!preset) { setNotice('Pick a preset first.'); return; }
        if (selectedAssets.size === 0) { setNotice('Pick at least one hero.'); return; }
        setBusy(tier === 'flash' ? 'Draft (flash)…' : 'Executing (pro)…');
        setNotice('');
        try {
            const r = await runPreset(
                preset, Array.from(selectedAssets),
                { ratio: effRatio, size: effSize, note: note.trim() || preset.params.note },
                tier, setBusy
            );
            setResults(prev => [{ ...r, tier }, ...prev]);
            setNotice(tier === 'flash' ? 'Draft ready — happy? Execute in pro.' : 'Final rendered.');
        } catch (err: any) {
            setNotice(`${err instanceof BudgetExceededError ? err.message : err?.message || err}`);
        } finally { setBusy(''); }
    };

    const removePreset = async (p: QuickPreset) => {
        if (!window.confirm(`Delete preset "${p.name}"?`)) return;
        await deletePreset(p.id);
        if (presetId === p.id) setPresetId(null);
        refresh();
    };

    const rate = async (r: GenerationResult, rating: 'like' | 'dislike') => {
        const reason = rating === 'dislike'
            ? window.prompt('What went wrong? (this teaches the studio)') ?? undefined
            : undefined;
        await recordSignal(r, rating, reason);
        if (rating === 'dislike' && reason) attributeFeedback(reason);
        setFeedback(prev => new Map(prev).set(r.id, rating));
        maybeDistill();
    };

    const download = async (r: GenerationResult) => {
        const a = document.createElement('a');
        a.href = r.image.value;
        a.download = `praxis-quick-${r.id.slice(0, 6)}.png`;
        a.click();
        await recordSignal(r, 'export');
    };

    return (
        <div style={{ maxWidth: 980, margin: '0 auto', padding: '22px 28px', display: 'flex', flexDirection: 'column', gap: 14 }}>
            {(busy || notice) && (
                <div className={busy ? 'praxis-running' : undefined}
                    style={{
                        position: 'sticky', top: 8, zIndex: 10, fontSize: 12.5, fontWeight: 600,
                        padding: '8px 14px', borderRadius: 10,
                        background: busy ? '#f4f4f5' : notice.startsWith('Error') ? '#f4f4f5' : '#f7f7f8',
                        color: '#18181b',
                        border: '1px solid rgba(0,0,0,0.06)',
                    }}>
                    {busy ? `${busy}` : notice}
                </div>
            )}

            <div>
                <div style={{ ...S.label, marginBottom: 6 }}>1 · PRESET · {presets.length}</div>
                {presets.length === 0 && (
                    <div style={{ ...S.card, fontSize: 12, color: '#a1a1aa' }}>
                        No presets yet. Run a job in Studio, then hit Save on a result you love — its full setup becomes a preset here.
                    </div>
                )}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 }}>
                    {presets.map(p => (
                        <div key={p.id}
                            style={{ ...S.card, padding: 0, overflow: 'hidden', position: 'relative', cursor: 'pointer', border: presetId === p.id ? '2.5px solid #18181b' : '1px solid #e4e4e7' }}
                            onClick={() => setPresetId(p.id)}>
                            <img src={p.anchorImage} alt={p.name} style={{ width: '100%', aspectRatio: '4/3', objectFit: 'cover', display: 'block' }}
                                onClick={e => { if (presetId === p.id) { e.stopPropagation(); openLightbox(p.anchorImage); } }} />
                            <div style={{ padding: '5px 8px', fontSize: 10.5, fontWeight: 600, display: 'flex', justifyContent: 'space-between' }}>
                                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                                <span style={{ color: '#a1a1aa', flexShrink: 0 }}>{p.params.ratio}</span>
                            </div>
                            <button onClick={e => { e.stopPropagation(); removePreset(p); }} title="Delete preset"
                                style={{ position: 'absolute', top: 4, right: 4, border: 'none', borderRadius: 6, background: 'rgba(0,0,0,0.45)', color: '#fff', fontSize: 10, cursor: 'pointer', padding: '2px 6px' }}>✕</button>
                        </div>
                    ))}
                </div>
            </div>

            <div>
                <div style={{ ...S.label, marginBottom: 6 }}>2 · HEROES · {selectedAssets.size} selected</div>
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
                </div>
            </div>

            <div style={{ ...S.card, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={S.label}>RATIO</span>
                    {RATIOS.map(r => <button key={r} style={chip(effRatio === r)} disabled={!!busy} onClick={() => setRatio(r)}>{r}</button>)}
                    <span style={{ ...S.label, marginLeft: 8 }}>SIZE</span>
                    {SIZES.map(s => <button key={s} style={chip(effSize === s)} disabled={!!busy} onClick={() => setSize(s)}>{s}</button>)}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                    <input style={{ ...S.input, flex: 1 }} placeholder="Optional tweak — otherwise the preset's own art direction is used…"
                        value={note} onChange={e => setNote(e.target.value)} />
                    <button style={S.btnGhost} disabled={!!busy || !preset || selectedAssets.size === 0} onClick={() => runTier('flash')}>
                        3 · Draft (flash · cheap)
                    </button>
                    <button style={S.btn} disabled={!!busy || !preset || selectedAssets.size === 0} onClick={() => runTier('pro')}>
                        4 · Execute (pro · final)
                    </button>
                </div>
            </div>

            {results.length > 0 && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 10 }}>
                    {results.map(r => {
                        const fb = feedback.get(r.id);
                        return (
                            <div key={r.id} style={{ ...S.card, padding: 0, overflow: 'hidden' }}>
                                <img src={r.image.value} alt="" onClick={() => openLightbox(r.image.value)}
                                    style={{ width: '100%', display: 'block', cursor: 'zoom-in' }} />
                                <div style={{ padding: '6px 10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    <span style={{ fontSize: 10, fontWeight: 700, color: r.tier === 'pro' ? '#047857' : '#a1a1aa' }}>
                                        {r.tier === 'pro' ? 'FINAL' : 'DRAFT'} · ${r.estimatedCostUsd.toFixed(2)}
                                    </span>
                                    <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                        <button onClick={() => rate(r, 'like')} style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 13, opacity: fb === 'like' ? 1 : 0.35 }}>+</button>
                                        <button onClick={() => rate(r, 'dislike')} style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 13, opacity: fb === 'dislike' ? 1 : 0.35 }}>-</button>
                                        <button style={S.btnGhost} title="Save to Gallery" onClick={async () => { await recordSignal(r, 'save'); setNotice('Saved — find it in Gallery.'); }}>Gallery</button>
                                        <button style={S.btnGhost} onClick={() => download(r)}>Save</button>
                                    </span>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
