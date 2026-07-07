import React, { useEffect, useRef, useState } from 'react';
import { Asset, Element, GenerationParams, GenerationResult } from '../domain/types';
import { storage } from '../storage/local';
import { weaveGenerate, extractFacets, deriveIdea, describeAsPrompt, WeaveFacet } from '../engine/weave';
import { recordSignal } from '../learning/learning';
import { BudgetExceededError } from '../engine/engine';
import { openLightbox } from './lightbox';
import { DropZone, imageFiles } from './dropzone';
import { S, chip } from './styles';

/**
 * WEAVE — the freeform canvas (Figma-Weave inspired).
 * Drag nodes around a board; everything on it is woven into one image:
 *   🛋 product nodes (high fidelity) · 💡 concept nodes · 🖼 fusion images · 📝 note
 * Results can be pulled back onto the board for iterative fusion.
 */

type NodeKind = 'product' | 'element' | 'image' | 'note' | 'facet' | 'output';
interface WeaveEdge { id: string; from: string; to: string }
interface WeaveNode {
    id: string;
    kind: NodeKind;
    x: number;
    y: number;
    assetId?: string;
    elementId?: string;
    image?: string;     // data URL: image nodes + facet source
    text?: string;      // note nodes
    dimension?: string; // facet nodes: light | palette | …
    description?: string; // facet nodes / concept-role idea text
    /** image-node role: fusion (default) | product (source of truth) | concept */
    role?: 'fusion' | 'product' | 'concept';
}

const RATIOS: GenerationParams['ratio'][] = ['1:1', '16:9', '4:3', '3:4', '9:16'];
const SIZES: NonNullable<GenerationParams['size']>[] = ['1K', '2K', '4K'];

const fileToDataUrl = (f: File): Promise<string> =>
    new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result));
        r.onerror = rej;
        r.readAsDataURL(f);
    });

let dropCount = 0;
const nextPos = () => {
    dropCount += 1;
    return { x: 30 + (dropCount % 5) * 150, y: 30 + (Math.floor(dropCount / 5) % 4) * 130 };
};

export default function WeaveView() {
    const [assets, setAssets] = useState<Asset[]>([]);
    const [elements, setElements] = useState<Element[]>([]);
    const [nodes, setNodes] = useState<WeaveNode[]>([]);
    const [edges, setEdges] = useState<WeaveEdge[]>([]);
    const [linkFrom, setLinkFrom] = useState<string | null>(null);
    const [picker, setPicker] = useState<'product' | 'element' | null>(null);
    const [ratio, setRatio] = useState<GenerationParams['ratio']>('4:3');
    const [size, setSize] = useState<NonNullable<GenerationParams['size']>>('1K');
    const [tierSel, setTierSel] = useState<'flash' | 'pro'>('pro');
    const [busy, setBusy] = useState('');
    const [notice, setNotice] = useState('');
    const [results, setResults] = useState<GenerationResult[]>([]);
    const fileRef = useRef<HTMLInputElement>(null);
    const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);
    const boardRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        storage.listAssets().then(setAssets);
        storage.listElements().then(es => setElements(es.filter(e => e.enabled)));
    }, []);

    const add = (partial: Omit<WeaveNode, 'id' | 'x' | 'y'>) =>
        setNodes(prev => [...prev, { id: crypto.randomUUID(), ...nextPos(), ...partial }]);

    const remove = (id: string) => {
        setNodes(prev => prev.filter(nn => nn.id !== id));
        setEdges(prev => prev.filter(e => e.from !== id && e.to !== id));
        if (linkFrom === id) setLinkFrom(null);
    };

    /** Click ⚭ on node A, then ⚭ on node B → edge (click again to unlink). */
    const link = (id: string) => {
        if (!linkFrom) { setLinkFrom(id); return; }
        if (linkFrom === id) { setLinkFrom(null); return; }
        const exists = edges.find(e =>
            (e.from === linkFrom && e.to === id) || (e.from === id && e.to === linkFrom));
        if (exists) {
            setEdges(prev => prev.filter(e => e.id !== exists.id));
        } else {
            setEdges(prev => [...prev, { id: crypto.randomUUID(), from: linkFrom, to: id }]);
        }
        setLinkFrom(null);
    };

    /** Undirected connected component containing `startId`. */
    const componentOf = (startId: string): Set<string> => {
        const seen = new Set<string>([startId]);
        const queue = [startId];
        while (queue.length > 0) {
            const cur = queue.pop()!;
            for (const e of edges) {
                const other = e.from === cur ? e.to : e.to === cur ? e.from : null;
                if (other && !seen.has(other)) { seen.add(other); queue.push(other); }
            }
        }
        return seen;
    };

    const addImages = async (files: File[] | FileList | null) => {
        for (const f of imageFiles(files)) add({ kind: 'image', image: await fileToDataUrl(f), role: 'fusion' });
    };

    /** Change an image node's role; concept role derives its idea once. */
    const setRole = async (node: WeaveNode, role: 'fusion' | 'product' | 'concept') => {
        setNodes(prev => prev.map(x => x.id === node.id ? { ...x, role } : x));
        if (role === 'concept' && !node.description && node.image) {
            setBusy('Deriving the idea…');
            try {
                const idea = await deriveIdea(node.image);
                setNodes(prev => prev.map(x => x.id === node.id ? { ...x, description: idea } : x));
                setNotice('✓ Idea derived — it will be embodied, not copied.');
            } catch (err: any) { setNotice(`❌ ${err?.message || err}`); }
            setBusy('');
        }
    };

    /** Reverse-engineer a prompt from the image → editable note node. */
    const imageToPrompt = async (node: WeaveNode) => {
        if (!node.image) return;
        setBusy('Reading the image into a prompt…');
        setNotice('');
        try {
            const text = await describeAsPrompt(node.image);
            setNodes(prev => [...prev, {
                id: crypto.randomUUID(), kind: 'note' as const,
                x: Math.min(880, node.x + 140), y: node.y, text,
            }]);
            setNotice('✓ Prompt derived into a note node — edit it freely.');
        } catch (err: any) { setNotice(`❌ ${err?.message || err}`); }
        setBusy('');
    };

    /** Multi-dimensional decomposition: image node → 7 facet nodes. */
    const decomposeNode = async (node: WeaveNode) => {
        if (!node.image) return;
        setBusy('Decomposing into dimensions…');
        setNotice('');
        try {
            const facets = await extractFacets(node.image);
            facets.forEach((f, i) => setNodes(prev => [...prev, {
                id: crypto.randomUUID(),
                kind: 'facet' as const,
                x: Math.min(900, node.x + 140 + (i % 3) * 118),
                y: node.y + Math.floor(i / 3) * 96,
                image: node.image,
                dimension: f.dimension,
                description: f.description,
            }]));
            setNotice(`✓ ${facets.length} dimensions extracted — delete the ones you don't want, keep the rest for the weave.`);
        } catch (err: any) { setNotice(`❌ ${err?.message || err}`); }
        setBusy('');
    };

    // --- drag ---
    const onDown = (e: React.PointerEvent, node: WeaveNode) => {
        const rect = boardRef.current?.getBoundingClientRect();
        if (!rect) return;
        drag.current = { id: node.id, dx: e.clientX - rect.left - node.x, dy: e.clientY - rect.top - node.y };
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    };
    const onMove = (e: React.PointerEvent) => {
        const d = drag.current;
        const rect = boardRef.current?.getBoundingClientRect();
        if (!d || !rect) return;
        const x = Math.max(0, Math.min(rect.width - 130, e.clientX - rect.left - d.dx));
        const y = Math.max(0, Math.min(rect.height - 110, e.clientY - rect.top - d.dy));
        setNodes(prev => prev.map(nn => nn.id === d.id ? { ...nn, x, y } : nn));
    };
    const onUp = () => { drag.current = null; };

    /** Weave a specific set of nodes (a connected group, or the whole board). */
    const weaveNodes = async (pool: WeaveNode[], tier: 'flash' | 'pro') => {
        const boardAssets = assets.filter(a => pool.some(nn => nn.kind === 'product' && nn.assetId === a.id));
        const boardElements = elements.filter(el => pool.some(nn => nn.kind === 'element' && nn.elementId === el.id));
        const facets: WeaveFacet[] = pool
            .filter(nn => nn.kind === 'facet' && nn.image && nn.dimension && nn.description)
            .map(nn => ({ image: nn.image!, dimension: nn.dimension!, description: nn.description! }));
        const imageNodes = pool.filter(nn => nn.kind === 'image' && nn.image);
        const fusionImages = imageNodes.filter(nn => (nn.role ?? 'fusion') === 'fusion').map(nn => nn.image!);
        const adhocProductImages = imageNodes.filter(nn => nn.role === 'product').map(nn => nn.image!);
        const conceptIdeas = imageNodes
            .filter(nn => nn.role === 'concept')
            .map(nn => ({ image: nn.image!, idea: nn.description?.trim() || 'the transferable aesthetic idea of this image' }));
        const note = pool.filter(nn => nn.kind === 'note' && nn.text?.trim()).map(nn => nn.text!.trim()).join(' · ') || undefined;
        if (boardAssets.length + boardElements.length + fusionImages.length + facets.length + adhocProductImages.length + conceptIdeas.length === 0) {
            setNotice('❌ Nothing usable in this group — connect materials to it first.');
            return;
        }
        setBusy(tier === 'pro' ? 'Weaving (pro, inspected)…' : 'Weaving (flash draft)…');
        setNotice('');
        try {
            const r = await weaveGenerate(
                { assets: boardAssets, elements: boardElements, fusionImages, adhocProductImages, conceptIdeas, facets, note, ratio, size, tier },
                setBusy
            );
            setResults(prev => [r, ...prev]);
            setNotice(tier === 'pro' ? '✓ Woven (pro).' : '✓ Draft woven — happy? Weave in pro.');
        } catch (err: any) {
            setNotice(`❌ ${err instanceof BudgetExceededError ? err.message : err?.message || err}`);
        } finally { setBusy(''); }
    };

    /** Global Run: output nodes present → run each output's connected group;
     *  otherwise weave the whole board (classic mode). */
    const weave = async (tier: 'flash' | 'pro') => {
        const outputs = nodes.filter(nn => nn.kind === 'output');
        if (outputs.length === 0) {
            await weaveNodes(nodes, tier);
            return;
        }
        for (const o of outputs) {
            const comp = componentOf(o.id);
            if (comp.size <= 1) { setNotice('❌ An 🎯 output has no connections — link materials to it with ⚭.'); continue; }
            await weaveNodes(nodes.filter(nn => comp.has(nn.id) && nn.id !== o.id), tier);
        }
    };

    /** Run a single output node's connected group. */
    const runOutput = async (o: WeaveNode) => {
        const comp = componentOf(o.id);
        if (comp.size <= 1) { setNotice('❌ Link materials to this 🎯 output with ⚭ first.'); return; }
        await weaveNodes(nodes.filter(nn => comp.has(nn.id) && nn.id !== o.id), tierSel);
    };

    const assetOf = (id?: string) => assets.find(a => a.id === id);
    const elementOf = (id?: string) => elements.find(e => e.id === id);

    return (
        <div style={{ maxWidth: 1100, margin: '0 auto', padding: '18px 28px', display: 'flex', flexDirection: 'column', gap: 12 }}>
            {(busy || notice) && (
                <div className={busy ? 'praxis-running' : undefined}
                    style={{
                        position: 'sticky', top: 8, zIndex: 20, fontSize: 12.5, fontWeight: 600,
                        padding: '8px 14px', borderRadius: 10,
                        background: busy ? '#fef3c7' : notice.startsWith('❌') ? '#fef2f2' : '#ecfdf5',
                        color: busy ? '#92400e' : notice.startsWith('❌') ? '#b91c1c' : '#047857',
                        border: '1px solid rgba(0,0,0,0.06)',
                    }}>
                    {busy ? `⏳ ${busy}` : notice}
                </div>
            )}

            {/* Toolbar */}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <button style={S.btn} onClick={() => setPicker(picker === 'product' ? null : 'product')}>🛋 + Product</button>
                <button style={S.btn} onClick={() => setPicker(picker === 'element' ? null : 'element')}>💡 + Concept</button>
                <button style={S.btnGhost} onClick={() => fileRef.current?.click()}>🖼 + Images</button>
                <button style={S.btnGhost} onClick={() => add({ kind: 'note', text: '' })}>📝 + Note</button>
                <button style={S.btnGhost} onClick={() => add({ kind: 'output' })} title="An output collects connected materials into ONE image — several outputs = several images from one board">🎯 + Output</button>
                <input ref={fileRef} type="file" multiple accept="image/*" style={{ display: 'none' }}
                    onChange={e => { addImages(e.target.files); e.currentTarget.value = ''; }} />
                <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    {RATIOS.map(r => <button key={r} style={chip(ratio === r)} onClick={() => setRatio(r)}>{r}</button>)}
                    {SIZES.map(s => <button key={s} style={chip(size === s)} onClick={() => setSize(s)}>{s}</button>)}
                    <span style={{ ...S.label, marginLeft: 6 }}>MODEL</span>
                    <button style={chip(tierSel === 'flash')} onClick={() => setTierSel('flash')} title="gemini-3.1-flash-image · $0.04 · fast drafts">Flash</button>
                    <button style={chip(tierSel === 'pro')} onClick={() => setTierSel('pro')} title="gemini-3-pro-image · $0.24 · final quality + consistency inspector">Pro</button>
                    <button style={{ ...S.btn, fontWeight: 800 }} disabled={!!busy} onClick={() => weave(tierSel)}>▶ Run</button>
                </span>
            </div>

            {/* Pickers */}
            {picker === 'product' && (
                <div style={{ ...S.card, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {assets.map(a => (
                        <button key={a.id} style={chip(false)} onClick={() => { add({ kind: 'product', assetId: a.id }); setPicker(null); }}>
                            {a.photos[0] && <img src={a.photos[0].image.value} alt="" style={{ width: 20, height: 20, borderRadius: 4, objectFit: 'cover', marginRight: 5, verticalAlign: 'middle' }} />}
                            {a.name}
                        </button>
                    ))}
                    {assets.length === 0 && <span style={{ fontSize: 11, color: '#a1a1aa' }}>No products — add them in Products.</span>}
                </div>
            )}
            {picker === 'element' && (
                <div style={{ ...S.card, display: 'flex', gap: 6, flexWrap: 'wrap', maxHeight: 180, overflow: 'auto' }}>
                    {elements.map(el => (
                        <button key={el.id} style={chip(false)} title={el.description}
                            onClick={() => { add({ kind: 'element', elementId: el.id }); setPicker(null); }}>
                            [{el.type}] {el.concept}
                        </button>
                    ))}
                    {elements.length === 0 && <span style={{ fontSize: 11, color: '#a1a1aa' }}>No concepts — decompose references in Library.</span>}
                </div>
            )}

            {/* Board */}
            <DropZone onFiles={addImages} hint="Drop images — fusion sources">
                <div ref={boardRef} onPointerMove={onMove} onPointerUp={onUp}
                    style={{
                        position: 'relative', height: 480, borderRadius: 16,
                        background: 'repeating-linear-gradient(0deg, #fafafa, #fafafa 23px, #f0f0f1 24px), repeating-linear-gradient(90deg, #fafafa, #fafafa 23px, #f0f0f1 24px)',
                        border: '1px solid #e4e4e7', overflow: 'hidden', touchAction: 'none',
                    }}>
                    {nodes.length === 0 && (
                        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#a1a1aa', fontSize: 13, pointerEvents: 'none', textAlign: 'center', padding: 20 }}>
                            The board is empty — add materials, link them with ⚭ into groups (optionally toward 🎯 outputs), then ▶ Run.
                        </div>
                    )}
                    {/* Edges */}
                    <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
                        {edges.map(e => {
                            const a = nodes.find(nn => nn.id === e.from);
                            const b = nodes.find(nn => nn.id === e.to);
                            if (!a || !b) return null;
                            const cx = (nn: WeaveNode) => nn.x + (nn.kind === 'note' ? 100 : nn.kind === 'output' ? 55 : 65);
                            const cy = (nn: WeaveNode) => nn.y + 42;
                            return (
                                <line key={e.id}
                                    x1={cx(a)} y1={cy(a)} x2={cx(b)} y2={cy(b)}
                                    stroke="#18181b" strokeWidth={2} strokeOpacity={0.35} strokeDasharray="6 4" />
                            );
                        })}
                    </svg>
                    {nodes.map(nn => {
                        const a = assetOf(nn.assetId);
                        const el = elementOf(nn.elementId);
                        return (
                            <div key={nn.id} onPointerDown={e => onDown(e, nn)}
                                style={{
                                    position: 'absolute', left: nn.x, top: nn.y,
                                    width: nn.kind === 'note' ? 200 : nn.kind === 'output' ? 110 : 130,
                                    background: nn.kind === 'output' ? '#18181b' : '#fff',
                                    borderRadius: 12,
                                    border: linkFrom === nn.id ? '2.5px solid #d97706' : '1px solid #d4d4d8',
                                    boxShadow: '0 3px 10px rgba(0,0,0,0.08)', cursor: 'grab', userSelect: 'none',
                                    padding: 6,
                                }}>
                                <button onClick={() => remove(nn.id)}
                                    style={{ position: 'absolute', top: 2, right: 2, zIndex: 2, border: 'none', borderRadius: 5, background: 'rgba(0,0,0,0.4)', color: '#fff', fontSize: 9, cursor: 'pointer', padding: '1px 5px' }}>✕</button>
                                <button onClick={e => { e.stopPropagation(); link(nn.id); }} onPointerDown={e => e.stopPropagation()}
                                    title={linkFrom ? (linkFrom === nn.id ? 'Cancel linking' : 'Link to this node') : 'Start a link from this node'}
                                    style={{
                                        position: 'absolute', top: 2, left: 2, zIndex: 2, border: 'none', borderRadius: 5,
                                        background: linkFrom === nn.id ? '#d97706' : 'rgba(0,0,0,0.4)',
                                        color: '#fff', fontSize: 9, fontWeight: 800, cursor: 'pointer', padding: '1px 5px',
                                    }}>⚭</button>
                                {nn.kind === 'output' && (
                                    <div style={{ textAlign: 'center', paddingTop: 12 }}>
                                        <div style={{ fontSize: 20 }}>🎯</div>
                                        <div style={{ fontSize: 9, color: '#a1a1aa', margin: '2px 0 6px' }}>
                                            {Math.max(0, componentOf(nn.id).size - 1)} linked
                                        </div>
                                        <button onClick={e => { e.stopPropagation(); runOutput(nn); }} onPointerDown={e => e.stopPropagation()} disabled={!!busy}
                                            style={{ border: 'none', borderRadius: 7, background: '#fff', color: '#18181b', fontSize: 10, fontWeight: 800, cursor: 'pointer', padding: '3px 12px' }}>
                                            ▶ Run
                                        </button>
                                    </div>
                                )}
                                {nn.kind === 'product' && a && (
                                    <>
                                        {a.photos[0] && <img src={a.photos[0].image.value} alt="" draggable={false}
                                            onClick={() => openLightbox(a.photos[0].image.value)}
                                            style={{ width: '100%', borderRadius: 8, display: 'block', cursor: 'zoom-in' }} />}
                                        <div style={{ fontSize: 10, fontWeight: 700, marginTop: 3 }}>🛋 {a.name}</div>
                                        <div style={{ fontSize: 9, color: '#a1a1aa' }}>{a.photos.length} angle{a.photos.length === 1 ? '' : 's'} · high fidelity</div>
                                    </>
                                )}
                                {nn.kind === 'element' && el && (
                                    <>
                                        <div style={{ fontSize: 9, fontWeight: 700, color: '#71717a' }}>💡 {el.type.toUpperCase()}</div>
                                        <div style={{ fontSize: 11, fontWeight: 700, lineHeight: 1.3 }}>{el.concept}</div>
                                        <div style={{ fontSize: 9, color: '#a1a1aa', marginTop: 2, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{el.description}</div>
                                    </>
                                )}
                                {nn.kind === 'image' && nn.image && (
                                    <>
                                        <img src={nn.image} alt="" draggable={false}
                                            onClick={() => openLightbox(nn.image!)}
                                            style={{ width: '100%', borderRadius: 8, display: 'block', cursor: 'zoom-in' }} />
                                        <div style={{ display: 'flex', gap: 2, marginTop: 3 }} onPointerDown={e => e.stopPropagation()}>
                                            {(['fusion', 'product', 'concept'] as const).map(role => (
                                                <button key={role} onClick={() => setRole(nn, role)} disabled={!!busy}
                                                    title={role === 'product' ? 'Source of truth — high fidelity' : role === 'concept' ? 'Embody its idea, never copy' : 'Blend its whole aesthetic'}
                                                    style={{
                                                        flex: 1, border: 'none', borderRadius: 5, fontSize: 8, fontWeight: 800, cursor: 'pointer', padding: '2px 0',
                                                        background: (nn.role ?? 'fusion') === role ? '#18181b' : '#f4f4f5',
                                                        color: (nn.role ?? 'fusion') === role ? '#fff' : '#71717a',
                                                    }}>
                                                    {role === 'fusion' ? '🖼' : role === 'product' ? '🛋' : '💡'} {role}
                                                </button>
                                            ))}
                                        </div>
                                        {nn.role === 'concept' && nn.description && (
                                            <div style={{ fontSize: 8.5, color: '#71717a', marginTop: 2, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{nn.description}</div>
                                        )}
                                        <div style={{ display: 'flex', gap: 2, marginTop: 2 }} onPointerDown={e => e.stopPropagation()}>
                                            <button onClick={() => decomposeNode(nn)} disabled={!!busy}
                                                title="Decompose into 7 dimensions — keep only the ones you want"
                                                style={{ flex: 1, border: 'none', background: '#f4f4f5', borderRadius: 5, fontSize: 8.5, fontWeight: 700, cursor: 'pointer', padding: '2px 0' }}>⚡ facets</button>
                                            <button onClick={() => imageToPrompt(nn)} disabled={!!busy}
                                                title="Reverse-engineer a prompt from this image → editable note"
                                                style={{ flex: 1, border: 'none', background: '#f4f4f5', borderRadius: 5, fontSize: 8.5, fontWeight: 700, cursor: 'pointer', padding: '2px 0' }}>✍️ prompt</button>
                                        </div>
                                    </>
                                )}
                                {nn.kind === 'facet' && (
                                    <>
                                        <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                                            {nn.image && <img src={nn.image} alt="" draggable={false} style={{ width: 24, height: 24, borderRadius: 5, objectFit: 'cover' }} />}
                                            <span style={{ fontSize: 10, fontWeight: 800 }}>⚡ {nn.dimension?.toUpperCase()}</span>
                                        </div>
                                        <div style={{ fontSize: 9, color: '#71717a', marginTop: 3, display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{nn.description}</div>
                                    </>
                                )}
                                {nn.kind === 'note' && (
                                    <textarea
                                        value={nn.text ?? ''}
                                        placeholder="📝 art direction…"
                                        onChange={e => setNodes(prev => prev.map(x => x.id === nn.id ? { ...x, text: e.target.value } : x))}
                                        onPointerDown={e => e.stopPropagation()}
                                        style={{ width: '100%', minHeight: 64, border: 'none', outline: 'none', resize: 'vertical', fontSize: 11, fontFamily: 'inherit', background: '#fffbeb', borderRadius: 8, padding: 6, boxSizing: 'border-box' }}
                                    />
                                )}
                            </div>
                        );
                    })}
                </div>
            </DropZone>

            {/* Results */}
            {results.length > 0 && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 10 }}>
                    {results.map(r => (
                        <div key={r.id} style={{ ...S.card, padding: 0, overflow: 'hidden', position: 'relative' }}>
                            <img src={r.image.value} alt="" onClick={() => openLightbox(r.image.value)}
                                style={{ width: '100%', display: 'block', cursor: 'zoom-in' }} />
                            {r.consistency && (
                                <span title={r.consistency.pass ? 'Product inspection passed' : r.consistency.issues.join('; ')}
                                    style={{ position: 'absolute', top: 6, left: 6, fontSize: 10, fontWeight: 800, padding: '2px 7px', borderRadius: 999, background: r.consistency.pass ? 'rgba(5,150,105,0.92)' : 'rgba(217,119,6,0.92)', color: '#fff' }}>
                                    {r.consistency.pass ? (r.consistency.retried ? '✓ fixed' : '✓ exact') : '⚠ check'}
                                </span>
                            )}
                            <div style={{ padding: '6px 10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <span style={{ fontSize: 10, color: '#a1a1aa' }}>{r.params.modelTier === 'pro' ? 'FINAL' : 'DRAFT'} · ${r.estimatedCostUsd.toFixed(2)}</span>
                                <span style={{ display: 'flex', gap: 6 }}>
                                    <button style={S.btnGhost} title="Save to Gallery" onClick={async () => { await recordSignal(r, 'save'); setNotice('✓ Saved to Gallery.'); }}>★</button>
                                    <button style={S.btnGhost} title="Pull back onto the board as a fusion source"
                                        onClick={() => add({ kind: 'image', image: r.image.value })}>↩ board</button>
                                    <button style={S.btnGhost} title="Download" onClick={() => {
                                        const el2 = document.createElement('a');
                                        el2.href = r.image.value;
                                        el2.download = `praxis-weave-${r.id.slice(0, 6)}.png`;
                                        el2.click();
                                        recordSignal(r, 'export');
                                    }}>⬇</button>
                                </span>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
