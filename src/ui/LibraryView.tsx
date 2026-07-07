import React, { useEffect, useRef, useState } from 'react';
import { Element, ElementType, Reference } from '../domain/types';
import { storage } from '../storage/local';
import { getCurrentBrandId } from '../domain/brand';
import {
    decomposeReference, decomposeAllPending, curateLibrary,
    redecomposeReference, rebuildLibrary,
} from '../engine/decompose';
import {
    TransferLevel, LEVEL_LABEL, FusionDraft, FusionCombo,
    synthesizeReference, keepFusion, proposeCombos, recordFusionVerdict,
} from '../engine/fusion';
import { openLightbox } from './lightbox';
import { DropZone, imageFiles } from './dropzone';
import { S, chip } from './styles';

/**
 * LIBRARY — collect → classify → decompose.
 * Upload references; each is auto-decomposed into reusable elements.
 * Elements are the studio's recombination vocabulary.
 */

const TYPE_LABEL: Record<ElementType, string> = {
    visual: 'Visual', feeling: 'Feeling', communication: 'Communication',
};

const fileToDataUrl = (f: File): Promise<string> =>
    new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result));
        r.onerror = rej;
        r.readAsDataURL(f);
    });

export default function LibraryView() {
    const [refs, setRefs] = useState<Reference[]>([]);
    const [elements, setElements] = useState<Element[]>([]);
    const [filter, setFilter] = useState<ElementType | 'all'>('all');
    /** busy = something is RUNNING (gates buttons). Cleared when settled. */
    const [busy, setBusy] = useState('');
    /** notice = outcome message. Never gates anything. */
    const [notice, setNotice] = useState('');
    const fileRef = useRef<HTMLInputElement>(null);

    // Fusion Lab state
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [level, setLevel] = useState<TransferLevel>('concept');
    const [fusionNote, setFusionNote] = useState('');
    const [draft, setDraft] = useState<FusionDraft | null>(null);
    const [combos, setCombos] = useState<FusionCombo[]>([]);

    const refresh = () => {
        storage.listReferences().then(setRefs);
        storage.listElements().then(setElements);
    };
    useEffect(refresh, []);

    const upload = async (input: FileList | File[] | null) => {
        const files = imageFiles(input);
        if (files.length === 0) return;
        for (const f of files) {
            setBusy(`Uploading ${f.name}…`);
            const ref: Reference = {
                id: crypto.randomUUID(),
                brandId: getCurrentBrandId(),
                kind: 'style',
                name: f.name.replace(/\.[^.]+$/, ''),
                image: { kind: 'data', value: await fileToDataUrl(f) },
                tags: [],
                source: 'upload',
                weight: 1,
                createdAt: Date.now(),
            };
            await storage.upsertReference(ref);
            setBusy(`Decomposing ${f.name}…`);
            try { await decomposeReference(ref); } catch (err: any) {
                console.warn('decompose failed:', err);
            }
        }
        setBusy('');
        setNotice('Uploaded & decomposed');
        refresh();
    };

    const runPending = async () => {
        setBusy('Decomposing…');
        try {
            const { refs: n, elements: m } = await decomposeAllPending(setBusy);
            setNotice(n === 0 ? 'Nothing pending.' : `Decomposed ${n} refs → ${m} elements.`);
        } catch (err: any) { setNotice(`${err?.message || err}`); }
        setBusy('');
        refresh();
    };

    const toggleElement = async (el: Element) => {
        await storage.upsertElement({ ...el, enabled: !el.enabled });
        refresh();
    };
    const removeElement = async (el: Element) => {
        await storage.deleteElement(el.id);
        refresh();
    };
    const removeRef = async (r: Reference) => {
        if (!window.confirm(`Delete reference "${r.name}" (its elements stay)?`)) return;
        await storage.deleteReference(r.id);
        refresh();
    };

    const refById = (id: string) => refs.find(r => r.id === id);
    const shown = filter === 'all' ? elements : elements.filter(e => e.type === filter);

    const toggleSelect = (id: string) =>
        setSelected(prev => {
            const n = new Set(prev);
            n.has(id) ? n.delete(id) : n.add(id);
            return n;
        });

    /** Run an async action: busy while running, outcome goes to notice,
     *  busy ALWAYS cleared — buttons can never stay locked. */
    const run = async (label: string, fn: () => Promise<string | void>) => {
        setBusy(label);
        setNotice('');
        try {
            const msg = await fn();
            if (msg) setNotice(msg);
        } catch (err: any) {
            setNotice(`${err?.message || err}`);
        } finally {
            setBusy('');
            refresh();
        }
    };

    const fuse = () => run('Fusing…', async () => {
        const picked = elements.filter(e => selected.has(e.id));
        setDraft(null);
        setDraft(await synthesizeReference(picked, level, fusionNote.trim() || undefined, setBusy));
    });

    const autoFuse = () => run('Curator picking combinations…', async () => {
        setCombos([]);
        setDraft(null);
        setCombos(await proposeCombos(fusionNote.trim() || undefined));
    });

    const doCombo = async (c: FusionCombo) => {
        const picked = elements.filter(e => c.elementIds.includes(e.id));
        setSelected(new Set(c.elementIds));
        setLevel(c.level);
        setDraft(null);
        setBusy(`Fusing “${c.title}”…`);
        const note = [fusionNote.trim(), c.provocation].filter(Boolean).join(' · ');
        setDraft(await synthesizeReference(picked, c.level, note || undefined, setBusy));
    };

    const runCombo = (c: FusionCombo) => run(`Fusing “${c.title}”…`, () => doCombo(c));

    /** Full auto: curator picks combos → one is chosen at random → fused.
     *  Only Keep/Discard remains. */
    const fullAuto = () => run('Curator picking…', async () => {
        setCombos([]);
        setDraft(null);
        const cs = await proposeCombos(fusionNote.trim() || undefined);
        if (cs.length === 0) throw new Error('No viable combos.');
        setCombos(cs);
        await doCombo(cs[Math.min(cs.length - 1, Math.floor(Math.random() * cs.length))]);
    });

    const curate = () => run('Curating library…', async () => {
        const r = await curateLibrary();
        return `Disabled ${r.disabled}, kept ${r.kept}. ${r.note}`;
    });

    const redo = (r: Reference) => run(`Re-decomposing ${r.name}…`, async () => {
        const els = await redecomposeReference(r);
        return `${r.name} → ${els.length} fresh concepts`;
    });

    const rebuild = () => {
        if (!window.confirm('Rebuild the whole concept library?\n\nAll current concepts are wiped and every reference is re-decomposed with dedupe + auto-curation. No selection needed.')) return;
        run('Rebuilding…', async () => {
            const r = await rebuildLibrary(setBusy);
            setSelected(new Set());
            return `Rebuilt: ${r.refs} refs → ${r.elements} concepts${r.curated > 0 ? ` (auto-curated ${r.curated})` : ''}`;
        });
    };

    const verdictElements = (d: FusionDraft) => elements.filter(e => d.elementIds.includes(e.id));

    const keep = () => {
        if (!draft) return;
        const name = window.prompt('Name this reference:', `Fusion gen${draft.generation}`) ?? '';
        run('Saving…', async () => {
            await keepFusion(draft, name, setBusy);
            recordFusionVerdict(draft, verdictElements(draft), draft.level, 'keep').catch(() => {});
            setDraft(null);
            setSelected(new Set());
            return 'In the library — decomposed into new concepts · verdict remembered';
        });
    };

    const discard = () => {
        if (!draft) return;
        recordFusionVerdict(draft, verdictElements(draft), draft.level, 'discard').catch(() => {});
        setDraft(null);
        setNotice('Discarded · verdict remembered — the curator won’t repeat this combo');
        refresh();
    };

    return (
        <div style={{ maxWidth: 980, margin: '0 auto', padding: '22px 28px', display: 'flex', flexDirection: 'column', gap: 18 }}>
            {(busy || notice) && (
                <div className={busy ? 'praxis-running' : undefined}
                    style={{
                        position: 'sticky', top: 8, zIndex: 10, fontSize: 12.5, fontWeight: 600,
                        padding: '8px 14px', borderRadius: 10,
                        background: busy ? '#fef3c7' : notice.startsWith('Error') ? '#fef2f2' : '#ecfdf5',
                        color: busy ? '#92400e' : notice.startsWith('Error') ? '#b91c1c' : '#047857',
                        border: '1px solid rgba(0,0,0,0.06)',
                    }}>
                    {busy ? `${busy}` : notice}
                </div>
            )}
            <DropZone onFiles={upload} hint="Drop references — auto-decomposed" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={S.label}>REFERENCES · {refs.length}</span>
                <button style={S.btn} onClick={() => fileRef.current?.click()}>＋ Upload references</button>
                <button style={S.btnGhost} onClick={runPending}>Decompose pending</button>
                <span style={{ fontSize: 10, color: '#a1a1aa' }}>or drag & drop images anywhere in this section</span>
                <input ref={fileRef} type="file" multiple accept="image/*" style={{ display: 'none' }} onChange={e => { upload(e.target.files); e.currentTarget.value = ''; }} />
            </div>

            {/* Pinterest-style masonry: natural aspect ratios, no cropping */}
            <div style={{ columnWidth: 150, columnGap: 10 }}>
                {refs.map(r => (
                    <div key={r.id} style={{ ...S.card, padding: 0, overflow: 'hidden', position: 'relative', breakInside: 'avoid', marginBottom: 10 }}>
                        <img src={r.image.value} alt={r.name} onClick={() => openLightbox(r.image.value)}
                            style={{ width: '100%', display: 'block', cursor: 'zoom-in' }} />
                        <div style={{ padding: '5px 8px', fontSize: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
                            <span>{r.source === 'synthesized' ? `g${r.generation ?? 1}` : r.source === 'promoted' ? '*' : r.decomposed ? 'd' : '·'}</span>
                        </div>
                        <button onClick={() => removeRef(r)} title="Delete"
                            style={{ position: 'absolute', top: 4, right: 4, border: 'none', borderRadius: 6, background: 'rgba(0,0,0,0.45)', color: '#fff', fontSize: 10, cursor: 'pointer', padding: '2px 6px' }}>✕</button>
                        <button onClick={() => redo(r)} title="Re-decompose — wipe this reference's concepts and extract fresh"
                            style={{ position: 'absolute', top: 4, left: 4, border: 'none', borderRadius: 6, background: 'rgba(0,0,0,0.45)', color: '#fff', fontSize: 10, cursor: 'pointer', padding: '2px 6px' }}>Decomp</button>
                    </div>
                ))}
                {refs.length === 0 && <p style={{ fontSize: 12, color: '#a1a1aa' }}>No references yet. Upload or drag & drop aesthetic references — each is decomposed into reusable elements.</p>}
            </div>
            </DropZone>

            {/* Fusion Lab */}
            <div style={{ ...S.card, display: 'flex', flexDirection: 'column', gap: 8, border: '1.5px dashed #a1a1aa' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={S.label}>FUSION LAB · {selected.size} concept{selected.size === 1 ? '' : 's'} selected</span>
                    <select value={level} onChange={e => setLevel(e.target.value as TransferLevel)} style={{ ...S.input, width: 250 }}>
                        {(Object.keys(LEVEL_LABEL) as TransferLevel[]).map(l => <option key={l} value={l}>{LEVEL_LABEL[l]}</option>)}
                    </select>
                    <input style={{ ...S.input, flex: 1, minWidth: 160 }} placeholder="Optional art direction…" value={fusionNote} onChange={e => setFusionNote(e.target.value)} />
                    <button style={{ ...S.btn, opacity: selected.size >= 2 ? 1 : 0.4 }} disabled={selected.size < 2 || !!busy} onClick={fuse}>
                        Fuse → new reference
                    </button>
                    <button style={S.btn} disabled={!!busy} onClick={autoFuse} title="The curator picks 3 combinations for you — scored for productive tension, not similarity">
                        Auto-fuse
                    </button>
                    <button style={S.btn} disabled={!!busy} onClick={fullAuto} title="Zero decisions: curator picks the combo AND fuses it — you only Keep or Discard">
                        Full auto
                    </button>
                </div>
                {combos.length > 0 && !draft && (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 8 }}>
                        {combos.map((c, i) => (
                            <div key={i} style={{ ...S.card, display: 'flex', flexDirection: 'column', gap: 6, background: '#fafafa' }}>
                                <div style={{ fontSize: 12.5, fontWeight: 700 }}>{c.title}</div>
                                <div style={{ fontSize: 10, color: '#71717a' }}>{LEVEL_LABEL[c.level]}</div>
                                <div style={{ fontSize: 11, lineHeight: 1.5 }}>{c.why}</div>
                                <div style={{ fontSize: 10.5, color: '#57534e' }}>
                                    {c.elementIds.map(id => elements.find(e => e.id === id)?.concept).filter(Boolean).map(s => `“${s}”`).join(' × ')}
                                </div>
                                {c.provocation && <div style={{ fontSize: 10.5, color: '#92400e' }}>{c.provocation}</div>}
                                <button style={{ ...S.btn, marginTop: 'auto' }} disabled={!!busy} onClick={() => runCombo(c)}>Fuse this</button>
                            </div>
                        ))}
                    </div>
                )}
                <div style={{ fontSize: 10, color: '#a1a1aa' }}>
                    Select 2-4 concept cards below , pick the transfer level — L1 imitates, L3/L4 creates — and breed a brand-new pure aesthetic reference (no product, flash-model cost).
                </div>
                {draft && (
                    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                        <img src={draft.image} alt="fusion draft" onClick={() => openLightbox(draft.image)}
                            style={{ width: 260, borderRadius: 10, cursor: 'zoom-in' }} />
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12 }}>
                            <span style={{ fontWeight: 700 }}>Generation {draft.generation}</span>
                            {draft.redline && (
                                <span style={{ color: draft.redline.pass ? '#059669' : '#b91c1c' }}>
                                    {draft.redline.pass ? 'passes brand red-lines' : 'red-line risk'} — {draft.redline.note}
                                </span>
                            )}
                            <span style={{ display: 'flex', gap: 8 }}>
                                <button style={S.btn} disabled={!!busy} onClick={keep}>Keep — into the library</button>
                                <button style={S.btnGhost} disabled={!!busy} onClick={discard}>Discard</button>
                                <button style={S.btnGhost} disabled={!!busy} onClick={() => { discard(); fuse(); }}>Try again</button>
                                <button style={S.btnGhost} title="Download" onClick={() => {
                                    const a = document.createElement('a');
                                    a.href = draft.image;
                                    a.download = `praxis-fusion-gen${draft.generation}.png`;
                                    a.click();
                                }}>Save</button>
                            </span>
                        </div>
                    </div>
                )}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span style={S.label}>ELEMENTS · {elements.length}</span>
                <button style={S.btnGhost} disabled={!!busy} onClick={curate} title="Merge near-duplicates, disable generic filler — nothing is deleted">
                    Curate
                </button>
                <button style={S.btnGhost} disabled={!!busy} onClick={rebuild} title="Wipe all concepts and re-decompose every reference — lean by construction, auto-curated, zero picking">
                    Rebuild library
                </button>
                <button style={chip(filter === 'all')} onClick={() => setFilter('all')}>All</button>
                {(Object.keys(TYPE_LABEL) as ElementType[]).map(t => (
                    <button key={t} style={chip(filter === t)} onClick={() => setFilter(t)}>
                        {TYPE_LABEL[t]} {elements.filter(e => e.type === t).length || ''}
                    </button>
                ))}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
                {shown.map(el => {
                    const src = refById(el.sourceRefId);
                    const on = selected.has(el.id);
                    return (
                        <div key={el.id} style={{ ...S.card, display: 'flex', gap: 10, opacity: el.enabled ? 1 : 0.45, border: on ? '1.5px solid #18181b' : undefined }}>
                            <input type="checkbox" checked={on} onChange={() => toggleSelect(el.id)} style={{ alignSelf: 'flex-start', marginTop: 4, cursor: 'pointer' }} title="Select for Fusion Lab" />
                            {src && <img src={src.image.value} alt="" onClick={() => openLightbox(src.image.value)}
                                style={{ width: 54, height: 54, borderRadius: 8, objectFit: 'cover', flexShrink: 0, cursor: 'zoom-in' }} />}
                            <div style={{ minWidth: 0, flex: 1 }}>
                                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.5, color: '#71717a' }}>
                                    {TYPE_LABEL[el.type]} · w{el.weight.toFixed(1)}
                                    {el.weight > 1 && <span style={{ color: '#059669' }}> ▲ rising</span>}
                                    {el.weight < 0.9 && <span style={{ color: '#b91c1c' }}> ▼ fading</span>}
                                    {!el.lastUsedAt && Date.now() - el.createdAt > 14 * 86400_000 && <span style={{ color: '#a1a1aa' }}> sleeping</span>}
                                </div>
                                <div style={{ fontSize: 12.5, fontWeight: 700, marginTop: 3 }}>{el.concept}{el.worldview && <span style={{ fontWeight: 400, color: '#a1a1aa' }}> · “{el.worldview}”</span>}</div>
                                {el.analysis && <div style={{ fontSize: 10.5, color: '#71717a', marginTop: 2, lineHeight: 1.45 }}>{el.analysis}</div>}
                                {el.principle && <div style={{ fontSize: 10.5, color: '#57534e', marginTop: 2, lineHeight: 1.45 }}>{el.principle}</div>}
                                <div style={{ fontSize: 11, marginTop: 3, lineHeight: 1.45 }}>↳ {el.description}</div>
                                <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                                    <button style={S.btnGhost} onClick={() => toggleElement(el)}>{el.enabled ? 'Disable' : 'Enable'}</button>
                                    <button style={S.btnGhost} onClick={() => removeElement(el)}>Delete</button>
                                </div>
                            </div>
                        </div>
                    );
                })}
                {shown.length === 0 && <p style={{ fontSize: 12, color: '#a1a1aa' }}>No elements{filter !== 'all' ? ' of this type' : ''} yet.</p>}
            </div>
        </div>
    );
}
