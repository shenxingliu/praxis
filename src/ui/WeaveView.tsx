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

export default function WeaveView() {
    const [assets, setAssets] = useState<Asset[]>([]);
    const [elements, setElements] = useState<Element[]>([]);
    const [nodes, setNodes] = useState<WeaveNode[]>([]);
    const [edges, setEdges] = useState<WeaveEdge[]>([]);
    /** Port-drag linking: from node id + live cursor position on the board. */
    const [linking, setLinking] = useState<{ from: string; x: number; y: number } | null>(null);
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
    // Infinite canvas: pan + zoom.
    const [pan, setPan] = useState({ x: 40, y: 40 });
    const [scale, setScale] = useState(1);
    const panning = useRef<{ sx: number; sy: number; px: number; py: number } | null>(null);

    /** Screen (client) → world coordinates. */
    const toWorld = (clientX: number, clientY: number) => {
        const rect = boardRef.current?.getBoundingClientRect();
        if (!rect) return { x: 0, y: 0 };
        return { x: (clientX - rect.left - pan.x) / scale, y: (clientY - rect.top - pan.y) / scale };
    };

    /** New nodes land near the current view center. */
    const nextPos = () => {
        dropCount += 1;
        const rect = boardRef.current?.getBoundingClientRect();
        const cx = rect ? (rect.width / 2 - pan.x) / scale : 200;
        const cy = rect ? (rect.height / 2 - pan.y) / scale : 160;
        return { x: cx - 220 + (dropCount % 4) * 150, y: cy - 140 + (Math.floor(dropCount / 4) % 3) * 130 };
    };

    useEffect(() => {
        storage.listAssets().then(setAssets);
        storage.listElements().then(es => setElements(es.filter(e => e.enabled)));
    }, []);

    const add = (partial: Omit<WeaveNode, 'id' | 'x' | 'y'>) =>
        setNodes(prev => [...prev, { id: crypto.randomUUID(), ...nextPos(), ...partial }]);

    const remove = (id: string) => {
        setNodes(prev => prev.filter(nn => nn.id !== id));
        setEdges(prev => prev.filter(e => e.from !== id && e.to !== id));
        if (linking?.from === id) setLinking(null);
    };

    /** Complete a port-drag on a target node → create edge (or remove dup). */
    const completeLink = (targetId: string) => {
        const l = linking;
        setLinking(null);
        if (!l || l.from === targetId) return;
        const exists = edges.find(e =>
            (e.from === l.from && e.to === targetId) || (e.from === targetId && e.to === l.from));
        if (exists) setEdges(prev => prev.filter(e => e.id !== exists.id));
        else setEdges(prev => [...prev, { id: crypto.randomUUID(), from: l.from, to: targetId }]);
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

    // --- drag / pan / zoom ---
    const onDown = (e: React.PointerEvent, node: WeaveNode) => {
        const w = toWorld(e.clientX, e.clientY);
        drag.current = { id: node.id, dx: w.x - node.x, dy: w.y - node.y };
        e.stopPropagation();
    };
    const onBoardDown = (e: React.PointerEvent) => {
        // Background press → pan the infinite canvas.
        panning.current = { sx: e.clientX, sy: e.clientY, px: pan.x, py: pan.y };
    };
    const onMove = (e: React.PointerEvent) => {
        if (linking) {
            const w = toWorld(e.clientX, e.clientY);
            setLinking({ ...linking, x: w.x, y: w.y });
            return;
        }
        const d = drag.current;
        if (d) {
            const w = toWorld(e.clientX, e.clientY);
            setNodes(prev => prev.map(nn => nn.id === d.id ? { ...nn, x: w.x - d.dx, y: w.y - d.dy } : nn));
            return;
        }
        const p = panning.current;
        if (p) setPan({ x: p.px + (e.clientX - p.sx), y: p.py + (e.clientY - p.sy) });
    };
    const onUp = () => { drag.current = null; panning.current = null; setLinking(null); };
    const onWheel = (e: React.WheelEvent) => {
        e.preventDefault();
        const rect = boardRef.current?.getBoundingClientRect();
        if (!rect) return;
        const next = Math.max(0.35, Math.min(2.2, scale * (e.deltaY > 0 ? 0.92 : 1.08)));
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        setPan({ x: cx - ((cx - pan.x) / scale) * next, y: cy - ((cy - pan.y) / scale) * next });
        setScale(next);
    };

    // --- geometry for edges (Weave-style horizontal beziers) ---
    const W = (nn: WeaveNode) => nn.kind === 'note' ? 200 : nn.kind === 'output' ? (nn.image ? 200 : 110) : 130;
    const anchorY = (nn: WeaveNode) => nn.y + 46;
    const bezier = (x1: number, y1: number, x2: number, y2: number) => {
        const dx = Math.max(40, Math.abs(x2 - x1) / 2);
        return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
    };

    /** Weave a specific set of nodes (a connected group, or the whole board). */
    const weaveNodes = async (pool: WeaveNode[], tier: 'flash' | 'pro'): Promise<GenerationResult | undefined> => {
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
            return r;
        } catch (err: any) {
            setNotice(`❌ ${err instanceof BudgetExceededError ? err.message : err?.message || err}`);
        } finally { setBusy(''); }
        return undefined;
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
            if (comp.size <= 1) { setNotice('❌ An 🎯 output has no connections — drag a port line to it first.'); continue; }
            const r = await weaveNodes(nodes.filter(nn => comp.has(nn.id) && nn.id !== o.id), tier);
            if (r) setNodes(prev => prev.map(x => x.id === o.id ? { ...x, image: r.image.value } : x));
        }
    };

    /** Run a single output node's connected group — result lands IN the node. */
    const runOutput = async (o: WeaveNode) => {
        const comp = componentOf(o.id);
        if (comp.size <= 1) { setNotice('❌ Drag a port line from your materials to this 🎯 output first.'); return; }
        const r = await weaveNodes(nodes.filter(nn => comp.has(nn.id) && nn.id !== o.id), tierSel);
        if (r) setNodes(prev => prev.map(x => x.id === o.id ? { ...x, image: r.image.value } : x));
    };

    /** Solo-run one facet node: visualize that single dimension (flash). */
    const runFacet = async (f: WeaveNode) => {
        await weaveNodes([f], 'flash');
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
                <button style={S.btnGhost} onClick={() => add({ kind: 'note', text: '' })}>✍️ + Prompt</button>
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

            {/* Board — infinite canvas: drag background to pan, wheel to zoom */}
            <DropZone onFiles={addImages} hint="Drop images — fusion sources">
                <div ref={boardRef} onPointerDown={onBoardDown} onPointerMove={onMove} onPointerUp={onUp} onWheel={onWheel}
                    style={{
                        position: 'relative', height: 560, borderRadius: 16,
                        background: 'repeating-linear-gradient(0deg, #fafafa, #fafafa 23px, #f0f0f1 24px), repeating-linear-gradient(90deg, #fafafa, #fafafa 23px, #f0f0f1 24px)',
                        border: '1px solid #e4e4e7', overflow: 'hidden', touchAction: 'none', cursor: 'grab',
                    }}>
                    <div style={{ position: 'absolute', top: 8, right: 12, zIndex: 10, fontSize: 10, color: '#a1a1aa', pointerEvents: 'none' }}>
                        {Math.round(scale * 100)}% · drag background to pan · wheel to zoom
                    </div>
                    {nodes.length === 0 && (
                        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#a1a1aa', fontSize: 13, pointerEvents: 'none', textAlign: 'center', padding: 20 }}>
                            The board is empty — add materials and prompts, drag from a node's ⚪ port to another node to link, wire groups into 🎯 outputs, then ▶ Run.
                        </div>
                    )}
                    <div style={{ position: 'absolute', left: 0, top: 0, transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`, transformOrigin: '0 0' }}>
                    {/* Edges — Weave-style beziers; click a curve to unlink */}
                    <svg width={8000} height={8000} style={{ position: 'absolute', left: -2000, top: -2000, pointerEvents: 'none', overflow: 'visible' }} viewBox="-2000 -2000 8000 8000">
                        {edges.map(e => {
                            const a = nodes.find(nn => nn.id === e.from);
                            const b = nodes.find(nn => nn.id === e.to);
                            if (!a || !b) return null;
                            const [l, r2] = a.x <= b.x ? [a, b] : [b, a];
                            const d = bezier(l.x + W(l), anchorY(l), r2.x, anchorY(r2));
                            return (
                                <g key={e.id}>
                                    <path d={d} stroke="transparent" strokeWidth={14} fill="none"
                                        style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                                        onClick={() => setEdges(prev => prev.filter(x => x.id !== e.id))} />
                                    <path d={d} stroke="#a1a1aa" strokeWidth={1.6} fill="none" />
                                    <circle cx={l.x + W(l)} cy={anchorY(l)} r={4} fill="#fff" stroke="#a1a1aa" strokeWidth={1.5} />
                                    <circle cx={r2.x} cy={anchorY(r2)} r={4} fill="#fff" stroke="#a1a1aa" strokeWidth={1.5} />
                                </g>
                            );
                        })}
                        {linking && (() => {
                            const a = nodes.find(nn => nn.id === linking.from);
                            if (!a) return null;
                            return <path d={bezier(a.x + W(a), anchorY(a), linking.x, linking.y)}
                                stroke="#d97706" strokeWidth={1.8} fill="none" strokeDasharray="5 4" />;
                        })()}
                    </svg>
                    {nodes.map(nn => {
                        const a = assetOf(nn.assetId);
                        const el = elementOf(nn.elementId);
                        return (
                            <div key={nn.id} onPointerDown={e => onDown(e, nn)}
                                onPointerUp={e => { if (linking) { e.stopPropagation(); completeLink(nn.id); } }}
                                style={{
                                    position: 'absolute', left: nn.x, top: nn.y,
                                    width: nn.kind === 'note' ? 200 : nn.kind === 'output' ? (nn.image ? 200 : 110) : 130,
                                    background: nn.kind === 'output' ? '#18181b' : '#fff',
                                    borderRadius: 12,
                                    border: linking?.from === nn.id ? '2px solid #d97706'
                                        : linking ? '2px dashed #d97706' : '1px solid #d4d4d8',
                                    boxShadow: '0 3px 10px rgba(0,0,0,0.08)', cursor: 'grab', userSelect: 'none',
                                    padding: 6,
                                }}>
                                <button onClick={() => remove(nn.id)}
                                    style={{ position: 'absolute', top: 2, right: 2, zIndex: 2, border: 'none', borderRadius: 5, background: 'rgba(0,0,0,0.4)', color: '#fff', fontSize: 9, cursor: 'pointer', padding: '1px 5px' }}>✕</button>
                                {/* Ports — drag from a dot to another node, Weave-style */}
                                {(['left', 'right'] as const).map(side => (
                                    <div key={side}
                                        onPointerDown={e => {
                                            e.stopPropagation();
                                            const w = toWorld(e.clientX, e.clientY);
                                            setLinking({ from: nn.id, x: w.x, y: w.y });
                                        }}
                                        title="Drag to another node to link"
                                        style={{
                                            position: 'absolute', [side]: -7, top: 38, width: 13, height: 13,
                                            borderRadius: '50%', background: '#fff', border: '2px solid #a1a1aa',
                                            cursor: 'crosshair', zIndex: 3,
                                        }} />
                                ))}
                                {nn.kind === 'output' && (
                                    <div style={{ textAlign: 'center', paddingTop: nn.image ? 2 : 12 }}>
                                        {nn.image ? (
                                            <img src={nn.image} alt="" draggable={false}
                                                onClick={e => { e.stopPropagation(); openLightbox(nn.image!); }}
                                                style={{ width: '100%', borderRadius: 9, display: 'block', cursor: 'zoom-in' }} />
                                        ) : (
                                            <div style={{ fontSize: 20 }}>🎯</div>
                                        )}
                                        <div style={{ fontSize: 9, color: '#a1a1aa', margin: '3px 0 5px' }}>
                                            {Math.max(0, componentOf(nn.id).size - 1)} linked
                                        </div>
                                        <div style={{ display: 'flex', gap: 3, justifyContent: 'center' }} onPointerDown={e => e.stopPropagation()}>
                                            <button onClick={e => { e.stopPropagation(); runOutput(nn); }} disabled={!!busy}
                                                style={{ border: 'none', borderRadius: 7, background: '#fff', color: '#18181b', fontSize: 10, fontWeight: 800, cursor: 'pointer', padding: '3px 12px' }}>
                                                ▶ Run
                                            </button>
                                            {nn.image && <>
                                                <button title="Save to Gallery" disabled={!!busy}
                                                    onClick={async e => {
                                                        e.stopPropagation();
                                                        const r = results.find(x => x.image.value === nn.image);
                                                        if (r) { await recordSignal(r, 'save'); setNotice('✓ Saved to Gallery.'); }
                                                    }}
                                                    style={{ border: 'none', borderRadius: 7, background: 'rgba(255,255,255,0.2)', color: '#fff', fontSize: 10, cursor: 'pointer', padding: '3px 8px' }}>★</button>
                                                <button title="Download"
                                                    onClick={e => {
                                                        e.stopPropagation();
                                                        const a2 = document.createElement('a');
                                                        a2.href = nn.image!;
                                                        a2.download = `praxis-weave-${nn.id.slice(0, 6)}.png`;
                                                        a2.click();
                                                    }}
                                                    style={{ border: 'none', borderRadius: 7, background: 'rgba(255,255,255,0.2)', color: '#fff', fontSize: 10, cursor: 'pointer', padding: '3px 8px' }}>⬇</button>
                                            </>}
                                        </div>
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
                                        <button onClick={e => { e.stopPropagation(); runFacet(nn); }} onPointerDown={e => e.stopPropagation()} disabled={!!busy}
                                            title="Generate from this single dimension alone (flash)"
                                            style={{ width: '100%', marginTop: 3, border: 'none', background: '#f4f4f5', borderRadius: 5, fontSize: 8.5, fontWeight: 700, cursor: 'pointer', padding: '2px 0' }}>▶ solo</button>
                                    </>
                                )}
                                {nn.kind === 'note' && (
                                    <textarea
                                        value={nn.text ?? ''}
                                        placeholder="✍️ type your prompt / art direction…"
                                        onChange={e => setNodes(prev => prev.map(x => x.id === nn.id ? { ...x, text: e.target.value } : x))}
                                        onPointerDown={e => e.stopPropagation()}
                                        style={{ width: '100%', minHeight: 64, border: 'none', outline: 'none', resize: 'vertical', fontSize: 11, fontFamily: 'inherit', background: '#fffbeb', borderRadius: 8, padding: 6, boxSizing: 'border-box' }}
                                    />
                                )}
                            </div>
                        );
                    })}
                    </div>
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
