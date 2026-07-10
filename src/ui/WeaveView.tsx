import React, { useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Asset, Element, GenerationParams, GenerationResult, Reference, SubjectType, KnowledgeRule } from '../domain/types';
import { storage } from '../storage/local';
import { brandKey, getCurrentBrandId } from '../domain/brand';
import { INVENTORY_CHANGED_EVENT } from './events';
import { weaveGenerate, extractFacets, deriveIdea, describeAsPrompt, analyzeImage, rotateView, estimateAngles, distillWeaveApproach, WeaveFacet, FACET_DIMENSIONS, FACET_HINTS } from '../engine/weave';
import { recordSignal } from '../learning/learning';
import { BudgetExceededError } from '../engine/engine';
import { openLightbox } from './lightbox';
import { DropZone, imageFiles } from './dropzone';
import { encodeSpinGif } from './gif';
import { S } from './styles';
import { SegmentedControl } from './SegmentedControl';

/**
 * CANVAS — infinite freeform canvas (Figma-Weave inspired).
 *
 * Nodes: hero · concept · image · facet · prompt · output.
 * Port-drag bezier links; connected groups flow into outputs; results are
 * generated INSIDE the output nodes. Collapsed nodes show only their
 * content — click a node to expand its action buttons.
 */

type NodeKind = 'hero' | 'element' | 'image' | 'note' | 'facet' | 'output' | 'rotate';
type ResizeDir = 'sw' | 'se';
interface WeaveEdge { id: string; from: string; to: string }
interface WeaveNode {
    id: string;
    kind: NodeKind;
    x: number;
    y: number;
    assetId?: string;
    elementId?: string;
    image?: string;        // image node cover / output result / rotate result
    images?: string[];     // image nodes: ALL angles (multi-image subject)
    text?: string;         // prompt nodes
    dimension?: string;    // facet nodes
    description?: string;  // facet nodes / concept-role idea
    role?: 'fusion' | 'hero' | 'concept';
    resultId?: string;     // output/rotate nodes: GenerationResult behind image
    angle?: number;        // rotate nodes: azimuth in degrees (free, 0-359)
    pitch?: number;        // rotate nodes: camera elevation −45..+45
    w?: number;            // custom width (drag the ◢ corner handle)
    h?: number;            // custom height (drag the ◢ corner handle)
    quantity?: number;     // hero nodes: how many instances (default 1)
}

/** Saved canvas configuration — persisted via brandKey KV. */
interface WeaveConfig {
    id: string;
    name: string;
    nodes: WeaveNode[];
    edges: WeaveEdge[];
    ratio: GenerationParams['ratio'];
    size: NonNullable<GenerationParams['size']>;
    tier: 'flash' | 'pro';
    createdAt: number;
    updatedAt: number;
}

const CONFIGS_KEY = 'weaveConfigs';

const nodeImages = (nn: WeaveNode): string[] =>
    nn.images && nn.images.length > 0 ? nn.images : nn.image ? [nn.image] : [];

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

/** 3D cube with colored faces — much easier to identify angle than a sphere.
 *  Front=blue, Back=slate, Left=green, Right=yellow, Top=white, Bottom=dark.
 *  Orange dot marks the hero-front (0° azimuth). */
const Ball: React.FC<{ az: number; pi: number; size: number }> = ({ az, pi, size }) => {
    const rad = Math.PI / 180;
    const cx = size / 2;
    const cy = size / 2;
    const s = size * 0.32; // half-edge length
    const azR = az * rad;
    const piR = pi * rad;

    // 3D→2D projection: rotate by azimuth (Y-axis) then pitch (X-axis).
    const project = (x: number, y: number, z: number): [number, number, number] => {
        // Y-axis rotation (azimuth)
        const x1 = x * Math.cos(azR) + z * Math.sin(azR);
        const z1 = -x * Math.sin(azR) + z * Math.cos(azR);
        const y1 = y;
        // X-axis rotation (pitch)
        const y2 = y1 * Math.cos(piR) - z1 * Math.sin(piR);
        const z2 = y1 * Math.sin(piR) + z1 * Math.cos(piR);
        return [cx + x1 * 0.9, cy - y2 * 0.9, z2];
    };

    // 8 cube vertices (centered at origin, half-edge = s)
    const v: [number, number, number][] = [
        [-s, -s,  s], [ s, -s,  s], [ s,  s,  s], [-s,  s,  s], // front face
        [-s, -s, -s], [ s, -s, -s], [ s,  s, -s], [-s,  s, -s], // back face
    ];
    const pv = v.map(([x, y, z]) => project(x, y, z));

    // 6 faces: [vertex indices, base color, label]
    const faces: [number[], string, string][] = [
        [[0, 1, 2, 3], '#4a90d9', 'F'],  // Front  — blue
        [[5, 4, 7, 6], '#6b7280', 'B'],  // Back
        [[4, 0, 3, 7], '#4aad6a', 'L'],  // Left   — green
        [[1, 5, 6, 2], '#d9a84a', 'R'],  // Right  — yellow
        [[3, 2, 6, 7], '#c8c8d0', 'T'],  // Top    — light
        [[4, 5, 1, 0], '#5a5a64', 'Bt'], // Bottom — dark
    ];

    // Sort by average z-depth (painter's algorithm)
    const sorted = faces
        .map(([idx, color, label]) => {
            const pts = idx.map(i => pv[i]);
            const avgZ = pts.reduce((sum, p) => sum + p[2], 0) / 4;
            return { idx, color, label, pts, avgZ };
        })
        .sort((a, b) => a.avgZ - b.avgZ);

    // Darken faces based on depth for pseudo-lighting
    const darken = (hex: string, factor: number): string => {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        const f = Math.max(0.3, Math.min(1, factor));
        return `rgb(${Math.round(r * f)},${Math.round(g * f)},${Math.round(b * f)})`;
    };

    // Front-center marker (0,0,s) projected
    const [fx, fy, fz] = project(0, 0, s * 1.05);

    return (
        <svg width={size} height={size} style={{ flexShrink: 0, display: 'block' }}>
            {sorted.map(({ idx, color, label, pts, avgZ }) => {
                const brightness = 0.55 + 0.45 * ((avgZ / s + 1) / 2);
                const points = pts.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
                // Face center for label
                const lcx = pts.reduce((a, p) => a + p[0], 0) / 4;
                const lcy = pts.reduce((a, p) => a + p[1], 0) / 4;
                return (
                    <g key={label}>
                        <polygon points={points}
                            fill={darken(color, brightness)} stroke="#3f3f46" strokeWidth={0.7}
                            strokeLinejoin="round" />
                        {size >= 60 && <text x={lcx} y={lcy + 3.5} textAnchor="middle"
                            fontSize={9} fontWeight={800} fill="rgba(255,255,255,0.7)"
                            style={{ pointerEvents: 'none' }}>{label}</text>}
                    </g>
                );
            })}
            {fz > 0 && <circle cx={fx} cy={fy} r={size >= 60 ? 4.5 : 3}
                fill="#18181b" stroke="#fff" strokeWidth={1.2} />}
        </svg>
    );
};

const miniBtn: React.CSSProperties = {
    border: '1px solid rgba(212,212,216,0.42)', background: 'rgba(255,255,255,0.38)',
    borderRadius: 8, fontSize: 9.5, fontWeight: 680, cursor: 'pointer',
    padding: '3px 7px', color: '#3f3f46',
    backdropFilter: 'blur(18px) saturate(1.18)', WebkitBackdropFilter: 'blur(18px) saturate(1.18)',
};

const fitImage = (fixed: boolean, extra: React.CSSProperties = {}): React.CSSProperties => ({
    width: '100%',
    height: fixed ? '100%' : undefined,
    objectFit: fixed ? 'cover' : undefined,
    borderRadius: 8,
    display: 'block',
    ...extra,
});

export type WeaveViewHandle = {
    addAssetToCanvas: (assetId: string) => void;
    addReferenceToCanvas: (referenceId: string) => void;
};

const WeaveView = React.forwardRef<WeaveViewHandle>(function WeaveView(_, ref) {
    const [assets, setAssets] = useState<Asset[]>([]);
    const [elements, setElements] = useState<Element[]>([]);
    const [references, setReferences] = useState<Reference[]>([]);
    const [nodes, setNodes] = useState<WeaveNode[]>([]);
    const [edges, setEdges] = useState<WeaveEdge[]>([]);
    const [linking, setLinking] = useState<{ from: string; x: number; y: number } | null>(null);
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [hoverId, setHoverId] = useState<string | null>(null);
    const [libOpen, setLibOpen] = useState(false);
    const [libTab, setLibTab] = useState<'assets' | 'inspiration'>('assets');
    const [libWidth, setLibWidth] = useState(208);
    const [libResizing, setLibResizing] = useState(false);
    const [facetPick, setFacetPick] = useState<{ image: string; near: { x: number; y: number } } | null>(null);
    const [ratio, setRatio] = useState<GenerationParams['ratio']>('4:3');
    const [size, setSize] = useState<NonNullable<GenerationParams['size']>>('1K');
    const [tierSel, setTierSel] = useState<'flash' | 'pro'>('flash');
    const [busy, setBusy] = useState('');
    const [outputBusy, setOutputBusy] = useState<Record<string, string>>({});
    const [notice, setNotice] = useState('');
    // Workflow save/load
    const [configs, setConfigs] = useState<WeaveConfig[]>([]);
    const [showSaveDialog, setShowSaveDialog] = useState(false);
    const [saveName, setSaveName] = useState('');
    const [showLoadMenu, setShowLoadMenu] = useState(false);
    const resultsRef = useRef<Map<string, GenerationResult>>(new Map());
    /** Session cache of results behind board nodes. Capped — each entry
     *  carries a full base64 image and an unbounded map eats hundreds of
     *  MB over a long canvas session. */
    const rememberResult = (r: GenerationResult) => {
        const cache = resultsRef.current;
        cache.set(r.id, r);
        while (cache.size > 60) {
            const oldest = cache.keys().next().value;
            if (oldest === undefined) break;
            cache.delete(oldest);
        }
    };
    const fileRef = useRef<HTMLInputElement>(null);
    const drag = useRef<{ id: string; dx: number; dy: number; moved: boolean } | null>(null);
    /** 3D orbit-drag on rotate nodes: horizontal = azimuth, vertical = pitch. */
    const orbit = useRef<{ id: string; sx: number; sy: number; a0: number; p0: number } | null>(null);
    /** Corner-handle resizing. */
    const resizing = useRef<{ id: string; dir: ResizeDir; sx: number; sy: number; x0: number; y0: number; w0: number; h0: number } | null>(null);
    const railResize = useRef<{ sx: number; w0: number } | null>(null);
    const libRef = useRef<HTMLDivElement>(null);
    const boardRef = useRef<HTMLDivElement>(null);
    const [pan, setPan] = useState({ x: 40, y: 40 });
    const [scale, setScale] = useState(1);
    const panning = useRef<{ sx: number; sy: number; px: number; py: number } | null>(null);

    useEffect(() => {
        storage.listAssets().then(setAssets);
        storage.listElements().then(es => setElements(es.filter(e => e.enabled)));
        storage.listReferences().then(setReferences);
        storage.kvGet<WeaveConfig[]>(brandKey(CONFIGS_KEY)).then(c => setConfigs(c ?? []));
    }, []);

    useEffect(() => {
        const onPointerMove = (event: PointerEvent) => {
            const r = railResize.current;
            if (!r) return;
            setLibWidth(Math.max(150, Math.min(380, Math.round(r.w0 + event.clientX - r.sx))));
        };
        const onPointerUp = () => { railResize.current = null; setLibResizing(false); };
        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp);
        window.addEventListener('pointercancel', onPointerUp);
        return () => {
            window.removeEventListener('pointermove', onPointerMove);
            window.removeEventListener('pointerup', onPointerUp);
            window.removeEventListener('pointercancel', onPointerUp);
        };
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

    const setOutputStatus = (id: string, text: string) => {
        setOutputBusy(prev => {
            const next = { ...prev };
            if (text) next[id] = text;
            else delete next[id];
            return next;
        });
    };

    useImperativeHandle(ref, () => ({
        addAssetToCanvas: (assetId: string) => {
            add({ kind: 'hero', assetId });
            setNotice('Asset added to Canvas.');
        },
        addReferenceToCanvas: (referenceId: string) => {
            const reference = references.find(r => r.id === referenceId);
            if (!reference) return;
            add({ kind: 'image', image: reference.image.value, role: 'fusion' });
            setNotice('Inspiration added to Canvas.');
        },
    }));

    const remove = (id: string) => {
        setNodes(prev => prev.filter(nn => nn.id !== id));
        setEdges(prev => prev.filter(e => e.from !== id && e.to !== id));
        if (expandedId === id) setExpandedId(null);
    };

    const addImages = async (files: File[] | FileList | null) => {
        for (const f of imageFiles(files)) add({ kind: 'image', image: await fileToDataUrl(f), role: 'fusion' });
    };

    /** Add more angle photos to a library ASSET — they persist on the
     *  asset itself and feed rotate + fidelity everywhere it's used. */
    const appendTarget = useRef<Asset | null>(null);
    const appendRef = useRef<HTMLInputElement>(null);
    const appendAngles = async (files: FileList | null) => {
        const target = appendTarget.current;
        appendTarget.current = null;
        if (!target) return;
        const extra: string[] = [];
        for (const f of imageFiles(files)) extra.push(await fileToDataUrl(f));
        if (extra.length === 0) return;
        const updated: Asset = {
            ...target,
            photos: [
                ...target.photos,
                ...extra.map(value => ({ id: crypto.randomUUID(), image: { kind: 'data' as const, value }, role: 'detail' as const })),
            ],
            updatedAt: Date.now(),
        };
        await storage.upsertAsset(updated);
        setAssets(prev => prev.map(a => (a.id === updated.id ? updated : a)));
        angleCache.current.delete(`asset:${updated.id}`);
        setNotice(`${extra.length} angle${extra.length === 1 ? '' : 's'} added to "${updated.name}".`);
    };

    /** Remove one angle photo from an asset (kept: at least one). */
    const removeAssetPhoto = async (asset: Asset, photoId: string) => {
        if (asset.photos.length <= 1) { setNotice('An asset needs at least one photo.'); return; }
        const updated: Asset = { ...asset, photos: asset.photos.filter(p => p.id !== photoId), updatedAt: Date.now() };
        await storage.upsertAsset(updated);
        setAssets(prev => prev.map(x => (x.id === updated.id ? updated : x)));
        angleCache.current.delete(`asset:${updated.id}:${asset.photos.length}`);
        setNotice('Angle removed.');
    };

    // --- rotate angle awareness: photo roles map to azimuths, untagged
    // multi-angle sets get ONE cached vision estimation per subject ---
    const ROLE_ANGLE: Record<string, number | null> = { hero: 0, side: 90, back: 180, detail: null };
    const angleCache = useRef<Map<string, Array<number | null>>>(new Map());
    const estimateAnglesCached = async (key: string, images: string[]): Promise<Array<number | null>> => {
        const cached = angleCache.current.get(key);
        if (cached && cached.length === images.length) return cached;
        try {
            setBusy('Estimating photo angles…');
            const angles = await estimateAngles(images);
            angleCache.current.set(key, angles);
            return angles;
        } catch {
            return images.map(() => null);
        }
    };
    const angularDist = (a: number, b: number) => {
        const d = Math.abs(a - b) % 360;
        return d > 180 ? 360 - d : d;
    };
    /** Rotate inputs with per-image azimuths, sorted nearest-first to the
     *  target angle so the closest existing photo leads the generation. */
    const gatherRotateSources = async (rn: WeaveNode, targetAngle: number): Promise<{ images: string[]; angles: Array<number | null> }> => {
        const neighborIds = edges
            .filter(e => e.from === rn.id || e.to === rn.id)
            .map(e => (e.from === rn.id ? e.to : e.from));
        const entries: Array<{ image: string; angle: number | null }> = [];
        for (const id of neighborIds) {
            const nb = nodes.find(x => x.id === id);
            if (!nb) continue;
            if (nb.kind === 'hero') {
                const asset = assets.find(x => x.id === nb.assetId);
                if (!asset || asset.photos.length === 0) continue;
                const photos = asset.photos.slice(0, 6);
                const tagged = photos.some(p => p.role === 'side' || p.role === 'back');
                const angles = tagged
                    ? photos.map(p => ROLE_ANGLE[p.role ?? 'hero'] ?? 0)
                    : photos.length > 1
                        ? await estimateAnglesCached(`asset:${asset.id}:${photos.length}`, photos.map(p => p.image.value))
                        : [0];
                photos.forEach((p, i) => entries.push({ image: p.image.value, angle: angles[i] ?? null }));
            } else if (nb.kind === 'rotate' && nb.image) {
                entries.push({ image: nb.image, angle: nb.angle ?? null });
            } else if (nb.kind === 'image' || nb.kind === 'output') {
                const imgs = nodeImages(nb);
                if (imgs.length > 1) {
                    const angles = await estimateAnglesCached(`node:${nb.id}:${imgs.length}`, imgs);
                    imgs.forEach((image, i) => entries.push({ image, angle: angles[i] ?? null }));
                } else if (imgs[0]) {
                    entries.push({ image: imgs[0], angle: null });
                }
            }
        }
        entries.sort((a, b) => {
            if (a.angle == null && b.angle == null) return 0;
            if (a.angle == null) return 1;
            if (b.angle == null) return -1;
            return angularDist(a.angle, targetAngle) - angularDist(b.angle, targetAngle);
        });
        const top = entries.slice(0, 6);
        return { images: top.map(e => e.image), angles: top.map(e => e.angle) };
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
        const rs = resizing.current;
        if (rs) {
            const dx = (e.clientX - rs.sx) / scale;
            const dy = (e.clientY - rs.sy) / scale;
            const fromLeft = rs.dir.includes('w');
            const fromTop = rs.dir.includes('n');
            const w = Math.max(130, Math.min(620, Math.round(rs.w0 + (fromLeft ? -dx : dx))));
            const h = Math.max(96, Math.min(680, Math.round(rs.h0 + (fromTop ? -dy : dy))));
            const x = fromLeft ? rs.x0 + (rs.w0 - w) : rs.x0;
            const y = fromTop ? rs.y0 + (rs.h0 - h) : rs.y0;
            setNodes(prev => prev.map(nn => {
                if (nn.id !== rs.id) return nn;
                // Content-driven nodes scale PROPORTIONALLY: both drag axes
                // blend into one scale factor via the frame's aspect ratio at
                // grab time, and height keeps following the content — so a
                // diagonal (or vertical) pull resizes naturally, never crops.
                if (nn.kind === 'rotate' || nn.kind === 'output' || nn.kind === 'image' || nn.kind === 'hero' || nn.kind === 'facet') {
                    const ar = rs.h0 > 0 ? rs.w0 / rs.h0 : 1;
                    const dwRaw = fromLeft ? -dx : dx;
                    const dhRaw = fromTop ? -dy : dy;
                    const wProp = Math.max(130, Math.min(620, Math.round(rs.w0 + (dwRaw + dhRaw * ar) / 2)));
                    const xProp = fromLeft ? rs.x0 + (rs.w0 - wProp) : rs.x0;
                    return { ...nn, x: xProp, w: wProp, h: undefined };
                }
                return { ...nn, x, y, w, h };
            }));
            return;
        }
        const o = orbit.current;
        if (o) {
            const az = ((Math.round(o.a0 + (e.clientX - o.sx) * 1.1) % 360) + 360) % 360;
            const pi = Math.max(-60, Math.min(60, Math.round(o.p0 - (e.clientY - o.sy) * 0.6)));
            setNodes(prev => prev.map(nn => nn.id === o.id ? { ...nn, angle: az, pitch: pi } : nn));
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
    const onUp = () => { drag.current = null; panning.current = null; orbit.current = null; resizing.current = null; setLinking(null); };

    // Zoom must use a NON-PASSIVE native wheel listener — React's synthetic
    // wheel is passive, so preventDefault() is ignored and the browser zooms
    // the whole page instead of the canvas.
    const viewRef = useRef({ pan, scale });
    useEffect(() => { viewRef.current = { pan, scale }; }, [pan, scale]);
    useEffect(() => {
        const el = boardRef.current;
        if (!el) return;
        const handler = (e: WheelEvent) => {
            // Scrolling the library overlay must scroll its grid, not zoom.
            if (libRef.current && e.target instanceof Node && libRef.current.contains(e.target)) return;
            e.preventDefault();
            e.stopPropagation();
            const rect = el.getBoundingClientRect();
            const { pan: p, scale: s } = viewRef.current;
            const next = Math.max(0.35, Math.min(2.2, s * (e.deltaY > 0 ? 0.92 : 1.08)));
            const cx = e.clientX - rect.left;
            const cy = e.clientY - rect.top;
            setPan({ x: cx - ((cx - p.x) / s) * next, y: cy - ((cy - p.y) / s) * next });
            setScale(next);
        };
        el.addEventListener('wheel', handler, { passive: false });
        return () => el.removeEventListener('wheel', handler);
    }, []);

    const W = (nn: WeaveNode) => nn.w ?? (
        nn.kind === 'output' ? 300 :
        nn.kind === 'facet' ? 190 :
        nn.kind === 'rotate' ? 300 :
        nn.kind === 'note' ? 220 :
        220
    );
    // Content-driven nodes never take a fixed height — the frame follows
    // what's inside (image aspect ratio, trackball, action rows) with no
    // cropping. Notes/facets keep a working default; others keep custom h.
    const H = (nn: WeaveNode) => {
        if (nn.kind === 'rotate' || nn.kind === 'output' || nn.kind === 'image' || nn.kind === 'hero' || nn.kind === 'facet') return undefined;
        return nn.h ?? (nn.kind === 'note' ? 136 : 220);
    };
    const anchorY = (nn: WeaveNode) => nn.y + Math.min(84, (H(nn) ?? 168) / 2);
    const bezier = (x1: number, y1: number, x2: number, y2: number) => {
        const dx = Math.max(40, Math.abs(x2 - x1) / 2);
        return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
    };

    // Context-menu behavior: any pointerdown outside the popover closes it.
    const facetPopRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!facetPick) return;
        const onDown = (e: PointerEvent) => {
            if (facetPopRef.current && e.target instanceof Node && facetPopRef.current.contains(e.target)) return;
            setFacetPick(null);
        };
        window.addEventListener('pointerdown', onDown, true);
        return () => window.removeEventListener('pointerdown', onDown, true);
    }, [facetPick]);

    // --- facets: a popover on the node — one click extracts one dimension ---
    const decomposeImage = (image: string | undefined, near: { x: number; y: number }) => {
        if (!image) return;
        setFacetPick({ image, near });
    };
    const decomposeNode = (node: WeaveNode) => decomposeImage(node.image, { x: node.x + 150, y: node.y });

    const runExtract = async (chosen: string[]) => {
        const pick = facetPick;
        if (!pick || chosen.length === 0) return;
        setFacetPick(null);
        setBusy(`Extracting ${chosen.length} dimension${chosen.length === 1 ? '' : 's'}…`);
        setNotice('');
        try {
            const facets = await extractFacets(pick.image, chosen);
            facets.forEach((f, i) =>
                add({ kind: 'facet', image: pick.image, dimension: f.dimension, description: f.description },
                    { x: pick.near.x + (i % 2) * 210, y: pick.near.y + Math.floor(i / 2) * 170 }));
            setNotice(`${facets.length} facet card${facets.length === 1 ? '' : 's'} on the board.`);
        } catch (err: any) { setNotice(`${err?.message || err}`); }
        setBusy('');
    };

    // --- promote an uploaded image node into a library Asset ---
    const SUBJECT_TYPES: SubjectType[] = ['product', 'person', 'food', 'apparel', 'space', 'other'];
    const saveNodeAsAsset = async (nn: WeaveNode, subjectType: SubjectType) => {
        const imgs = nodeImages(nn);
        if (imgs.length === 0) return;
        const name = window.prompt('Asset name:', 'New asset')?.trim();
        if (!name) return;
        setBusy('Saving to Assets…');
        setNotice('');
        try {
            const now = Date.now();
            const asset: Asset = {
                id: crypto.randomUUID(),
                brandId: getCurrentBrandId(),
                name,
                subjectType,
                tags: [],
                photos: imgs.map((value, i) => ({
                    id: crypto.randomUUID(),
                    image: { kind: 'data' as const, value },
                    role: (i === 0 ? 'hero' : 'detail') as 'hero' | 'detail',
                })),
                createdAt: now,
                updatedAt: now,
            };
            await storage.upsertAsset(asset);
            setAssets(prev => [...prev, asset]);
            window.dispatchEvent(new CustomEvent(INVENTORY_CHANGED_EVENT));
            // The node becomes a real library-asset node — same pixels, but
            // now with full fidelity rules and reusable across the app.
            setNodes(prev => prev.map(x => x.id === nn.id
                ? { id: x.id, kind: 'hero' as const, x: x.x, y: x.y, assetId: asset.id, w: x.w, h: x.h }
                : x));
            setNotice(`Asset "${name}" saved as ${subjectType} — the node is now a library asset.`);
        } catch (err: any) { setNotice(`${err?.message || err}`); }
        setBusy('');
    };

    // --- role / prompt derivation ---
    const setRole = async (node: WeaveNode, role: 'fusion' | 'hero' | 'concept') => {
        setNodes(prev => prev.map(x => x.id === node.id ? { ...x, role } : x));
        if (role === 'concept' && !node.description && node.image) {
            setBusy('Deriving the idea…');
            try {
                const idea = await deriveIdea(node.image);
                setNodes(prev => prev.map(x => x.id === node.id ? { ...x, description: idea } : x));
            } catch (err: any) { setNotice(`${err?.message || err}`); }
            setBusy('');
        }
    };

    const imageToPromptAt = async (image: string | undefined, pos: { x: number; y: number }) => {
        if (!image) return;
        setBusy('Reading the image into a prompt…');
        try {
            const text = await describeAsPrompt(image);
            add({ kind: 'note', text }, pos);
            setNotice('Prompt derived — edit it freely.');
        } catch (err: any) { setNotice(`${err?.message || err}`); }
        setBusy('');
    };
    const imageToPrompt = (node: WeaveNode) => imageToPromptAt(node.image, { x: node.x + 145, y: node.y });

    /** Spin an asset's photo off into reference nodes / derivations. */
    const assetToImage = (nn: WeaveNode, asset: Asset, role: 'fusion' | 'concept') => {
        const img = asset.photos[0]?.image.value;
        if (!img) return;
        const created = add({ kind: 'image', image: img, role }, { x: nn.x + W(nn) + 30, y: nn.y });
        if (role === 'concept') setRole(created, 'concept');
        setNotice(role === 'fusion' ? 'Vibe reference created from the asset.' : 'Idea reference created — deriving its idea…');
    };

    // --- directed analysis: note + connected image → prompt ---
    const analyzeConnected = async (noteNode: WeaveNode) => {
        if (!noteNode.text?.trim()) { setNotice('Write your analysis instruction in the note first.'); return; }
        const neighborIds = edges
            .filter(e => e.from === noteNode.id || e.to === noteNode.id)
            .map(e => (e.from === noteNode.id ? e.to : e.from));
        let img: string | undefined;
        for (const id of neighborIds) {
            const n = nodes.find(x => x.id === id);
            if (!n) continue;
            if ((n.kind === 'image' || n.kind === 'output' || n.kind === 'rotate') && n.image) { img = n.image; break; }
            if (n.kind === 'hero' && n.assetId) {
                const a = assets.find(x => x.id === n.assetId);
                if (a?.photos[0]) { img = a.photos[0].image.value; break; }
            }
        }
        if (!img) { setNotice('Connect this note to an image or hero node first.'); return; }
        setBusy('Analyzing image…');
        setNotice('');
        try {
            const prompt = await analyzeImage(img, noteNode.text.trim());
            add({ kind: 'note', text: prompt }, { x: noteNode.x, y: noteNode.y + 160 });
            setNotice('Analysis → prompt generated.');
        } catch (err: any) { setNotice(`${err?.message || err}`); }
        setBusy('');
    };

    // --- generation: results ALWAYS land inside an output node ---
    const weaveNodes = async (
        pool: WeaveNode[],
        tier: 'flash' | 'pro',
        reportBusy: (text: string) => void = setBusy,
    ): Promise<GenerationResult | undefined> => {
        const boardAssets = assets.filter(a => pool.some(nn => nn.kind === 'hero' && nn.assetId === a.id));
        const boardElements = elements.filter(el => pool.some(nn => nn.kind === 'element' && nn.elementId === el.id));
        const facets: WeaveFacet[] = pool
            .filter(nn => nn.kind === 'facet' && nn.image && nn.dimension && nn.description)
            .map(nn => ({ image: nn.image!, dimension: nn.dimension!, description: nn.description! }));
        const imageNodes = pool.filter(nn => nn.kind === 'image' && nn.image);
        const fusionImages = imageNodes.filter(nn => (nn.role ?? 'fusion') === 'fusion').map(nn => nn.image!);
        // Hero-role nodes contribute ALL their merged angles as truth.
        const adhocHeroImages = imageNodes.filter(nn => nn.role === 'hero').flatMap(nodeImages);
        const conceptIdeas = imageNodes
            .filter(nn => nn.role === 'concept')
            .map(nn => ({ image: nn.image!, idea: nn.description?.trim() || 'the transferable aesthetic idea of this image' }));
        // Rotate nodes define the VIEWPOINT. If one hasn't been rendered yet,
        // auto-render it first (flash) so "drag ball → Run" just works.
        const rotateNodes = pool.filter(nn => nn.kind === 'rotate');
        const viewpointImages = rotateNodes.filter(nn => nn.image).map(nn => nn.image!);
        const viewpoint = rotateNodes.length > 0
            ? { azimuth: rotateNodes[0].angle ?? 90, pitch: rotateNodes[0].pitch ?? 0 }
            : undefined;
        for (const rn of rotateNodes.filter(nn => !nn.image)) {
            const target = rn.angle ?? 90;
            const sources = await gatherRotateSources(rn, target);
            if (sources.images.length === 0) continue;
            reportBusy(`Rendering viewpoint ${target}° first…`);
            try {
                const rv = await rotateView(sources.images, target, { ratio, size, tier: 'flash', pitch: rn.pitch ?? 0, sourceAngles: sources.angles }, reportBusy);
                rememberResult(rv);
                setNodes(prev => prev.map(x => x.id === rn.id ? { ...x, image: rv.image.value, resultId: rv.id } : x));
                viewpointImages.push(rv.image.value);
            } catch (err) { console.warn('[weave] viewpoint pre-render failed:', err); }
        }
        // Hero quantity instructions
        const qtyNotes = pool
            .filter(nn => nn.kind === 'hero' && nn.assetId && (nn.quantity ?? 1) > 1)
            .map(nn => {
                const pa = assets.find(x => x.id === nn.assetId);
                return pa ? `Show exactly ${nn.quantity} instances of "${pa.name}" arranged naturally in the scene.` : '';
            })
            .filter(Boolean);
        const userNote = pool.filter(nn => nn.kind === 'note' && nn.text?.trim()).map(nn => nn.text!.trim()).join(' · ');
        const note = [...qtyNotes, userNote].filter(Boolean).join(' · ') || undefined;
        // Output nodes with results also act as fusion sources when linked onward.
        const outputImages = pool.filter(nn => nn.kind === 'output' && nn.image).map(nn => nn.image!);
        fusionImages.push(...outputImages);
        if (boardAssets.length + boardElements.length + fusionImages.length + facets.length + adhocHeroImages.length + conceptIdeas.length + viewpointImages.length === 0) {
            setNotice('Nothing usable in this group.');
            return undefined;
        }
        reportBusy(tier === 'pro' ? 'Generating with inspection…' : 'Generating…');
        setNotice('');
        try {
            const r = await weaveGenerate(
                { assets: boardAssets, elements: boardElements, fusionImages, adhocHeroImages, viewpointImages, viewpoint, conceptIdeas, facets, note, ratio, size, tier },
                reportBusy
            );
            rememberResult(r);
            setNotice('Generated.');
            return r;
        } catch (err: any) {
            setNotice(`${err instanceof BudgetExceededError ? err.message : err?.message || err}`);
        } finally { reportBusy(''); }
        return undefined;
    };

    const assignToOutput = (outputId: string, r: GenerationResult) =>
        setNodes(prev => prev.map(x => x.id === outputId ? { ...x, image: r.image.value, resultId: r.id } : x));

    const runOutput = async (o: WeaveNode) => {
        const comp = componentOf(o.id);
        if (comp.size <= 1) { setNotice('Drag a port line from your materials to this .first.'); return; }
        const r = await weaveNodes(nodes.filter(nn => comp.has(nn.id) && nn.id !== o.id), tierSel, text => setOutputStatus(o.id, text));
        if (r) assignToOutput(o.id, r);
    };

    const weave = async (tier: 'flash' | 'pro') => {
        const outputs = nodes.filter(nn => nn.kind === 'output');
        if (outputs.length === 0) {
            // No outputs yet → auto-create one to hold the result.
            const o = add({ kind: 'output' });
            const r = await weaveNodes(nodes, tier, text => setOutputStatus(o.id, text));
            if (r) assignToOutput(o.id, r);
            else remove(o.id);
            return;
        }
        for (const o of outputs) {
            const comp = componentOf(o.id);
            if (comp.size <= 1) continue;
            const r = await weaveNodes(nodes.filter(nn => comp.has(nn.id) && nn.id !== o.id), tier, text => setOutputStatus(o.id, text));
            if (r) assignToOutput(o.id, r);
        }
    };

    /** Promote a facet into a persistent brand rule — every future
     *  generation (Studio, Canvas, Quick) injects it automatically. */
    const facetToRule = async (nn: WeaveNode) => {
        if (!nn.dimension || !nn.description) return;
        const now = Date.now();
        const rule: KnowledgeRule = {
            id: crypto.randomUUID(),
            brandId: getCurrentBrandId(),
            scope: {},
            rule: `${nn.dimension.toUpperCase()}: ${nn.description}`,
            polarity: 'must',
            confidence: 1,
            sources: [],
            enabled: true,
            createdAt: now,
            updatedAt: now,
        };
        await storage.upsertRule(rule);
        setNotice(`Saved as a brand rule — future generations honor it (manage in Brain).`);
    };

    /** Solo-run one facet: spawn an output next to it. */
    const runFacet = async (f: WeaveNode) => {
        const r = await weaveNodes([f], 'flash');
        if (r) add({ kind: 'output', image: r.image.value, resultId: r.id }, { x: f.x + 150, y: f.y });
    };

    /** Rotate node inputs: images from directly-connected neighbors. */
    const rotateInputs = (rn: WeaveNode): string[] => {
        const neighborIds = edges
            .filter(e => e.from === rn.id || e.to === rn.id)
            .map(e => (e.from === rn.id ? e.to : e.from));
        const imgs: string[] = [];
        for (const id of neighborIds) {
            const nb = nodes.find(x => x.id === id);
            if (!nb) continue;
            if (nb.kind === 'image' || nb.kind === 'output' || nb.kind === 'rotate') imgs.push(...nodeImages(nb));
            if (nb.kind === 'hero') {
                const a = assets.find(x => x.id === nb.assetId);
                if (a) imgs.push(...a.photos.slice(0, 4).map(p => p.image.value));
            }
        }
        return imgs.slice(0, 8);
    };

    const runRotate = async (rn: WeaveNode, deg?: number) => {
        const angle = deg ?? rn.angle ?? 90;
        const pitch = rn.pitch ?? 0;
        if (rotateInputs(rn).length === 0) { setNotice('Connect an image or asset to the node first (its angles become the input).'); return; }
        setBusy(`Rotating to ${angle}°${pitch !== 0 ? ` / ${pitch > 0 ? '+' : ''}${pitch}°` : ''}…`);
        setNotice('');
        try {
            const sources = await gatherRotateSources(rn, angle);
            const r = await rotateView(sources.images, angle, { ratio, size, tier: tierSel, pitch, sourceAngles: sources.angles }, setBusy);
            rememberResult(r);
            setNodes(prev => prev.map(x => x.id === rn.id ? { ...x, image: r.image.value, resultId: r.id, angle } : x));
            setNotice(`${angle}° view rendered.`);
        } catch (err: any) { setNotice(`${err?.message || err}`); }
        setBusy('');
    };

    /** Full turntable: 8 views at 45° steps, laid out next to the node. */
    const run360 = async (rn: WeaveNode) => {
        if (rotateInputs(rn).length === 0) { setNotice('Connect an image or asset to the node first.'); return; }
        const frames: string[] = [];
        for (let i = 0; i < 8; i++) {
            const angle = i * 45;
            setBusy(`360° turntable — ${i + 1}/8 (${angle}°)…`);
            try {
                const sources = await gatherRotateSources(rn, angle);
                const r = await rotateView(sources.images, angle, { ratio, size, tier: 'flash', sourceAngles: sources.angles }, setBusy);
                rememberResult(r);
                frames.push(r.image.value);
                add({ kind: 'output', image: r.image.value, resultId: r.id },
                    { x: rn.x + 160 + (i % 4) * 215, y: rn.y + Math.floor(i / 4) * 215 });
            } catch (err: any) { setNotice(`${angle}°: ${err?.message || err}`); break; }
        }
        // Stash the frames on the node — they feed the spin-GIF export.
        if (frames.length >= 2) {
            setNodes(prev => prev.map(x => x.id === rn.id ? { ...x, images: frames } : x));
        }
        setBusy('');
        setNotice(frames.length >= 2
            ? `Turntable done — ${frames.length} views on the board. Press GIF on the node to export a spin animation.`
            : 'Turntable done — 8 views on the board.');
    };

    /** Encode the stored turntable frames into a looping spin GIF. */
    const exportSpinGif = async (rn: WeaveNode) => {
        const frames = rn.images ?? [];
        if (frames.length < 2) { setNotice('Run 360° first — its views become the GIF frames.'); return; }
        setBusy('Encoding spin GIF…');
        setNotice('');
        try {
            const blob = await encodeSpinGif(frames);
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `praxis-turntable-${rn.id.slice(0, 6)}.gif`;
            a.click();
            URL.revokeObjectURL(url);
            setNotice('Spin GIF downloaded.');
        } catch (err: any) { setNotice(`${err?.message || err}`); }
        setBusy('');
    };

    const saveResult = async (nn: WeaveNode) => {
        const r = nn.resultId ? resultsRef.current.get(nn.resultId) : undefined;
        if (!r) { setNotice('Result metadata not in this session — download instead.'); return; }
        await recordSignal(r, 'save');
        setNotice('Saved to Gallery.');
    };

    /** Save a canvas image into the Gallery as an adopted output. Uses the
     *  tracked generation recipe when we have it; otherwise a minimal one. */
    const saveToGallery = async (nn: WeaveNode) => {
        if (!nn.image) return;
        const tracked = nn.resultId ? resultsRef.current.get(nn.resultId) : undefined;
        const result: GenerationResult = tracked ?? {
            id: crypto.randomUUID(),
            brandId: getCurrentBrandId(),
            params: { outputType: 'scene', ratio: '1:1', modelTier: 'flash', note: nn.text ?? 'Canvas image' } as GenerationParams,
            assetIds: [],
            referenceIds: [],
            appliedRuleIds: [],
            fullPrompt: nn.text ?? '(canvas image without tracked recipe)',
            model: 'canvas',
            image: { kind: 'data', value: nn.image },
            estimatedCostUsd: 0,
            createdAt: Date.now(),
            adopted: false,
        };
        await recordSignal(result, 'save'); // persists it adopted + feeds learning
        setNotice('Saved to Gallery.');
    };

    const download = (nn: WeaveNode) => {
        if (!nn.image) return;
        const a = document.createElement('a');
        a.href = nn.image;
        a.download = `praxis-canvas-${nn.id.slice(0, 6)}.png`;
        a.click();
        const r = nn.resultId ? resultsRef.current.get(nn.resultId) : undefined;
        if (r) recordSignal(r, 'export');
    };

    /** Distill the creative approach of a generated output into knowledge rules. */
    const distillApproach = async (nn: WeaveNode) => {
        const r = nn.resultId ? resultsRef.current.get(nn.resultId) : undefined;
        if (!r) { setNotice('Result metadata not in this session.'); return; }

        // Build a summary of what was on the board for this output.
        const comp = componentOf(nn.id);
        const pool = nodes.filter(n => comp.has(n.id) && n.id !== nn.id);
        const lines: string[] = [];
        for (const n of pool) {
            if (n.kind === 'hero') {
                const pa = assets.find(x => x.id === n.assetId);
                lines.push(`Hero: "${pa?.name ?? 'unknown'}" (qty ${n.quantity ?? 1})`);
            } else if (n.kind === 'element') {
                const el = elements.find(x => x.id === n.elementId);
                lines.push(`Concept element: ${el?.concept ?? 'unknown'} — ${el?.description?.slice(0, 80) ?? ''}`);
            } else if (n.kind === 'image') {
                lines.push(`Image (${n.role ?? 'fusion'})${n.description ? ': ' + n.description.slice(0, 80) : ''}`);
            } else if (n.kind === 'facet') {
                lines.push(`Facet: ${n.dimension} — ${n.description?.slice(0, 80) ?? ''}`);
            } else if (n.kind === 'note' && n.text?.trim()) {
                lines.push(`Art direction: "${n.text.trim().slice(0, 120)}"`);
            } else if (n.kind === 'rotate') {
                lines.push(`Viewpoint: ${n.angle ?? 90}° azimuth, ${n.pitch ?? 0}° pitch`);
            }
        }
        const boardSummary = lines.join('\n') || '(minimal board — few nodes)';

        setBusy('Distilling approach...');
        setNotice('');
        try {
            const { rules, summary } = await distillWeaveApproach({ boardSummary, result: r });
            setNotice(`${rules.length} rules distilled: ${summary}`);
        } catch (err: any) {
            setNotice(`${err?.message || err}`);
        }
        setBusy('');
    };

    // --- workflow save / load / delete ---
    const saveConfig = async () => {
        const name = saveName.trim() || `Workflow ${configs.length + 1}`;
        const cfg: WeaveConfig = {
            id: crypto.randomUUID(), name,
            nodes: nodes.map(n => ({ ...n })),
            edges: edges.map(e => ({ ...e })),
            ratio, size, tier: tierSel,
            createdAt: Date.now(), updatedAt: Date.now(),
        };
        const next = [cfg, ...configs];
        await storage.kvSet(brandKey(CONFIGS_KEY), next);
        setConfigs(next);
        setShowSaveDialog(false);
        setSaveName('');
        setNotice(`Saved "${name}".`);
    };

    const loadConfig = (cfg: WeaveConfig) => {
        setNodes(cfg.nodes);
        setEdges(cfg.edges);
        setRatio(cfg.ratio);
        setSize(cfg.size);
        setTierSel(cfg.tier);
        setShowLoadMenu(false);
        setExpandedId(null);
        setNotice(`Loaded "${cfg.name}".`);
    };

    const deleteConfig = async (id: string) => {
        const next = configs.filter(c => c.id !== id);
        await storage.kvSet(brandKey(CONFIGS_KEY), next);
        setConfigs(next);
    };

    const assetOf = (id?: string) => assets.find(a => a.id === id);
    const elementOf = (id?: string) => elements.find(e => e.id === id);

    /** Click content → toggle the expanded action row (unless just dragged). */
    const toggleExpand = (id: string) => {
        if (drag.current?.moved) return;
        setExpandedId(prev => prev === id ? null : id);
    };

    const collapsedCountStyle: React.CSSProperties = {
        minWidth: 18,
        height: 18,
        borderRadius: 999,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(24,24,27,0.07)',
        color: '#71717a',
        fontSize: 9,
        letterSpacing: 0,
    };
    const collapsedChevronStyle: React.CSSProperties = {
        width: 19,
        height: 19,
        borderRadius: 999,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: '1px solid rgba(161,161,170,0.48)',
        background: 'rgba(255,255,255,0.64)',
        color: '#52525b',
        fontSize: 14,
        lineHeight: 1,
    };

    return (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 14px', boxSizing: 'border-box' }}>
            {(busy || notice) && (
                <div className={busy ? 'praxis-running' : undefined}
                    style={{
                        position: 'sticky', top: 8, zIndex: 30, fontSize: 12.5, fontWeight: 600,
                        padding: '8px 14px', borderRadius: 10,
                        background: busy ? '#f4f4f5' : notice.startsWith('Error') ? '#f4f4f5' : '#f7f7f8',
                        color: '#18181b',
                        border: '1px solid rgba(0,0,0,0.06)',
                    }}>
                    {busy ? `${busy}` : notice}
                </div>
            )}

            {/* Toolbar */}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <button style={S.btnGhost} onClick={() => fileRef.current?.click()}>Images</button>
                <button style={S.btnGhost} onClick={() => add({ kind: 'note', text: '' })}>Prompt</button>
                <button style={S.btnGhost} onClick={() => add({ kind: 'output' })}>Output</button>
                <button style={S.btnGhost} onClick={() => add({ kind: 'rotate', angle: 90 })} title="Turntable: connect a subject, render it from any angle or a full 360°">Rotate</button>
                <input ref={fileRef} type="file" multiple accept="image/*" style={{ display: 'none' }}
                    onChange={e => { addImages(e.target.files); e.currentTarget.value = ''; }} />
                <input ref={appendRef} type="file" multiple accept="image/*" style={{ display: 'none' }}
                    onChange={e => { appendAngles(e.target.files); e.currentTarget.value = ''; }} />
                <span style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <SegmentedControl
                        ariaLabel="Canvas ratio"
                        value={ratio}
                        onChange={setRatio}
                        options={RATIOS.map(r => ({ value: r, label: r }))}
                        minWidth={232}
                    />
                    <SegmentedControl
                        ariaLabel="Canvas pixel size"
                        value={size}
                        onChange={setSize}
                        options={SIZES.map(s => ({ value: s, label: s }))}
                        minWidth={132}
                    />
                    <SegmentedControl
                        ariaLabel="Canvas model"
                        value={tierSel}
                        onChange={setTierSel}
                        options={[
                            { value: 'flash', label: 'Flash', title: 'flash · $0.04' },
                            { value: 'pro', label: 'Pro', title: 'pro · $0.24 · consistency inspector' },
                        ]}
                        minWidth={132}
                    />
                    <button style={{ ...S.btn, fontWeight: 800 }} disabled={!!busy} onClick={() => weave(tierSel)}>Run</button>
                    <span style={{ width: 1, height: 18, background: '#e4e4e7', margin: '0 2px' }} />
                    <button style={S.btnGhost} onClick={() => { setShowSaveDialog(true); setSaveName(''); }} title="Save current canvas as a workflow">Save</button>
                    <button style={S.btnGhost} onClick={() => setShowLoadMenu(!showLoadMenu)} title="Load a saved workflow">
                        Load {configs.length > 0 && <span style={{ fontSize: 9, color: '#a1a1aa' }}>{configs.length}</span>}
                    </button>
                </span>
            </div>

            {/* Save dialog */}
            {showSaveDialog && (
                <div style={{ ...S.card, display: 'flex', gap: 8, alignItems: 'center', border: '1px solid #c9c9cf', background: 'rgba(255,255,255,0.82)' }}>
                    <span style={{ ...S.label, whiteSpace: 'nowrap' }}>SAVE WORKFLOW</span>
                    <input
                        value={saveName}
                        onChange={e => setSaveName(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') saveConfig(); if (e.key === 'Escape') setShowSaveDialog(false); }}
                        placeholder={`Workflow ${configs.length + 1}`}
                        autoFocus
                        style={{ flex: 1, border: '1px solid #e4e4e7', borderRadius: 6, padding: '4px 8px', fontSize: 11, outline: 'none' }}
                    />
                    <button style={{ ...S.btn, fontSize: 11 }} onClick={saveConfig}>Save</button>
                    <button style={{ ...S.btnGhost, fontSize: 11 }} onClick={() => setShowSaveDialog(false)}>Cancel</button>
                </div>
            )}

            {/* Load menu */}
            {showLoadMenu && (
                <div style={{ ...S.card, display: 'flex', flexDirection: 'column', gap: 6, border: '1.5px solid #d4d4d8', maxHeight: 220, overflow: 'auto' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={S.label}>SAVED WORKFLOWS</span>
                        <button style={S.btnGhost} onClick={() => setShowLoadMenu(false)}>Close</button>
                    </div>
                    {configs.length === 0 && <span style={{ fontSize: 11, color: '#a1a1aa' }}>No saved workflows yet.</span>}
                    {configs.map(cfg => (
                        <div key={cfg.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 6px', background: '#fafafa', borderRadius: 8 }}>
                            <button style={{ ...S.btnGhost, flex: 1, textAlign: 'left', fontSize: 11, fontWeight: 600 }} onClick={() => loadConfig(cfg)}>
                                {cfg.name}
                                <span style={{ fontSize: 9, color: '#a1a1aa', marginLeft: 6 }}>
                                    {cfg.nodes.length}n · {cfg.edges.length}e · {cfg.ratio} · {cfg.size} · {cfg.tier}
                                </span>
                            </button>
                            <button style={{ ...miniBtn, color: '#18181b', fontSize: 9 }} onClick={() => deleteConfig(cfg.id)}>✕</button>
                        </div>
                    ))}
                </div>
            )}

            <div style={{ flex: 1, minHeight: 0, display: 'flex', gap: 8 }}>
            {/* Infinite canvas — fills the whole viewport. Assets/Inspiration now come from the app sidebar. */}
            <DropZone onFiles={addImages} hint="Drop images — fusion sources" style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex' }}>
                <div ref={boardRef} onPointerDown={onBoardDown} onPointerMove={onMove} onPointerUp={onUp}
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
                            Add materials and prompts, drag port lines between nodes, wire groups into outputs, then Run — results appear inside the output node.
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
                            const mx = (l.x + W(l) + r2.x) / 2;
                            const my = (anchorY(l) + anchorY(r2)) / 2;
                            return (
                                <g key={e.id}>
                                    <path d={d} stroke="#a1a1aa" strokeWidth={1.6} fill="none" />
                                    <circle cx={l.x + W(l)} cy={anchorY(l)} r={4} fill="#fff" stroke="#a1a1aa" strokeWidth={1.5} />
                                    <circle cx={r2.x} cy={anchorY(r2)} r={4} fill="#fff" stroke="#a1a1aa" strokeWidth={1.5} />
                                    {/* Midpoint ✕ — always-visible disconnect handle */}
                                    <g style={{ pointerEvents: 'all', cursor: 'pointer' }}
                                        onPointerDown={ev => ev.stopPropagation()}
                                        onClick={ev => { ev.stopPropagation(); setEdges(prev => prev.filter(x => x.id !== e.id)); }}>
                                        <circle cx={mx} cy={my} r={9} fill="#fff" stroke="#a1a1aa" strokeWidth={1.3} />
                                        <text x={mx} y={my + 3.5} textAnchor="middle" fontSize={10} fontWeight={700} fill="#71717a">✕</text>
                                    </g>
                                </g>
                            );
                        })}
                        {linking && (() => {
                            const a = nodes.find(nn => nn.id === linking.from);
                            if (!a) return null;
                            return <path d={bezier(a.x + W(a), anchorY(a), linking.x, linking.y)}
                                stroke="#18181b" strokeWidth={1.8} fill="none" strokeDasharray="5 4" />;
                        })()}
                    </svg>
                    {facetPick && (
                        <div
                            ref={facetPopRef}
                            onPointerDown={e => e.stopPropagation()}
                            style={{
                                position: 'absolute', left: facetPick.near.x, top: facetPick.near.y, width: 216, zIndex: 30,
                                background: 'rgba(255,255,255,0.68)',
                                backdropFilter: 'blur(28px) saturate(1.25)', WebkitBackdropFilter: 'blur(28px) saturate(1.25)',
                                border: '1px solid #e4e4e7', borderRadius: 12,
                                boxShadow: '0 20px 25px -5px rgba(0,0,0,0.14), 0 8px 10px -6px rgba(0,0,0,0.12)',
                                padding: 8, boxSizing: 'border-box',
                                transformOrigin: 'top left',
                                animation: 'praxis-pop 240ms cubic-bezier(0.22,1,0.36,1)',
                            }}>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 2px 6px' }}>
                                <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: 0.8, textTransform: 'uppercase', color: '#71717a' }}>
                                    Extract · pick one
                                </span>
                                <button onClick={() => setFacetPick(null)} title="Close"
                                    style={{ border: 'none', background: 'none', color: '#a1a1aa', cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: 0 }}>×</button>
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
                                {FACET_DIMENSIONS.map(dim => (
                                    <button
                                        key={dim}
                                        disabled={!!busy}
                                        onClick={() => runExtract([dim])}
                                        title={FACET_HINTS[dim]}
                                        style={{ ...miniBtn, padding: '7px 0', textAlign: 'center', fontWeight: 800, letterSpacing: 0.4 }}>
                                        {dim.toUpperCase()}
                                    </button>
                                ))}
                            </div>
                            <button
                                disabled={!!busy}
                                onClick={() => runExtract([...FACET_DIMENSIONS])}
                                title="Decompose every dimension at once"
                                style={{ ...miniBtn, width: '100%', marginTop: 4, padding: '6px 0', textAlign: 'center', color: '#71717a' }}>
                                all 12
                            </button>
                        </div>
                    )}
                    {nodes.map(nn => {
                        const a = assetOf(nn.assetId);
                        const el = elementOf(nn.elementId);
                        const open = expandedId === nn.id || hoverId === nn.id;
                        const fixed = !!H(nn);
                        const outputBusyText = nn.kind === 'output' ? outputBusy[nn.id] : '';
                        return (
                            <div key={nn.id}
                                onPointerDown={e => {
                                    if (nn.kind === 'rotate') {
                                        // Rotate node body = orbit; move it via the ⠿ handle.
                                        e.stopPropagation();
                                        orbit.current = { id: nn.id, sx: e.clientX, sy: e.clientY, a0: nn.angle ?? 90, p0: nn.pitch ?? 0 };
                                        return;
                                    }
                                    onDown(e, nn);
                                }}
                                onPointerUp={e => { if (linking) { e.stopPropagation(); completeLink(nn.id); } }}
                                onMouseEnter={() => setHoverId(nn.id)}
                                onMouseLeave={() => setHoverId(prev => (prev === nn.id ? null : prev))}
                                style={{
                                    position: 'absolute', left: nn.x, top: nn.y, width: W(nn),
                                    ...(H(nn) ? { height: H(nn) } : {}),
                                    background: 'rgba(255,255,255,0.38)',
                                    backdropFilter: 'blur(18px) saturate(1.18)',
                                    WebkitBackdropFilter: 'blur(18px) saturate(1.18)',
                                    borderRadius: 12,
                                    border: linking?.from === nn.id ? '2px solid rgba(24,24,27,0.78)'
                                        : linking ? '2px dashed rgba(82,82,91,0.58)'
                                        : open ? '1px solid rgba(24,24,27,0.24)' : '1px solid rgba(212,212,216,0.36)',
                                    boxShadow: open ? '0 22px 42px rgba(0,0,0,0.14), inset 0 1px 0 rgba(255,255,255,0.42)' : '0 18px 34px rgba(0,0,0,0.08), inset 0 1px 0 rgba(255,255,255,0.34)',
                                    cursor: 'grab', userSelect: 'none', padding: 6, zIndex: open ? 5 : 1,
                                    boxSizing: 'border-box',
                                    color: '#18181b',
                                    display: 'flex',
                                    flexDirection: 'column',
                                    overflow: 'hidden',
                                }}>
                                {/* Resize handles — bottom corners avoid the delete button/title bar. */}
                                {(['sw', 'se'] as const).map(dir => {
                                    const fromLeft = dir.includes('w');
                                    const cursor = dir === 'se' ? 'nwse-resize' : 'nesw-resize';
                                    const glyph = dir === 'sw' ? '◣' : '◢';
                                    return (
                                        <div
                                            key={dir}
                                            onPointerDown={e => {
                                                e.stopPropagation();
                                                resizing.current = {
                                                    id: nn.id,
                                                    dir,
                                                    sx: e.clientX,
                                                    sy: e.clientY,
                                                    x0: nn.x,
                                                    y0: nn.y,
                                                    w0: W(nn),
                                                    h0: H(nn) ?? e.currentTarget.parentElement!.offsetHeight,
                                                };
                                            }}
                                            title="Drag to resize"
                                            style={{
                                                position: 'absolute',
                                                [fromLeft ? 'left' : 'right']: -8,
                                                bottom: -8,
                                                width: 34,
                                                height: 34,
                                                zIndex: 6,
                                                cursor,
                                                display: 'flex',
                                                alignItems: 'flex-end',
                                                justifyContent: fromLeft ? 'flex-start' : 'flex-end',
                                                color: '#a1a1aa',
                                                fontSize: 10,
                                                lineHeight: 1,
                                                padding: 4,
                                                userSelect: 'none',
                                                boxSizing: 'border-box',
                                            }}
                                        >
                                            {glyph}
                                        </div>
                                    );
                                })}
                                {/* Ports */}
                                {(['left', 'right'] as const).map(side => (
                                    <div key={side}
                                        onPointerDown={e => {
                                            e.stopPropagation();
                                            const w = toWorld(e.clientX, e.clientY);
                                            setLinking({ from: nn.id, x: w.x, y: w.y });
                                        }}
                                        onPointerUp={e => {
                                            if (!linking) return;
                                            e.stopPropagation();
                                            completeLink(nn.id);
                                        }}
                                        title="Drag from this side to link nodes"
                                        style={{
                                            position: 'absolute',
                                            [side]: -18,
                                            top: 18,
                                            width: 36,
                                            height: 72,
                                            cursor: 'crosshair',
                                            zIndex: 7,
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: side === 'left' ? 'flex-start' : 'flex-end',
                                            padding: side === 'left' ? '0 0 0 10px' : '0 10px 0 0',
                                            boxSizing: 'border-box',
                                        }}
                                        onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.18)'; }}
                                        onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                                    >
                                        <span
                                            style={{
                                                width: 13,
                                                height: 13,
                                                borderRadius: '50%',
                                                background: 'rgba(255,255,255,0.92)',
                                                border: '2px solid #a1a1aa',
                                                boxShadow: '0 6px 14px rgba(0,0,0,0.10)',
                                                boxSizing: 'border-box',
                                            }}
                                        />
                                    </div>
                                ))}

                                {/* Header — title + delete; dragging it moves any node (incl. rotate) */}
                                <div
                                    onPointerDown={e => { e.stopPropagation(); onDown(e, nn); }}
                                    onClick={() => toggleExpand(nn.id)}
                                    style={{
                                        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6,
                                        margin: '-6px -6px 6px', padding: '5px 10px',
                                        borderBottom: '1px solid rgba(228,228,231,0.34)',
                                        fontSize: 9, fontWeight: 800, letterSpacing: 0.8, textTransform: 'uppercase',
                                        color: '#71717a', cursor: 'grab',
                                        flex: '0 0 auto',
                                    }}>
                                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                        {nn.kind === 'hero' ? (a?.name || 'Asset')
                                            : nn.kind === 'element' ? 'Inspiration'
                                            : nn.kind === 'image' ? (nn.role === 'concept' ? 'Idea ref' : nn.role === 'hero' ? 'Asset ref' : 'Vibe ref')
                                            : nn.kind === 'note' ? 'Prompt'
                                            : nn.kind === 'facet' ? `Extract · ${nn.dimension ?? ''}`
                                            : nn.kind === 'rotate' ? 'Rotate'
                                            : 'Output'}
                                    </span>
                                    <button
                                        onPointerDown={e => e.stopPropagation()}
                                        onClick={e => { e.stopPropagation(); remove(nn.id); }}
                                        title="Delete node"
                                        style={{ border: 'none', background: 'none', color: '#a1a1aa', cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: 0 }}>
                                        ×
                                    </button>
                                </div>

                                {/* --- content (collapsed = content only, no buttons) --- */}
                                <div style={{
                                    flex: fixed ? '1 1 auto' : undefined,
                                    display: 'flex',
                                    flexDirection: 'column',
                                    minHeight: 0,
                                    overflow: 'hidden',
                                }}>
                                <div style={{
                                    flex: fixed ? '1 1 auto' : undefined,
                                    minHeight: 0,
                                    overflow: 'hidden',
                                    borderRadius: 8,
                                }}>
                                {nn.kind === 'hero' && a && (
                                    <div onClick={() => toggleExpand(nn.id)} style={{ height: fixed ? '100%' : undefined, overflow: 'hidden' }}>
                                        {a.photos[0] && <img src={a.photos[0].image.value} alt="" draggable={false}
                                            style={fitImage(fixed)} />}
                                        <div style={{ fontSize: 10, fontWeight: 700, marginTop: 3, display: fixed ? 'none' : undefined, color: '#3f3f46' }}>
                                            {a.name}
                                            {(nn.quantity ?? 1) > 1 && <span style={{ color: '#71717a', marginLeft: 4 }}>×{nn.quantity}</span>}
                                            <div
                                                title="This asset is the pixel truth: every generation reconstructs it exactly from these photos — geometry, materials, color, details. On Pro, the consistency inspector verifies the result and surgically corrects deviations."
                                                style={{ fontSize: 9, fontWeight: 600, color: '#a1a1aa', marginTop: 2, lineHeight: 1.35 }}>
                                                <span style={{ color: '#047857', fontWeight: 800 }}>✓</span> photo-exact — generations reproduce this asset faithfully
                                            </div>
                                        </div>
                                    </div>
                                )}
                                {nn.kind === 'element' && el && (
                                    <div onClick={() => toggleExpand(nn.id)}>
                                        <div style={{ fontSize: 9, fontWeight: 700, color: '#71717a' }}>{el.type.toUpperCase()}</div>
                                        <div style={{ fontSize: 11, fontWeight: 700, lineHeight: 1.3, color: '#18181b' }}>{el.concept}</div>
                                    </div>
                                )}
                                {nn.kind === 'image' && nn.image && (
                                    <div onClick={() => toggleExpand(nn.id)} style={{ height: fixed ? '100%' : undefined, overflow: 'hidden' }}>
                                        {nodeImages(nn).length > 1 ? (
                                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2, height: fixed ? '100%' : undefined }}>
                                                {nodeImages(nn).slice(0, 4).map((img, i) => (
                                                    <img key={i} src={img} alt="" draggable={false}
                                                        style={{ width: '100%', borderRadius: 6, display: 'block', minHeight: 0 }} />
                                                ))}
                                            </div>
                                        ) : (
                                            <img src={nn.image} alt="" draggable={false}
                                                style={fitImage(fixed)} />
                                        )}
                                        <div style={{ fontSize: 9, color: '#a1a1aa', marginTop: 2, display: fixed ? 'none' : undefined }}>
                                            {nn.role === 'hero' ? 'asset (exact)' : nn.role === 'concept' ? 'idea' : 'vibe'}
                                            {nodeImages(nn).length > 1 ? ` · ${nodeImages(nn).length} angles` : ''}
                                        </div>
                                    </div>
                                )}
                                {nn.kind === 'rotate' && (
                                    <div style={{ textAlign: 'center' }}>
                                        {nn.image && (
                                            <img src={nn.image} alt="" draggable={false}
                                                onClick={() => toggleExpand(nn.id)}
                                                style={fitImage(fixed, { marginBottom: fixed ? 0 : 4 })} />
                                        )}
                                        {/* 3D trackball — the WHOLE body orbits; click for actions */}
                                        <div
                                            onClick={() => toggleExpand(nn.id)}
                                            style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'move', touchAction: 'none', justifyContent: 'center', padding: '2px 0', ...(nn.image ? {} : { aspectRatio: '1', flexDirection: 'column' as const }) }}>
                                            <Ball az={nn.angle ?? 90} pi={nn.pitch ?? 0} size={nn.image ? 44 : 150} />
                                            <div style={{ textAlign: nn.image ? 'left' : 'center' }}>
                                                <div style={{ fontSize: 12, fontWeight: 800, color: '#18181b' }}>{nn.angle ?? 90}°</div>
                                                <div style={{ fontSize: 10, fontWeight: 700, color: '#71717a' }}>{(nn.pitch ?? 0) > 0 ? '+' : ''}{nn.pitch ?? 0}°</div>
                                            </div>
                                        </div>
                                        <div style={{ fontSize: 9, color: '#71717a', marginTop: 2 }}>
                                            drag anywhere to orbit · {rotateInputs(nn).length} input img
                                        </div>
                                    </div>
                                )}
                                {nn.kind === 'facet' && (
                                    <div onClick={() => toggleExpand(nn.id)}>
                                        {nn.image && <img src={nn.image} alt="" draggable={false}
                                            onClick={e => { e.stopPropagation(); openLightbox(nn.image!); }}
                                            style={{ width: '100%', borderRadius: 8, display: 'block', cursor: 'zoom-in' }} />}
                                        <div style={{ fontSize: 10, fontWeight: 800, color: '#18181b', marginTop: 4 }}>{nn.dimension?.toUpperCase()}</div>
                                        <div style={{ fontSize: 9, color: '#71717a', marginTop: 2, lineHeight: 1.4, display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{nn.description}</div>
                                    </div>
                                )}
                                {nn.kind === 'note' && (
                                    <textarea
                                        value={nn.text ?? ''}
                                        placeholder="type your prompt…"
                                        onChange={e => setNodes(prev => prev.map(x => x.id === nn.id ? { ...x, text: e.target.value } : x))}
                                        onPointerDown={e => e.stopPropagation()}
                                        onClick={() => setExpandedId(nn.id)}
                                        style={{ width: '100%', minHeight: 64, height: H(nn) ? 'calc(100% - 4px)' : undefined, border: '1px solid rgba(212,212,216,0.40)', outline: 'none', resize: 'none', fontSize: 11, lineHeight: 1.5, fontFamily: 'inherit', background: 'rgba(244,244,245,0.28)', color: '#18181b', borderRadius: 8, padding: 10, boxSizing: 'border-box', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.36)' }}
                                    />
                                )}
                                {nn.kind === 'output' && (
                                    <div onClick={() => toggleExpand(nn.id)} style={{ height: fixed ? '100%' : undefined, textAlign: 'center', paddingTop: nn.image ? 0 : 10 }}>
                                        {outputBusyText ? (
                                            <div
                                                className="praxis-running praxis-running-card"
                                                style={{
                                                    background: 'rgba(244,244,245,0.42)',
                                                    border: '1px solid rgba(212,212,216,0.46)',
                                                    borderRadius: 8,
                                                    aspectRatio: '1',
                                                    display: 'flex',
                                                    flexDirection: 'column',
                                                    alignItems: 'center',
                                                    justifyContent: 'center',
                                                    gap: 10,
                                                    padding: 14,
                                                    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.42)',
                                                }}
                                            >
                                                <span className="praxis-busy-dot" />
                                                <span style={{ fontSize: 13, fontWeight: 850, color: '#18181b' }}>Generating</span>
                                                <span style={{ maxWidth: 190, fontSize: 9.5, lineHeight: 1.35, color: '#71717a' }}>
                                                    {outputBusyText}
                                                </span>
                                            </div>
                                        ) : nn.image ? (
                                            <img src={nn.image} alt="" draggable={false}
                                                style={fitImage(fixed, { borderRadius: 9 })} />
                                        ) : (
                                            <div style={{ background: 'rgba(244,244,245,0.28)', border: '1px solid rgba(212,212,216,0.40)', borderRadius: 8, aspectRatio: '1', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.36)' }}>
                                                <div style={{ fontSize: 13, fontWeight: 800, color: '#71717a' }}>OUTPUT</div>
                                                <div style={{ fontSize: 9, color: '#a1a1aa', marginTop: 3 }}>
                                                    {Math.max(0, componentOf(nn.id).size - 1)} linked · click for Run
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                )}
                                </div>

                                {/* --- action row — hover/click reveals it with a silky slide --- */}
                                    <div onPointerDown={e => e.stopPropagation()}
                                        style={{
                                            flex: '0 0 auto',
                                            display: 'flex',
                                            gap: 3,
                                            flexWrap: 'wrap',
                                            marginTop: open ? 5 : 0,
                                            maxHeight: open ? (fixed ? 58 : 340) : 0,
                                            overflow: open && fixed ? 'auto' : 'hidden',
                                            opacity: open ? 1 : 0,
                                            transform: open ? 'translateY(0)' : 'translateY(-5px)',
                                            pointerEvents: open ? 'auto' : 'none',
                                            transition: 'max-height 280ms cubic-bezier(0.22,1,0.36,1), opacity 170ms ease, transform 280ms cubic-bezier(0.22,1,0.36,1), margin-top 280ms cubic-bezier(0.22,1,0.36,1)',
                                            borderRadius: 8,
                                            padding: open && fixed ? 4 : 0,
                                        }}>
                                        {nn.kind === 'output' && (
                                            <>
                                                <button style={{ ...miniBtn, background: '#18181b', color: '#fff', border: '1px solid #18181b' }} disabled={!!busy || !!outputBusy[nn.id]} onClick={() => runOutput(nn)}>Run</button>
                                                {nn.image && <>
                                                    <button style={miniBtn} onClick={() => add({ kind: 'image', image: nn.image!, role: 'fusion' }, { x: nn.x + W(nn) + 30, y: nn.y })}>Vibe</button>
                                                    <button style={miniBtn} onClick={() => add({ kind: 'image', image: nn.image!, role: 'concept' }, { x: nn.x + W(nn) + 30, y: nn.y + 40 })}>Idea</button>
                                                    <button style={miniBtn} disabled={!!busy} onClick={() => decomposeNode(nn)}>Extract</button>
                                                    <button style={miniBtn} disabled={!!busy} onClick={() => imageToPrompt(nn)}>Prompt</button>
                                                    <button style={miniBtn} onClick={() => openLightbox(nn.image!)}>View</button>
                                                    <button style={miniBtn} disabled={!!busy} onClick={() => saveToGallery(nn)} title="Save to Gallery (adopted output)">Save</button>
                                                    <button style={miniBtn} onClick={() => download(nn)} title="Download the file">↓</button>
                                                    <span style={{ flexBasis: '100%', display: 'flex', gap: 3, alignItems: 'center', flexWrap: 'wrap', marginTop: 2 }}>
                                                        <span style={{ fontSize: 9, fontWeight: 800, color: '#71717a' }}>→ ASSET:</span>
                                                        {SUBJECT_TYPES.map(t => (
                                                            <button key={t} style={miniBtn} disabled={!!busy}
                                                                onClick={() => saveNodeAsAsset(nn, t)}
                                                                title={`Save this generated image into the Assets library as ${t}`}>
                                                                {t}
                                                            </button>
                                                        ))}
                                                    </span>
                                                    <button style={{ ...miniBtn, background: '#18181b', color: '#fff', border: '1px solid #18181b' }} disabled={!!busy}
                                                        onClick={() => distillApproach(nn)}
                                                        title="Extract the creative approach into reusable knowledge rules">Distill</button>
                                                </>}
                                            </>
                                        )}
                                        {nn.kind === 'image' && (
                                            <>
                                                {(['fusion', 'concept'] as const).map(role => (
                                                    <button key={role} style={{ ...miniBtn, background: (nn.role ?? 'fusion') === role ? 'rgba(24,24,27,0.94)' : 'rgba(255,255,255,0.38)', color: (nn.role ?? 'fusion') === role ? '#fff' : '#3f3f46', border: (nn.role ?? 'fusion') === role ? '1px solid rgba(24,24,27,0.94)' : '1px solid rgba(212,212,216,0.42)' }}
                                                        disabled={!!busy} onClick={() => setRole(nn, role)}
                                                        title={role === 'fusion'
                                                            ? "Vibe: blend this image's overall look — light, palette, material, mood — into the result. Never copies its objects."
                                                            : 'Idea: distill this image into one transferable idea and apply just that — the narrowest, most controlled influence.'}>
                                                        {role === 'fusion' ? 'Vibe' : 'Idea'}
                                                    </button>
                                                ))}
                                                <button style={miniBtn} disabled={!!busy} onClick={() => decomposeNode(nn)}
                                                    title="Extract: split this image into light / palette / composition / material / texture / mood / space — then borrow ONLY the dimensions you pick">Extract</button>
                                                <button style={miniBtn} disabled={!!busy} onClick={() => imageToPrompt(nn)}>Prompt</button>
                                                <button style={miniBtn} onClick={() => openLightbox(nn.image!)}>View</button>
                                                <button style={miniBtn} disabled={!!busy} onClick={() => saveToGallery(nn)} title="Save to Gallery (adopted output)">Save</button>
                                                    <button style={miniBtn} onClick={() => download(nn)} title="Download the file">↓</button>
                                                <span style={{ flexBasis: '100%', display: 'flex', gap: 3, alignItems: 'center', flexWrap: 'wrap', marginTop: 2 }}>
                                                    <span style={{ fontSize: 9, fontWeight: 800, color: '#71717a' }}>→ ASSET:</span>
                                                    {SUBJECT_TYPES.map(t => (
                                                        <button key={t} style={miniBtn} disabled={!!busy}
                                                            onClick={() => saveNodeAsAsset(nn, t)}
                                                            title={`Save this image (all merged angles) into the Assets library as ${t} — the node becomes a library asset`}>
                                                            {t}
                                                        </button>
                                                    ))}
                                                </span>
                                            </>
                                        )}
                                        {nn.kind === 'rotate' && (
                                            <>
                                                <button style={{ ...miniBtn, background: '#18181b', color: '#fff', border: '1px solid #18181b' }} disabled={!!busy} onClick={() => runRotate(nn)}>Render {nn.angle ?? 90}°</button>
                                                <button style={miniBtn} disabled={!!busy} onClick={() => run360(nn)} title="8 views at 45° steps (flash) — laid out on the board">360°</button>
                                                <button style={miniBtn} disabled={!!busy || (nn.images?.length ?? 0) < 2} onClick={() => exportSpinGif(nn)} title="Encode the turntable views into a looping spin GIF (client-side, free)">GIF</button>
                                                {nn.image && <>
                                                    <button style={miniBtn} disabled={!!busy} onClick={() => saveToGallery(nn)} title="Save to Gallery (adopted output)">Save</button>
                                                    <button style={miniBtn} onClick={() => download(nn)} title="Download the file">↓</button>
                                                    <button style={miniBtn} disabled={!!busy} onClick={() => saveResult(nn)}>Gallery</button>
                                                    <button style={miniBtn} onClick={() => openLightbox(nn.image!)}>View</button>
                                                </>}
                                            </>
                                        )}
                                        {nn.kind === 'facet' && (
                                            <>
                                                <button style={miniBtn} disabled={!!busy} onClick={() => runFacet(nn)}>solo (flash)</button>
                                                <button style={{ ...miniBtn, background: '#18181b', color: '#fff', border: '1px solid #18181b' }} disabled={!!busy}
                                                    onClick={() => facetToRule(nn)}
                                                    title="Save this dimension as a permanent brand rule — every future generation will honor it (toggle/delete in Brain)">→ Rule</button>
                                            </>
                                        )}
                                        {nn.kind === 'hero' && (
                                            <>
                                                <span style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                                                    <span style={{ fontSize: 9, fontWeight: 700, color: '#71717a' }}>QTY</span>
                                                    <button style={miniBtn} onClick={() => setNodes(prev => prev.map(x => x.id === nn.id ? { ...x, quantity: Math.max(1, (x.quantity ?? 1) - 1) } : x))}>−</button>
                                                    <span style={{ fontSize: 10, fontWeight: 800, minWidth: 14, textAlign: 'center' }}>{nn.quantity ?? 1}</span>
                                                    <button style={miniBtn} onClick={() => setNodes(prev => prev.map(x => x.id === nn.id ? { ...x, quantity: Math.min(10, (x.quantity ?? 1) + 1) } : x))}>+</button>
                                                </span>
                                                {a && <>
                                                    <button style={miniBtn} disabled={!!busy} onClick={() => assetToImage(nn, a, 'fusion')}
                                                        title="Spin off a Vibe reference: blend this asset photo's overall look into generations">Vibe</button>
                                                    <button style={miniBtn} disabled={!!busy} onClick={() => assetToImage(nn, a, 'concept')}
                                                        title="Spin off an Idea reference: distill this asset photo into one transferable idea">Idea</button>
                                                    <button style={miniBtn} disabled={!!busy}
                                                        onClick={() => decomposeImage(a.photos[0]?.image.value, { x: nn.x + W(nn) + 40, y: nn.y })}
                                                        title="Extract: split this asset photo into light / palette / composition / material / texture / mood / space">Extract</button>
                                                    <button style={miniBtn} disabled={!!busy}
                                                        onClick={() => imageToPromptAt(a.photos[0]?.image.value, { x: nn.x + W(nn) + 30, y: nn.y + 40 })}
                                                        title="Reverse-engineer a generation prompt from this asset photo">Prompt</button>
                                                </>}
                                                <button style={miniBtn} disabled={!!busy}
                                                    onClick={() => { if (a) { appendTarget.current = a; appendRef.current?.click(); } }}
                                                    title="Upload more photos of this asset from other angles — they persist on the asset and feed rotate + fidelity">Add angles</button>
                                                {a && a.photos.length > 1 && <span style={{ fontSize: 9, color: '#a1a1aa', alignSelf: 'center' }}>{a.photos.length} angles</span>}
                                                {a?.photos[0] && <button style={miniBtn} onClick={() => openLightbox(a.photos[0].image.value)}>View</button>}
                                                {a && a.photos.length > 1 && (
                                                    <div style={{ flexBasis: '100%', display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 4, paddingTop: 2 }}>
                                                        {a.photos.map(p => (
                                                            <div key={p.id} style={{ position: 'relative', width: 56, height: 56 }}>
                                                                <img src={p.image.value} alt="" draggable={false}
                                                                    onClick={() => openLightbox(p.image.value)}
                                                                    style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 6, display: 'block', cursor: 'zoom-in' }} />
                                                                <button
                                                                    onClick={() => removeAssetPhoto(a, p.id)}
                                                                    disabled={!!busy}
                                                                    title="Remove this angle from the asset"
                                                                    style={{ position: 'absolute', top: -6, right: -6, width: 18, height: 18, borderRadius: 999, border: 'none', background: 'rgba(24,24,27,0.85)', color: '#fff', fontSize: 10, lineHeight: 1, cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✕</button>
                                                            </div>
                                                        ))}
                                                    </div>
                                                )}
                                            </>
                                        )}
                                        {nn.kind === 'element' && el && (
                                            <span style={{ fontSize: 9, color: '#71717a', flexBasis: '100%' }}>{el.description}</span>
                                        )}
                                        {nn.kind === 'note' && nn.text?.trim() && (
                                            <button style={{ ...miniBtn, background: '#18181b', color: '#fff', border: '1px solid #18181b' }} disabled={!!busy}
                                                onClick={() => analyzeConnected(nn)}
                                                title="Analyze connected image per this instruction → generate a prompt">
                                                Analyze / Prompt
                                            </button>
                                        )}
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                    </div>
                </div>
            </DropZone>
            </div>
        </div>
    );
});

export default WeaveView;
