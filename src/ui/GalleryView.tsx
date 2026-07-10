import React, { useEffect, useState } from 'react';
import { GenerationResult } from '../domain/types';
import { storage } from '../storage/local';
import { getCurrentBrand } from '../domain/brand';
import { recordSignal } from '../learning/learning';
import { openLightbox } from './lightbox';
import { resolveToDataUrl } from '../storage/images';
import { S } from './styles';
import { SegmentedControl } from './SegmentedControl';
import { SmartImage } from './SmartImage';

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

    const [limit, setLimit] = useState(24);
    const refresh = () => storage.listResults(limit).then(setResults).catch(err => {
        setNotice(`Cloud read struggled — showing what loaded. (${err?.message?.slice(0, 80) ?? 'unknown'})`);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(() => { refresh(); }, [limit]);

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
        a.href = await resolveToDataUrl(r.image.value);
        a.download = `praxis-${new Date(r.createdAt).toISOString().slice(0, 10)}-${r.id.slice(0, 6)}.png`;
        a.click();
        if (!r.adopted) { await recordSignal(r, 'export'); refresh(); }
    };

    /** LoRA training set: saved images + their exact prompts and recipes. */
    const exportTrainingSet = async () => {
        const brand = await getCurrentBrand();
        const adopted = results.filter(r => r.adopted && !!r.image.value);
        if (adopted.length === 0) { setNotice('Nothing saved yet — save some images first.'); return; }
        setBusy(`Packing ${adopted.length} pairs…`);
        try {
            const entries = await Promise.all(adopted.map(async r => ({
                id: r.id,
                prompt: r.fullPrompt,
                image: await resolveToDataUrl(r.image.value),
                params: r.params,
                elementIds: r.elementIds ?? [],
                model: r.model,
                createdAt: r.createdAt,
            })));
            const blob = new Blob(
                [JSON.stringify({ brand: brand.id, exportedAt: Date.now(), count: entries.length, entries })],
                { type: 'application/json' }
            );
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `praxis-training-${brand.id}-${entries.length}.json`;
            a.click();
            URL.revokeObjectURL(a.href);
            setNotice(`Exported ${entries.length} image+prompt pairs`);
        } catch (err: any) { setNotice(`${err?.message || err}`); }
        setBusy('');
    };

    const remove = async (r: GenerationResult) => {
        if (!window.confirm('Delete this image permanently from the cloud?')) return;
        await recordSignal(r, 'discard'); // the learning loop hears about it first
        await storage.deleteResult(r.id);
        setNotice('Deleted');
        refresh();
    };

    return (
        <div style={{ maxWidth: 1080, margin: '0 auto', padding: '22px 28px', display: 'flex', flexDirection: 'column', gap: 14 }}>
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

            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <SegmentedControl
                    ariaLabel="Gallery view"
                    value={view}
                    onChange={setView}
                    options={[
                        { value: 'saved', label: `Saved · ${savedCount}` },
                        { value: 'all', label: `All · ${results.length}` },
                    ]}
                    minWidth={220}
                />
                <button style={{ ...S.btn, marginLeft: 'auto' }} disabled={!!busy || savedCount === 0} onClick={exportTrainingSet}
                    title="Saved images + their exact prompts, params and concepts — ready for LoRA fine-tuning">
                    Export training set ({savedCount})
                </button>
            </div>

            {/* Pinterest-style masonry: natural aspect ratios, no cropping */}
            <div style={{ columnWidth: 230, columnGap: 10 }}>
                {shown.map(r => (
                    <div key={r.id} style={{ ...S.card, padding: 0, overflow: 'hidden', breakInside: 'avoid', marginBottom: 10 }}>
                        <SmartImage src={r.image.value} alt="" onClick={() => openLightbox(r.image.value)}
                            style={{ width: '100%', display: 'block', cursor: 'zoom-in' }} />
                        <div style={{ padding: '6px 10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: 10, color: '#a1a1aa' }}>
                                {new Date(r.createdAt).toLocaleDateString()} · {r.params.ratio}{r.params.size ? ` · ${r.params.size}` : ''}
                            </span>
                            <span style={{ display: 'flex', gap: 6 }}>
                                <button style={{ ...S.btnGhost, color: r.adopted ? '#d97706' : undefined }}
                                    title={r.adopted ? 'Unsave — drop from the curated set' : 'Save to the curated set'} onClick={() => toggleSave(r)}>
                                    {r.adopted ? '★' : '☆'}
                                </button>
                                <button style={S.btnGhost} title="Download the file" onClick={() => download(r)}>↓</button>
                                {r.adopted && <button style={{ ...S.btnGhost, color: '#18181b' }} onClick={() => remove(r)}>✕</button>}
                            </span>
                        </div>
                    </div>
                ))}
                {shown.length === 0 && (
                    <p style={{ fontSize: 12, color: '#a1a1aa' }}>
                        {view === 'saved' ? 'Nothing saved yet — hit Save on results in Studio or Quick.' : 'No generations yet.'}
                    </p>
                )}
            </div>
            {results.length >= limit && (
                <button style={{ ...S.btnGhost, margin: '12px auto 0', display: 'block' }} onClick={() => setLimit(l => l + 24)}>
                    Load more
                </button>
            )}
        </div>
    );
}
