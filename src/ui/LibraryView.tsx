import React, { useEffect, useRef, useState } from 'react';
import { Reference } from '../domain/types';
import { storage } from '../storage/local';
import { getCurrentBrandId } from '../domain/brand';
import {
    TransferLevel, LEVEL_LABEL, FusionDraft, FusionCombo,
    synthesizeReference, keepFusion, proposeCombos, recordFusionVerdict,
} from '../engine/fusion';
import { openLightbox } from './lightbox';
import { DropZone, imageFiles } from './dropzone';
import { Select } from './controls';
import { S } from './styles';

/**
 * INSPIRATION — a pool of raw reference images, fused directly.
 *
 * No decomposition step, no concept library: uploading costs zero API
 * calls, and every fusion is ONE call in which the model derives each
 * image's strongest transferable idea at the chosen level and fuses.
 *
 *   Fuse       — ticked 2-4 refs fuse immediately; with nothing ticked
 *                the curator studies the pool and proposes 3 combos
 *   Auto-fuse  — zero decisions: curator proposes AND fuses; you only
 *                Keep or Discard
 */

const fileToDataUrl = (f: File): Promise<string> =>
    new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result));
        r.onerror = rej;
        r.readAsDataURL(f);
    });

export default function LibraryView() {
    const [refs, setRefs] = useState<Reference[]>([]);
    /** busy = something is RUNNING (gates buttons). Cleared when settled. */
    const [busy, setBusy] = useState('');
    /** notice = outcome message. Never gates anything. */
    const [notice, setNotice] = useState('');
    const fileRef = useRef<HTMLInputElement>(null);

    // Fusion Lab state
    const [selectedRefs, setSelectedRefs] = useState<Set<string>>(new Set());
    const [level, setLevel] = useState<TransferLevel>('concept');
    const [fusionNote, setFusionNote] = useState('');
    const [draft, setDraft] = useState<FusionDraft | null>(null);
    const [combos, setCombos] = useState<FusionCombo[]>([]);

    const refresh = () => {
        storage.listReferences().then(setRefs);
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
        }
        setBusy('');
        setNotice(`Uploaded ${files.length} reference${files.length === 1 ? '' : 's'} — tick a few and Fuse.`);
        refresh();
    };

    const removeRef = async (r: Reference) => {
        if (!window.confirm(`Delete reference "${r.name}"?`)) return;
        await storage.deleteReference(r.id);
        setSelectedRefs(prev => { const n = new Set(prev); n.delete(r.id); return n; });
        refresh();
    };

    const toggleSelectRef = (id: string) =>
        setSelectedRefs(prev => {
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

    /** Fuse: ticked 2+ refs fuse directly; otherwise the curator proposes. */
    const fuse = () => {
        const picked = refs.filter(r => selectedRefs.has(r.id));
        if (picked.length >= 2) {
            run('Fusing…', async () => {
                setDraft(null);
                setCombos([]);
                setDraft(await synthesizeReference([], level, fusionNote.trim() || undefined, setBusy, picked));
            });
        } else {
            run('Curator studying the pool…', async () => {
                setCombos([]);
                setDraft(null);
                setCombos(await proposeCombos(fusionNote.trim() || undefined));
            });
        }
    };

    const doCombo = async (c: FusionCombo) => {
        const picked = refs.filter(r => c.refIds.includes(r.id));
        setSelectedRefs(new Set(c.refIds));
        setLevel(c.level);
        setDraft(null);
        setBusy(`Fusing “${c.title}”…`);
        const note = [fusionNote.trim(), c.provocation].filter(Boolean).join(' · ');
        setDraft(await synthesizeReference([], c.level, note || undefined, setBusy, picked));
    };

    const runCombo = (c: FusionCombo) => run(`Fusing “${c.title}”…`, () => doCombo(c));

    /** Auto-fuse: curator proposes AND fuses — only Keep/Discard remains. */
    const autoFuse = () => run('Curator picking…', async () => {
        setCombos([]);
        setDraft(null);
        const cs = await proposeCombos(fusionNote.trim() || undefined);
        if (cs.length === 0) throw new Error('No viable combos.');
        setCombos(cs);
        await doCombo(cs[Math.min(cs.length - 1, Math.floor(Math.random() * cs.length))]);
    });

    const draftRefNames = (d: FusionDraft) =>
        d.sourceRefIds.map(id => refs.find(r => r.id === id)?.name).filter((n): n is string => !!n);

    const keep = () => {
        if (!draft) return;
        const input = window.prompt('Name this reference:', `Fusion gen${draft.generation}`);
        if (input === null) return; // cancelled
        const name = input.trim() || `Fusion gen${draft.generation}`;
        run('Saving…', async () => {
            await keepFusion(draft, name, setBusy);
            recordFusionVerdict(draft, [], draft.level, 'keep', draftRefNames(draft)).catch(() => {});
            setDraft(null);
            setCombos([]);
            setSelectedRefs(new Set());
            return 'In the library · verdict remembered — it can be fused again like any reference';
        });
    };

    const discard = () => {
        if (!draft) return;
        recordFusionVerdict(draft, [], draft.level, 'discard', draftRefNames(draft)).catch(() => {});
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
                        background: busy ? '#f4f4f5' : notice.startsWith('Error') ? '#f4f4f5' : '#f7f7f8',
                        color: '#18181b',
                        border: '1px solid rgba(0,0,0,0.06)',
                    }}>
                    {busy ? `${busy}` : notice}
                </div>
            )}
            <DropZone onFiles={upload} hint="Drop references — zero cost, fuse whenever you like" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={S.label}>REFERENCES · {refs.length}</span>
                <button style={S.btn} onClick={() => fileRef.current?.click()}>＋ Upload references</button>
                <span style={{ fontSize: 10, color: '#a1a1aa' }}>or drag & drop images anywhere in this section</span>
                <input ref={fileRef} type="file" multiple accept="image/*" style={{ display: 'none' }} onChange={e => { upload(e.target.files); e.currentTarget.value = ''; }} />
            </div>

            {/* Fusion Lab */}
            <div style={{ ...S.card, display: 'flex', flexDirection: 'column', gap: 8, border: '1.5px dashed #a1a1aa' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={S.label}>FUSION LAB · {selectedRefs.size} selected</span>
                    <Select value={level} onChange={e => setLevel(e.target.value as TransferLevel)} style={{ ...S.input, width: 250 }}>
                        {(Object.keys(LEVEL_LABEL) as TransferLevel[]).map(l => <option key={l} value={l}>{LEVEL_LABEL[l]}</option>)}
                    </Select>
                    <input style={{ ...S.input, flex: 1, minWidth: 160 }} placeholder="Optional art direction…" value={fusionNote} onChange={e => setFusionNote(e.target.value)} />
                    <button style={S.btn} disabled={!!busy || refs.length < 2} onClick={fuse}
                        title="Ticked 2-4 references fuse immediately; with nothing ticked the curator studies the pool and proposes 3 combos">
                        Fuse
                    </button>
                    <button style={S.btn} disabled={!!busy || refs.length < 3} onClick={autoFuse}
                        title="Zero decisions: the curator proposes the combo AND fuses it — you only Keep or Discard">
                        Auto-fuse
                    </button>
                </div>
                {combos.length > 0 && !draft && (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 8 }}>
                        {combos.map((c, i) => (
                            <div key={i} style={{ ...S.card, display: 'flex', flexDirection: 'column', gap: 6, background: '#fafafa' }}>
                                <div style={{ fontSize: 12.5, fontWeight: 700 }}>{c.title}</div>
                                <div style={{ fontSize: 10, color: '#71717a' }}>{LEVEL_LABEL[c.level]}</div>
                                <div style={{ fontSize: 11, lineHeight: 1.5 }}>{c.why}</div>
                                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                                    {c.refIds.map(id => {
                                        const r = refs.find(x => x.id === id);
                                        return r ? <img key={id} src={r.image.value} alt={r.name} title={r.name}
                                            style={{ width: 44, height: 44, borderRadius: 6, objectFit: 'cover' }} /> : null;
                                    })}
                                </div>
                                {c.provocation && <div style={{ fontSize: 10.5, color: '#92400e' }}>{c.provocation}</div>}
                                <button style={{ ...S.btn, marginTop: 'auto' }} disabled={!!busy} onClick={() => runCombo(c)}>Fuse this</button>
                            </div>
                        ))}
                    </div>
                )}
                <div style={{ fontSize: 10, color: '#a1a1aa' }}>
                    Tick 2-4 references and Fuse — ONE call derives each image’s strongest idea at the transfer level (L1 imitates, L3/L4 creates) and breeds a new pure aesthetic reference. Or press Fuse with nothing ticked and let the curator propose.
                </div>
                {draft && (
                    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                        <img src={draft.image} alt="fusion draft" onClick={() => openLightbox(draft.image)}
                            style={{ width: 260, borderRadius: 10, cursor: 'zoom-in' }} />
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12 }}>
                            <span style={{ fontWeight: 700 }}>Generation {draft.generation}</span>
                            <span style={{ fontSize: 10.5, color: '#71717a' }}>{draftRefNames(draft).map(n => `“${n}”`).join(' × ')}</span>
                            {draft.redline && (
                                <span style={{ color: draft.redline.pass ? '#3f3f46' : '#18181b' }}>
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

            {/* Pinterest-style masonry: natural aspect ratios, no cropping */}
            <div style={{ columnWidth: 150, columnGap: 10 }}>
                {refs.map(r => (
                    <div key={r.id} style={{ ...S.card, padding: 0, overflow: 'hidden', position: 'relative', breakInside: 'avoid', marginBottom: 10, border: selectedRefs.has(r.id) ? '1.5px solid #18181b' : undefined }}>
                        <img src={r.image.value} alt={r.name} onClick={() => toggleSelectRef(r.id)}
                            style={{ width: '100%', display: 'block', cursor: 'pointer' }} />
                        <div style={{ padding: '5px 8px', fontSize: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 5 }}>
                            <input type="checkbox" checked={selectedRefs.has(r.id)} onChange={() => toggleSelectRef(r.id)}
                                style={{ cursor: 'pointer', margin: 0 }} title="Select for the Fusion Lab" />
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{r.name}</span>
                            <span>{r.source === 'synthesized' ? `g${r.generation ?? 1}` : r.source === 'promoted' ? '*' : ''}</span>
                        </div>
                        <button onClick={() => removeRef(r)} title="Delete"
                            style={{ position: 'absolute', top: 4, right: 4, border: 'none', borderRadius: 6, background: 'rgba(0,0,0,0.45)', color: '#fff', fontSize: 10, cursor: 'pointer', padding: '2px 6px' }}>✕</button>
                        <button onClick={e => { e.stopPropagation(); openLightbox(r.image.value); }} title="Zoom"
                            style={{ position: 'absolute', top: 4, left: 4, border: 'none', borderRadius: 6, background: 'rgba(0,0,0,0.45)', color: '#fff', fontSize: 10, cursor: 'pointer', padding: '2px 6px' }}>⤢</button>
                    </div>
                ))}
                {refs.length === 0 && <p style={{ fontSize: 12, color: '#a1a1aa' }}>No references yet. Upload or drag & drop aesthetic references — tick a few and Fuse.</p>}
            </div>
            </DropZone>
        </div>
    );
}
