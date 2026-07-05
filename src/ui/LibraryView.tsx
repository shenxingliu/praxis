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
    synthesizeReference, keepFusion, proposeCombos,
} from '../engine/fusion';
import { S, chip } from './styles';

/**
 * LIBRARY — collect → classify → decompose.
 * Upload references; each is auto-decomposed into reusable elements.
 * Elements are the studio's recombination vocabulary.
 */

const TYPE_LABEL: Record<ElementType, string> = {
    visual: '👁 Visual', feeling: '💫 Feeling', communication: '🗣 Communication',
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
    const [busy, setBusy] = useState('');
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

    const upload = async (files: FileList | null) => {
        if (!files) return;
        for (const f of Array.from(files)) {
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
        refresh();
    };

    const runPending = async () => {
        const { refs: n, elements: m } = await decomposeAllPending(setBusy);
        setBusy(n === 0 ? 'Nothing pending.' : `Decomposed ${n} refs → ${m} elements.`);
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

    const fuse = async () => {
        const picked = elements.filter(e => selected.has(e.id));
        setBusy('Fusing…');
        setDraft(null);
        try {
            setDraft(await synthesizeReference(picked, level, fusionNote.trim() || undefined, setBusy));
            setBusy('');
        } catch (err: any) { setBusy(`❌ ${err?.message || err}`); }
    };

    const autoFuse = async () => {
        setBusy('Curator picking combinations…');
        setCombos([]);
        setDraft(null);
        try {
            setCombos(await proposeCombos(fusionNote.trim() || undefined));
            setBusy('');
        } catch (err: any) { setBusy(`❌ ${err?.message || err}`); }
    };

    /** Full auto: curator picks combos → one is chosen at random (weighted
     *  toward tension-forward) → synthesized. Only Keep/Discard remains. */
    const fullAuto = async () => {
        setBusy('Curator picking…');
        setCombos([]);
        setDraft(null);
        try {
            const cs = await proposeCombos(fusionNote.trim() || undefined);
            if (cs.length === 0) throw new Error('No viable combos.');
            const pick = cs[Math.min(cs.length - 1, Math.floor(Math.random() * cs.length))];
            setCombos(cs);
            await runCombo(pick);
        } catch (err: any) { setBusy(`❌ ${err?.message || err}`); }
    };

    const runCombo = async (c: FusionCombo) => {
        const picked = elements.filter(e => c.elementIds.includes(e.id));
        setSelected(new Set(c.elementIds));
        setLevel(c.level);
        setBusy(`Fusing “${c.title}”…`);
        setDraft(null);
        try {
            const note = [fusionNote.trim(), c.provocation].filter(Boolean).join(' · ');
            setDraft(await synthesizeReference(picked, c.level, note || undefined, setBusy));
            setBusy('');
        } catch (err: any) { setBusy(`❌ ${err?.message || err}`); }
    };

    const curate = async () => {
        setBusy('Curating library…');
        try {
            const r = await curateLibrary();
            setBusy(`🧹 Disabled ${r.disabled}, kept ${r.kept}. ${r.note}`);
            refresh();
        } catch (err: any) { setBusy(`❌ ${err?.message || err}`); }
    };

    const redo = async (r: Reference) => {
        setBusy(`Re-decomposing ${r.name}…`);
        try {
            const els = await redecomposeReference(r);
            setBusy(`✓ ${r.name} → ${els.length} fresh concepts`);
            refresh();
        } catch (err: any) { setBusy(`❌ ${err?.message || err}`); }
    };

    const rebuild = async () => {
        if (!window.confirm('Rebuild the whole concept library?\n\nAll current concepts are wiped and every reference is re-decomposed with dedupe + auto-curation. No selection needed.')) return;
        try {
            const r = await rebuildLibrary(setBusy);
            setBusy(`♻️ Rebuilt: ${r.refs} refs → ${r.elements} concepts${r.curated > 0 ? ` (auto-curated ${r.curated})` : ''}`);
            setSelected(new Set());
            refresh();
        } catch (err: any) { setBusy(`❌ ${err?.message || err}`); }
    };

    const keep = async () => {
        if (!draft) return;
        setBusy('Saving…');
        try {
            const name = window.prompt('Name this reference:', `Fusion gen${draft.generation}`) ?? '';
            await keepFusion(draft, name, setBusy);
            setDraft(null);
            setSelected(new Set());
            setBusy('✓ In the library — already decomposed into new concepts');
            refresh();
        } catch (err: any) { setBusy(`❌ ${err?.message || err}`); }
    };

    const isRunning = !!busy && !/^[✓❌🧹♻️]/.test(busy);

    return (
        <div style={{ maxWidth: 980, margin: '0 auto', padding: '22px 28px', display: 'flex', flexDirection: 'column', gap: 18 }}>
            {busy && (
                <div className={isRunning ? 'praxis-running' : undefined}
                    style={{
                        position: 'sticky', top: 8, zIndex: 10, fontSize: 12.5, fontWeight: 600,
                        padding: '8px 14px', borderRadius: 10,
                        background: busy.startsWith('❌') ? '#fef2f2' : isRunning ? '#fef3c7' : '#ecfdf5',
                        color: busy.startsWith('❌') ? '#b91c1c' : isRunning ? '#92400e' : '#047857',
                        border: '1px solid rgba(0,0,0,0.06)',
                    }}>
                    {isRunning ? `⏳ ${busy}` : busy}
                </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={S.label}>REFERENCES · {refs.length}</span>
                <button style={S.btn} onClick={() => fileRef.current?.click()}>＋ Upload references</button>
                <button style={S.btnGhost} onClick={runPending}>Decompose pending</button>
                <input ref={fileRef} type="file" multiple accept="image/*" style={{ display: 'none' }} onChange={e => upload(e.target.files)} />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 10 }}>
                {refs.map(r => (
                    <div key={r.id} style={{ ...S.card, padding: 0, overflow: 'hidden', position: 'relative' }}>
                        <img src={r.image.value} alt={r.name} style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', display: 'block' }} />
                        <div style={{ padding: '5px 8px', fontSize: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
                            <span>{r.source === 'synthesized' ? `🧬g${r.generation ?? 1}` : r.source === 'promoted' ? '⭐' : r.decomposed ? '🧩' : '·'}</span>
                        </div>
                        <button onClick={() => removeRef(r)} title="Delete"
                            style={{ position: 'absolute', top: 4, right: 4, border: 'none', borderRadius: 6, background: 'rgba(0,0,0,0.45)', color: '#fff', fontSize: 10, cursor: 'pointer', padding: '2px 6px' }}>✕</button>
                        <button onClick={() => redo(r)} title="Re-decompose — wipe this reference's concepts and extract fresh"
                            style={{ position: 'absolute', top: 4, left: 4, border: 'none', borderRadius: 6, background: 'rgba(0,0,0,0.45)', color: '#fff', fontSize: 10, cursor: 'pointer', padding: '2px 6px' }}>🧩</button>
                    </div>
                ))}
                {refs.length === 0 && <p style={{ fontSize: 12, color: '#a1a1aa' }}>No references yet. Upload aesthetic references — each is decomposed into reusable elements.</p>}
            </div>

            {/* Fusion Lab */}
            <div style={{ ...S.card, display: 'flex', flexDirection: 'column', gap: 8, border: '1.5px dashed #a1a1aa' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={S.label}>🧪 FUSION LAB · {selected.size} concept{selected.size === 1 ? '' : 's'} selected</span>
                    <select value={level} onChange={e => setLevel(e.target.value as TransferLevel)} style={{ ...S.input, width: 250 }}>
                        {(Object.keys(LEVEL_LABEL) as TransferLevel[]).map(l => <option key={l} value={l}>{LEVEL_LABEL[l]}</option>)}
                    </select>
                    <input style={{ ...S.input, flex: 1, minWidth: 160 }} placeholder="Optional art direction…" value={fusionNote} onChange={e => setFusionNote(e.target.value)} />
                    <button style={{ ...S.btn, opacity: selected.size >= 2 ? 1 : 0.4 }} disabled={selected.size < 2 || !!busy} onClick={fuse}>
                        Fuse → new reference
                    </button>
                    <button style={S.btn} disabled={!!busy} onClick={autoFuse} title="The curator picks 3 combinations for you — scored for productive tension, not similarity">
                        🤖 Auto-fuse
                    </button>
                    <button style={S.btn} disabled={!!busy} onClick={fullAuto} title="Zero decisions: curator picks the combo AND fuses it — you only Keep or Discard">
                        🎲 Full auto
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
                                {c.provocation && <div style={{ fontSize: 10.5, color: '#92400e' }}>⚡ {c.provocation}</div>}
                                <button style={{ ...S.btn, marginTop: 'auto' }} disabled={!!busy} onClick={() => runCombo(c)}>Fuse this</button>
                            </div>
                        ))}
                    </div>
                )}
                <div style={{ fontSize: 10, color: '#a1a1aa' }}>
                    Select 2-4 concept cards below (☐), pick the transfer level — L1 imitates, L3/L4 creates — and breed a brand-new pure aesthetic reference (no product, flash-model cost).
                </div>
                {draft && (
                    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                        <img src={draft.image} alt="fusion draft" style={{ width: 260, borderRadius: 10 }} />
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12 }}>
                            <span style={{ fontWeight: 700 }}>Generation {draft.generation}</span>
                            {draft.redline && (
                                <span style={{ color: draft.redline.pass ? '#059669' : '#b91c1c' }}>
                                    {draft.redline.pass ? '✓ passes brand red-lines' : '⚠ red-line risk'} — {draft.redline.note}
                                </span>
                            )}
                            <span style={{ display: 'flex', gap: 8 }}>
                                <button style={S.btn} disabled={!!busy} onClick={keep}>Keep — into the library</button>
                                <button style={S.btnGhost} disabled={!!busy} onClick={() => setDraft(null)}>Discard</button>
                                <button style={S.btnGhost} disabled={!!busy} onClick={fuse}>Try again</button>
                            </span>
                        </div>
                    </div>
                )}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span style={S.label}>ELEMENTS · {elements.length}</span>
                <button style={S.btnGhost} disabled={!!busy} onClick={curate} title="Merge near-duplicates, disable generic filler — nothing is deleted">
                    🧹 Curate
                </button>
                <button style={S.btnGhost} disabled={!!busy} onClick={rebuild} title="Wipe all concepts and re-decompose every reference — lean by construction, auto-curated, zero picking">
                    ♻️ Rebuild library
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
                            {src && <img src={src.image.value} alt="" style={{ width: 54, height: 54, borderRadius: 8, objectFit: 'cover', flexShrink: 0 }} />}
                            <div style={{ minWidth: 0, flex: 1 }}>
                                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.5, color: '#71717a' }}>
                                    {TYPE_LABEL[el.type]} · w{el.weight.toFixed(1)}
                                    {el.weight > 1 && <span style={{ color: '#059669' }}> ▲ rising</span>}
                                    {el.weight < 0.9 && <span style={{ color: '#b91c1c' }}> ▼ fading</span>}
                                    {!el.lastUsedAt && Date.now() - el.createdAt > 14 * 86400_000 && <span style={{ color: '#a1a1aa' }}> 😴 sleeping</span>}
                                </div>
                                <div style={{ fontSize: 12.5, fontWeight: 700, marginTop: 3 }}>{el.concept}{el.worldview && <span style={{ fontWeight: 400, color: '#a1a1aa' }}> · “{el.worldview}”</span>}</div>
                                {el.analysis && <div style={{ fontSize: 10.5, color: '#71717a', marginTop: 2, lineHeight: 1.45 }}>{el.analysis}</div>}
                                {el.principle && <div style={{ fontSize: 10.5, color: '#57534e', marginTop: 2, lineHeight: 1.45 }}>⚙ {el.principle}</div>}
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
