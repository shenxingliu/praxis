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
 * WEAVE — infinite freeform canvas (Figma-Weave inspired).
 *
 * Nodes: 🛋 product · 💡 concept · 🖼 image · ⚡ facet · ✍️ prompt · 🎯 output.
 * Port-drag bezier links; connected groups flow into outputs; results are
 * generated INSIDE the output nodes. Collapsed nodes show only their
 * content — click a node to expand its action buttons.
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
    image?: string;        // image node source / output result
    text?: string;         // prompt nodes
    dimension?: string;    // facet nodes
    description?: string;  // facet nodes / concept-role idea
    role?: 'fusion' | 'product' | 'concept';
    resultId?: string;     // output nodes: the GenerationResult behind image
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

const miniBtn: React.CSSProperties = {
    border: 'none', background: '#f4f4f5', borderRadius: 6, fontSize: 9.5,
    fontWeight: 700, cursor: 'pointer', padding: '3px 7px', color: '#3f3f46',
};

export default function WeaveView() {
    const [assets, setAssets] = useState<Asset[]>([]);
    const [elements, setElements] = useState<Element[]>([]);
    const [nodes, setNodes] = useState<WeaveNode[]>([]);
    const [edges, setEdges] = useState<WeaveEdge[]>([]);
    const [linking, setLinking] = useState<{ from: string; x: number; y: number } | null>(null);
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [picker, setPicker] = useState<'product' | 'element' | null>(null);
    const [facetPick, setFacetPick] = useState<{ image: string; near: { x: number; y: number }; facets: Array<{ dimension: string; description: string }> } | null>(null);
    const [ratio, setRatio] = useState<GenerationParams['ratio']>('4:3');
    const [size, setSize] = useState<NonNullable<GenerationParams['size']>>('1K');
    const [tierSel, setTierSel] = useState<'flash' | 'pro'>('pro');
    const [busy, setBusy] = useState('');
    const [notice, setNotice] = useState('');
    const resultsRef = useRef<Map<string, GenerationResult>>(new Map());
    const fileRef = useRef<HTMLInputElement>(null);
    const drag = useRef<{ id: string; dx: number; dy: number; moved: boolean } | null>(null);
    const boardRef = useRef<HTMLDivElement>(null);
    const [pan, setPan] = useState({ x: 40, y: 40 });
    const [scale, setScale] = useState(1);
    const panning = useRef<{ sx: number; sy: number; px: number; py: number } | null>(null);

    useEffect(() => {
        storage.listAssets().then(setAssets);
        storage.listElements().then(es => setElements(es.filter(e => e.enabled)));
    }, []);

    const toWorld = (clientX: number, clientY: number) => {
        const rect = boardRef.current?.getBoundingClientRect();
        if (!rect) return { x: 0, y: 0 };
        return { x: (clientX - rect.left - pan.x) / scale, y: (clientY - rect.top - pan.y) / scale };
    };

    const nextPos = () => {
        dropCount += 1;
        const rect = boardRef.current?.getBoundingClientRect();
        const cx = rect ? (rect.width / 2 - pan.x) / scale : 200;
        const cy = rect ? (rect.height / 2 - pan.y) / scale : 160;
        return { x: cx - 220 + (dropCount % 4) * 150, y: cy - 140 + (Math.floor(dropCount / 4) % 3) * 130 };
    };

    const add = (partial: Omit<WeaveNode, 'id' | 'x' | 'y'>, pos?: { x: number; y: number }): WeaveNode => {
        const node: WeaveNode = { id: crypto.randomUUID(), ...(pos ?? nextPos()), ...partial };
        setNodes(prev => [...prev, node]);
        return node;
    };

    const remove = (id: string) => {
        setNodes(prev => prev.filter(nn => nn.id !== id));
        setEdges(prev => prev.filter(e => e.from !== id && e.to !== id));
        if (expandedId === id) setExpandedId(null);
    };

    const addImages = async (files: File[] | FileList | null) => {
        for (const f of imageFiles(files)) add({ kind: 'image', image: await fileToDataUrl(f), role: 'fusion' });
    };

    // --- linking ---
    const completeLink = (targetId: string) => {
        const l = linking;
        setLinking(null);
        if (!l || l.from === targetId) return;
        const exists = edges.find(e =>
            (e.from === l.from && e.to === targetId) || (e.from === targetId && e.to === l.from));
        if (exists) setEdges(prev => prev.filter(e => e.id !== exists.id));
        else setEdges(prev => [...prev, { id: crypto.randomUUID(), from: l.from, to: targetId }]);
    };

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

    // --- drag / pan / zoom ---
    const onDown = (e: React.PointerEvent, node: WeaveNode) => {
        const w = toWorld(e.clientX, e.clientY);
        drag.current = { id: node.id, dx: w.x - node.x, dy: w.y - node.y, moved: false };
        e.stopPropagation();
    };
    const onBoardDown = (e: React.PointerEvent) => {
        panning.current = { sx: e.clientX, sy: e.clientY, px: pan.x, py: pan.y };
        setExpandedId(null);
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
            d.moved = true;
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

    const W = (nn: WeaveNode) => nn.kind === 'note' ? 200 : nn.kind === 'output' ? (nn.image ? 200 : 110) : 130;
    const anchorY = (nn: WeaveNode) => nn.y + 46;
    const bezier = (x1: number, y1: number, x2: number, y2: number) => {
        const dx = Math.max(40, Math.abs(x2 - x1) / 2);
        return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
    };

    // --- facets: extract, then let the user PICK which ones to add ---
    const decomposeNode = async (node: WeaveNode) => {
        if (!node.image) return;
        setBusy('Decomposing into dimensions…');
        setNotice('');
        try {
            const facets = await extractFacets(node.image);
            setFacetPick({ image: node.image, near: { x: node.x + 150, y: node.y }, facets });
        } catch (err: any) { setNotice(`❌ ${err?.message || err}`); }
        setBusy('');
    };

    const addFacet = (f: { dimension: string; description: string }, i: number) => {
        if (!facetPick) return;
        add({ kind: 'facet', image: facetPick.image, dimension: f.dimension, description: f.description },
            { x: facetPick.near.x + (i % 2) * 145, y: facetPick.near.y + Math.floor(i / 2) * 105 });
    };

    // --- role / prompt derivation ---
    const setRole = async (node: WeaveNode, role: 'fusion' | 'product' | 'concept') => {
        setNodes(prev => prev.map(x => x.id === node.id ? { ...x, role } : x));
        if (role === 'concept' && !node.description && node.image) {
            setBusy('Deriving the idea…');
            try {
                const idea = await deriveIdea(node.image);
                setNodes(prev => prev.map(x => x.id === node.id ? { ...x, description: idea } : x));
            } catch (err: any) { setNotice(`❌ ${err?.message || err}`); }
            setBusy('');
        }
    };

    const imageToPrompt = async (node: WeaveNode) => {
        if (!node.image) return;
        setBusy('Reading the image into a prompt…');
        try {
            const text = await describeAsPrompt(node.image);
            add({ kind: 'note', text }, { x: node.x + 145, y: node.y });
            setNotice('✓ Prompt derived — edit it freely.');
        } catch (err: any) { setNotice(`❌ ${err?.message || err}`); }
        setBusy('');
    };

    // --- generation: results ALWAYS land inside an output node ---
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
        // Output nodes with results also act as fusion sources when linked onward.
        const outputImages = pool.filter(nn => nn.kind === 'output' && nn.image).map(nn => nn.image!);
        fusionImages.push(...outputImages);
        if (boardAssets.length + boardElements.length + fusionImages.length + facets.length + adhocProductImages.length + conceptIdeas.length === 0) {
            setNotice('❌ Nothing usable in this group.');
            return undefined;
        }
        setBusy(tier === 'pro' ? 'Weaving (pro, inspected)…' : 'Weaving (flash)…');
        setNotice('');
        try {
            const r = await weaveGenerate(
                { assets: boardAssets, elements: boardElements, fusionImages, adhocProductImages, conceptIdeas, facets, note, ratio, size, tier },
                setBusy
            );
            resultsRef.current.set(r.id, r);
            setNotice('✓ Woven.');
            return r;
        } catch (err: any) {
            setNotice(`❌ ${err instanceof BudgetExceededError ? err.message : err?.message || err}`);
        } finally { setBusy(''); }
        return undefined;
    };

    const assignToOutput = (outputId: string, r: GenerationResult) =>
        setNodes(prev => prev.map(x => x.id === outputId ? { ...x, image: r.image.value, resultId: r.id } : x));

    const runOutput = async (o: WeaveNode) => {
        const comp = componentOf(o.id);
        if (comp.size <= 1) { setNotice('❌ Drag a port line from your materials to this 🎯 first.'); return; }
        const r = await weaveNodes(nodes.filter(nn => comp.has(nn.id) && nn.id !== o.id), tierSel);
        if (r) assignToOutput(o.id, r);
    };

    const weave = async (tier: 'flash' | 'pro') => {
        const outputs = nodes.filter(nn => nn.kind === 'output');
        if (outputs.length === 0) {
            // No outputs yet → auto-create one to hold the result.
            const o = add({ kind: 'output' });
            const r = await weaveNodes(nodes, tier);
            if (r) assignToOutput(o.id, r);
            else remove(o.id);
            return;
        }
        for (const o of outputs) {
            const comp = componentOf(o.id);
            if (comp.size <= 1) continue;
            const r = await weaveNodes(nodes.filter(nn => comp.has(nn.id) && nn.id !== o.id), tier);
            if (r) assignToOutput(o.id, r);
        }
    };

    /** Solo-run one facet: spawn an output next to it. */
    const runFacet = async (f: WeaveNode) => {
        const r = await weaveNodes([f], 'flash');
        if (r) add({ kind: 'output', image: r.image.value, resultId: r.id }, { x: f.x + 150, y: f.y });
    };

    const saveResult = async (nn: WeaveNode) => {
        const r = nn.resultId ? resultsRef.current.get(nn.resultId) : undefined;
        if (!r) { setNotice('❌ Result metadata not in this session — download instead.'); return; }
        await recordSignal(r, 'save');
        setNotice('✓ Saved to Gallery.');
    };

    const download = (nn: WeaveNode) => {
        if (!nn.image) return;
        const a = document.createElement('a');
        a.href = nn.image;
        a.download = `praxis-weave-${nn.id.slice(0, 6)}.png`;
        a.click();
        const r = nn.resultId ? resultsRef.current.get(nn.resultId) : undefined;
        if (r) recordSignal(r, 'export');
    };

    const assetOf = (id?: string) => assets.find(a => a.id === id);
    const elementOf = (id?: string) => elements.find(e => e.id === id);

    /** Click content → toggle the expanded action row (unless just dragged). */
    const toggleExpand = (id: string) => {
        if (drag.current?.moved) return;
        setExpandedId(prev => prev === id ? null : id);
    };

    return (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 14px', boxSizing: 'border-box' }}>
            {(busy || notice) && (
                <div className={busy ? 'praxis-running' : undefined}
                    style={{
                        position: 'sticky', top: 8, zIndex: 30, fontSize: 12.5, fontWeight: 600,
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
                <button style={S.btnGhost} onClick={() => add({ kind: 'output' })}>🎯 + Output</button>
                <input ref={fileRef} type="file" multiple accept="image/*" style={{ display: 'none' }}
                    onChange={e => { addImages(e.target.files); e.currentTarget.value = ''; }} />
                <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    {RATIOS.map(r => <button key={r} style={chip(ratio === r)} onClick={() => setRatio(r)}>{r}</button>)}
                    {SIZES.map(s => <button key={s} style={chip(size === s)} onClick={() => setSize(s)}>{s}</button>)}
                    <span style={{ ...S.label, marginLeft: 6 }}>MODEL</span>
                    <button style={chip(tierSel === 'flash')} onClick={() => setTierSel('flash')} title="flash · $0.04">Flash</button>
                    <button style={chip(tierSel === 'pro')} onClick={() => setTierSel('pro')} title="pro · $0.24 · consistency inspector">Pro</button>
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

            {/* Facet chooser — pick only the dimensions you want */}
            {facetPick && (
                <div style={{ ...S.card, display: 'flex', flexDirection: 'column', gap: 8, border: '1.5px dashed #a1a1aa' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={S.label}>⚡ PICK DIMENSIONS · add only what you want</span>
                        <span style={{ display: 'flex', gap: 6 }}>
                            <button style={S.btnGhost} onClick={() => { facetPick.facets.forEach((f, i) => addFacet(f, i)); setFacetPick(null); }}>Add all</button>
                            <button style={S.btnGhost} onClick={() => setFacetPick(null)}>Close</button>
                        </span>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8 }}>
                        {facetPick.facets.map((f, i) => (
                            <button key={f.dimension} onClick={() => { addFacet(f, i); }}
                                style={{ ...S.card, textAlign: 'left', cursor: 'pointer', background: '#fafafa', padding: 8 }}>
                                <div style={{ fontSize: 10.5, fontWeight: 800 }}>⚡ {f.dimension.toUpperCase()} <span style={{ fontWeight: 400, color: '#a1a1aa' }}>· click to add</span></div>
                                <div style={{ fontSize: 10, color: '#71717a', marginTop: 3 }}>{f.description}</div>
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {/* Infinite canvas — fills the whole remaining viewport */}
            <DropZone onFiles={addImages} hint="Drop images — fusion sources" style={{ flex: 1, minHeight: 0, display: 'flex' }}>
                <div ref={boardRef} onPointerDown={onBoardDown} onPointerMove={onMove} onPointerUp={onUp} onWheel={onWheel}
                    style={{
                        position: 'relative', flex: 1, minHeight: 0, borderRadius: 16,
                        background: 'repeating-linear-gradient(0deg, #fafafa, #fafafa 23px, #f0f0f1 24px), repeating-linear-gradient(90deg, #fafafa, #fafafa 23px, #f0f0f1 24px)',
                        border: '1px solid #e4e4e7', overflow: 'hidden', touchAction: 'none', cursor: 'grab',
                    }}>
                    <div style={{ position: 'absolute', top: 8, right: 12, zIndex: 10, fontSize: 10, color: '#a1a1aa', pointerEvents: 'none' }}>
                        {Math.round(scale * 100)}% · drag background to pan · wheel to zoom · click a node for actions
                    </div>
                    {nodes.length === 0 && (
                        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#a1a1aa', fontSize: 13, pointerEvents: 'none', textAlign: 'center', padding: 20 }}>
                            Add materials and prompts, drag ⚪ port lines between nodes, wire groups into 🎯 outputs, then ▶ Run — results appear inside the 🎯.
                        </div>
                    )}
                    <div style={{ position: 'absolute', left: 0, top: 0, transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`, transformOrigin: '0 0' }}>
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
                        const open = expandedId === nn.id;
                        return (
                            <div key={nn.id} onPointerDown={e => onDown(e, nn)}
                                onPointerUp={e => { if (linking) { e.stopPropagation(); completeLink(nn.id); } }}
                                style={{
                                    position: 'absolute', left: nn.x, top: nn.y, width: W(nn),
                                    background: nn.kind === 'output' ? '#18181b' : '#fff',
                                    borderRadius: 12,
                                    border: linking?.from === nn.id ? '2px solid #d97706'
                                        : linking ? '2px dashed #d97706'
                                        : open ? '2px solid #18181b' : '1px solid #d4d4d8',
                                    boxShadow: open ? '0 8px 24px rgba(0,0,0,0.16)' : '0 3px 10px rgba(0,0,0,0.08)',
                                    cursor: 'grab', userSelect: 'none', padding: 6, zIndex: open ? 5 : 1,
                                }}>
                                {/* Ports */}
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
                                            cursor: 'crosshair', zIndex: 6,
                                        }} />
                                ))}

                                {/* --- content (collapsed = content only, no buttons) --- */}
                                {nn.kind === 'product' && a && (
                                    <div onClick={() => toggleExpand(nn.id)}>
                                        {a.photos[0] && <img src={a.photos[0].image.value} alt="" draggable={false}
                                            style={{ width: '100%', borderRadius: 8, display: 'block' }} />}
                                        <div style={{ fontSize: 10, fontWeight: 700, marginTop: 3 }}>🛋 {a.name}</div>
                                    </div>
                                )}
                                {nn.kind === 'element' && el && (
                                    <div onClick={() => toggleExpand(nn.id)}>
                                        <div style={{ fontSize: 9, fontWeight: 700, color: '#71717a' }}>💡 {el.type.toUpperCase()}</div>
                                        <div style={{ fontSize: 11, fontWeight: 700, lineHeight: 1.3 }}>{el.concept}</div>
                                    </div>
                                )}
                                {nn.kind === 'image' && nn.image && (
                                    <div onClick={() => toggleExpand(nn.id)}>
                                        <img src={nn.image} alt="" draggable={false}
                                            style={{ width: '100%', borderRadius: 8, display: 'block' }} />
                                        <div style={{ fontSize: 9, color: '#a1a1aa', marginTop: 2 }}>
                                            {nn.role === 'product' ? '🛋 product (exact)' : nn.role === 'concept' ? '💡 concept' : '🖼 fusion'}
                                        </div>
                                    </div>
                                )}
                                {nn.kind === 'facet' && (
                                    <div onClick={() => toggleExpand(nn.id)}>
                                        <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                                            {nn.image && <img src={nn.image} alt="" draggable={false} style={{ width: 24, height: 24, borderRadius: 5, objectFit: 'cover' }} />}
                                            <span style={{ fontSize: 10, fontWeight: 800 }}>⚡ {nn.dimension?.toUpperCase()}</span>
                                        </div>
                                        <div style={{ fontSize: 9, color: '#71717a', marginTop: 3, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{nn.description}</div>
                                    </div>
                                )}
                                {nn.kind === 'note' && (
                                    <textarea
                                        value={nn.text ?? ''}
                                        placeholder="✍️ type your prompt…"
                                        onChange={e => setNodes(prev => prev.map(x => x.id === nn.id ? { ...x, text: e.target.value } : x))}
                                        onPointerDown={e => e.stopPropagation()}
                                        onClick={() => setExpandedId(nn.id)}
                                        style={{ width: '100%', minHeight: 64, border: 'none', outline: 'none', resize: 'vertical', fontSize: 11, fontFamily: 'inherit', background: '#fffbeb', borderRadius: 8, padding: 6, boxSizing: 'border-box' }}
                                    />
                                )}
                                {nn.kind === 'output' && (
                                    <div onClick={() => toggleExpand(nn.id)} style={{ textAlign: 'center', paddingTop: nn.image ? 0 : 10 }}>
                                        {nn.image ? (
                                            <img src={nn.image} alt="" draggable={false}
                                                style={{ width: '100%', borderRadius: 9, display: 'block' }} />
                                        ) : (
                                            <>
                                                <div style={{ fontSize: 20 }}>🎯</div>
                                                <div style={{ fontSize: 9, color: '#a1a1aa', margin: '3px 0 8px' }}>
                                                    {Math.max(0, componentOf(nn.id).size - 1)} linked · click for Run
                                                </div>
                                            </>
                                        )}
                                    </div>
                                )}

                                {/* --- expanded action row --- */}
                                {open && (
                                    <div onPointerDown={e => e.stopPropagation()}
                                        style={{ display: 'flex', gap: 3, flexWrap: 'wrap', marginTop: 5, background: nn.kind === 'output' ? 'rgba(255,255,255,0.08)' : undefined, borderRadius: 8, padding: nn.kind === 'output' ? 4 : 0 }}>
                                        {nn.kind === 'output' && (
                                            <>
                                                <button style={{ ...miniBtn, background: '#fff' }} disabled={!!busy} onClick={() => runOutput(nn)}>▶ Run</button>
                                                {nn.image && <>
                                                    <button style={miniBtn} onClick={() => download(nn)}>⬇ save file</button>
                                                    <button style={miniBtn} disabled={!!busy} onClick={() => saveResult(nn)}>★ gallery</button>
                                                    <button style={miniBtn} onClick={() => openLightbox(nn.image!)}>🔍 zoom</button>
                                                    <button style={miniBtn} onClick={() => add({ kind: 'image', image: nn.image!, role: 'fusion' }, { x: nn.x + W(nn) + 30, y: nn.y })}>↩ as material</button>
                                                </>}
                                            </>
                                        )}
                                        {nn.kind === 'image' && (
                                            <>
                                                {(['fusion', 'product', 'concept'] as const).map(role => (
                                                    <button key={role} style={{ ...miniBtn, background: (nn.role ?? 'fusion') === role ? '#18181b' : '#f4f4f5', color: (nn.role ?? 'fusion') === role ? '#fff' : '#3f3f46' }}
                                                        disabled={!!busy} onClick={() => setRole(nn, role)}>
                                                        {role === 'fusion' ? '🖼' : role === 'product' ? '🛋' : '💡'} {role}
                                                    </button>
                                                ))}
                                                <button style={miniBtn} disabled={!!busy} onClick={() => decomposeNode(nn)}>⚡ facets</button>
                                                <button style={miniBtn} disabled={!!busy} onClick={() => imageToPrompt(nn)}>✍️ prompt</button>
                                                <button style={miniBtn} onClick={() => openLightbox(nn.image!)}>🔍 zoom</button>
                                                <button style={miniBtn} onClick={() => download(nn)}>⬇</button>
                                            </>
                                        )}
                                        {nn.kind === 'facet' && (
                                            <button style={miniBtn} disabled={!!busy} onClick={() => runFacet(nn)}>▶ solo (flash)</button>
                                        )}
                                        {nn.kind === 'product' && a?.photos[0] && (
                                            <button style={miniBtn} onClick={() => openLightbox(a.photos[0].image.value)}>🔍 zoom</button>
                                        )}
                                        {nn.kind === 'element' && el && (
                                            <span style={{ fontSize: 9, color: '#71717a', flexBasis: '100%' }}>{el.description}</span>
                                        )}
                                        <button style={{ ...miniBtn, color: '#b91c1c' }} onClick={() => remove(nn.id)}>✕ delete</button>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                    </div>
                </div>
            </DropZone>
        </div>
    );
}
