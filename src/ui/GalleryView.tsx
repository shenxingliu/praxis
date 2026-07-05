import React, { useEffect, useState } from 'react';
import { GenerationResult } from '../domain/types';
import { storage } from '../storage/local';
import { getCurrentBrand } from '../domain/brand';
import { recordSignal } from '../learning/learning';
import { openLightbox } from './lightbox';
import { S, chip } from './styles';

/**
 * GALLERY — every generation is stored in the cloud with its full recipe
 * (exact prompt, params, concepts used). Saved (adopted) images are the
 * curated set: downloadable anytime, and exportable as a LoRA training
 * set (image + prompt pairs) — the LoRA door, opened.
 */

export default function GalleryView() {
    const [results, setResults] = useState<GenerationResult[]>([]);
    const [view, setView] = useState<'saved' | 'all'>('saved');
    const [busy, setBusy] = useState('');
    const [notice, setNotice] = useState('');

    const refresh = () => storage.listResults(500).then(setResults);
    useEffect(() => { refresh(); }, []);

    const shown = view === 'saved' ? results.filter(r => r.adopted) : results;
    const savedCount = results.filter(r => r.adopted).length;

    const toggleSave = async (r: GenerationResult) => {
        if (r.adopted) {
            await storage.upsertResult({ ...r, adopted: false });
        } else {
            await recordSignal(r, 'save'); // marks adopted + feeds learning
        }
        refresh();
    };

    const download = async (r: GenerationResult) => {
        const a = document.createElement('a');
        a.href = r.image.value;
        a.download = `praxis-${new Date(r.createdAt).toISOString().slice(0, 10)}-${r.id.slice(0, 6)}.png`;
        a.click();
        if (!r.adopted) { await recordSignal(r, 'export'); refresh(); }
    };

    /** LoRA training set: saved images + their exact prompts and recipes. */
    const exportTrainingSet = async () => {
        const brand = await getCurrentBrand();
        const adopted = results.filter(r => r.adopted && r.image.kind === 'data');
        if (adopted.length === 0) { setNotice('❌ Nothing saved yet — save some images first.'); return; }
        setBusy(`Packing ${adopted.length} pairs…`);
        try {
            const entries = adopted.map(r => ({
                id: r.id,
                prompt: r.fullPrompt,
                image: r.image.value,
                params: r.params,
                elementIds: r.elementIds ?? [],
                model: r.model,
                createdAt: r.createdAt,
            }));
            const blob = new Blob(
                [JSON.stringify({ brand: brand.id, exportedAt: Date.now(), count: entries.length, entries })],
                { type: 'application/json' }
            );
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `praxis-training-${brand.id}-${entries.length}.json`;
            a.click();
            URL.revokeObjectURL(a.href);
            setNotice(`✓ Exported ${entries.length} image+prompt pairs`);
        } catch (err: any) { setNotice(`❌ ${err?.message || err}`); }
        setBusy('');
    };

    const remove = async (r: GenerationResult) => {
        if (!window.confirm('Delete this image permanently from the cloud?')) return;
        await recordSignal(r, 'discard'); // the learning loop hears about it first
        await storage.deleteResult(r.id);
        setNotice('✓ Deleted');
        refresh();
    };

    return (
        <div style={{ maxWidth: 1080, margin: '0 auto', padding: '22px 28px', display: 'flex', flexDirection: 'column', gap: 14 }}>
            {(busy || notice) && (
                <div className={busy ? 'praxis-running' : undefined}
                    style={{
                        position: 'sticky', top: 8, zIndex: 10, fontSize: 12.5, fontWeight: 600,
                        padding: '8px 14px', borderRadius: 10,
                        background: busy ? '#fef3c7' : notice.startsWith('❌') ? '#fef2f2' : '#ecfdf5',
                        color: busy ? '#92400e' : notice.startsWith('❌') ? '#b91c1c' : '#047857',
                        border: '1px solid rgba(0,0,0,0.06)',
                    }}>
                    {busy ? `⏳ ${busy}` : notice}
                </div>
            )}

            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button style={chip(view === 'saved')} onClick={() => setView('saved')}>★ Saved · {savedCount}</button>
                <button style={chip(view === 'all')} onClick={() => setView('all')}>All · {results.length}</button>
                <button style={{ ...S.btn, marginLeft: 'auto' }} disabled={!!busy || savedCount === 0} onClick={exportTrainingSet}
                    title="Saved images + their exact prompts, params and concepts — ready for LoRA fine-tuning">
                    🎓 Export training set ({savedCount})
                </button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
                {shown.map(r => (
                    <div key={r.id} style={{ ...S.card, padding: 0, overflow: 'hidden' }}>
                        <img src={r.image.value} alt="" onClick={() => openLightbox(r.image.value)}
                            style={{ width: '100%', display: 'block', cursor: 'zoom-in' }} />
                        <div style={{ padding: '6px 10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: 10, color: '#a1a1aa' }}>
                                {new Date(r.createdAt).toLocaleDateString()} · {r.params.ratio}{r.params.size ? ` · ${r.params.size}` : ''}
                            </span>
                            <span style={{ display: 'flex', gap: 6 }}>
                                <button style={{ ...S.btnGhost, color: r.adopted ? '#d97706' : undefined }}
                                    title={r.adopted ? 'Unsave' : 'Save to the curated set'} onClick={() => toggleSave(r)}>
                                    {r.adopted ? '★' : '☆'}
                                </button>
                                <button style={S.btnGhost} onClick={() => download(r)}>⬇</button>
                                {r.adopted && <button style={{ ...S.btnGhost, color: '#b91c1c' }} onClick={() => remove(r)}>✕</button>}
                            </span>
                        </div>
                    </div>
                ))}
                {shown.length === 0 && (
                    <p style={{ fontSize: 12, color: '#a1a1aa' }}>
                        {view === 'saved' ? 'Nothing saved yet — hit ★ Save on results in Studio or Quick.' : 'No generations yet.'}
                    </p>
                )}
            </div>
        </div>
    );
}
