import React, { useCallback, useEffect, useRef, useState } from 'react';
import StudioView, { StudioViewHandle } from './ui/StudioView';
import { Caret, Select } from './ui/controls';
import WeaveView, { WeaveViewHandle } from './ui/WeaveView';
import GalleryView from './ui/GalleryView';
import HeroView from './ui/HeroView';
import LibraryView from './ui/LibraryView';
import KnowledgeView from './ui/KnowledgeView';
import SystemView from './ui/SystemView';
import { S } from './ui/styles';
import { LightboxHost } from './ui/lightbox';
import { Asset, Brand, PraxisJob, Reference } from './domain/types';
import { storage } from './storage/local';
import {
    listBrands, getCurrentBrandId, setCurrentBrandId, createBrand,
} from './domain/brand';

type Tab = 'studio' | 'weave' | 'gallery' | 'heroes' | 'library' | 'knowledge' | 'system';

const TABS: Array<{ id: Tab; label: string; meta: string }> = [
    { id: 'studio', label: 'New Task', meta: 'workflow' },
    { id: 'weave', label: 'Canvas', meta: 'board' },
    { id: 'gallery', label: 'Gallery', meta: 'outputs' },
    { id: 'heroes', label: 'Assets', meta: 'truth' },
    { id: 'library', label: 'Inspiration', meta: 'references' },
    { id: 'knowledge', label: 'Brand', meta: 'memory' },
    { id: 'system', label: 'System', meta: 'settings' },
];

export default function App() {
    const studioRef = useRef<StudioViewHandle>(null);
    const weaveRef = useRef<WeaveViewHandle>(null);
    const [tab, setTab] = useState<Tab>('studio');

    useEffect(() => {
        storage.listJobs(20).then(setJobs).catch(() => {});
    }, []);

    useEffect(() => {
        if (tab !== 'studio' || !pendingResume.current) return;
        const j = pendingResume.current;
        const t = window.setTimeout(() => {
            pendingResume.current = null;
            studioRef.current?.resume(j);
        }, 40);
        return () => window.clearTimeout(t);
    }, [tab]);

    const handleJobsChange = useCallback((js: PraxisJob[], active: string | null) => {
        setJobs(js.slice(0, 20));
        setActiveJobId(active);
    }, []);

    const jobName = (j: PraxisJob) =>
        (j.title ?? '').trim() || (j.brief.trim() ? j.brief.slice(0, 34) : 'Open exploration');

    const renameJob = async (j: PraxisJob) => {
        const name = window.prompt('Task name:', jobName(j));
        if (name === null) return;
        const next: PraxisJob = { ...j, title: name.trim() || undefined, updatedAt: Date.now() };
        await storage.upsertJob(next);
        setJobs(prev => prev.map(x => (x.id === j.id ? next : x)));
    };

    /** Open a past task — resumes in place, or after switching to the Studio tab. */
    const openJob = (j: PraxisJob) => {
        if (pendingResume.current) return;
        setActiveJobId(j.id);
        if (studioRef.current) {
            setTab('studio');
            studioRef.current.resume(j);
        } else {
            pendingResume.current = j;
            setTab('studio');
        }
    };
    const [brands, setBrands] = useState<Brand[]>([]);
    const [brandId, setBrandId] = useState(getCurrentBrandId());
    const [isNarrow, setIsNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < 760);
    const [assets, setAssets] = useState<Asset[]>([]);
    const [refs, setRefs] = useState<Reference[]>([]);
    const [selectedAssets, setSelectedAssets] = useState<Set<string>>(new Set());
    const [selectedRefs, setSelectedRefs] = useState<Set<string>>(new Set());
    const [jobs, setJobs] = useState<PraxisJob[]>([]);
    const [tasksOpen, setTasksOpen] = useState(true);
    const [activeJobId, setActiveJobId] = useState<string | null>(null);
    const pendingResume = useRef<PraxisJob | null>(null);
    const [assetsOpen, setAssetsOpen] = useState(true);
    const [inspOpen, setInspOpen] = useState(false);
    const [sidebarWidth, setSidebarWidth] = useState(264);

    useEffect(() => { listBrands().then(setBrands); }, []);
    const refreshSources = useCallback(() => {
        storage.listAssets().then(setAssets);
        storage.listReferences()
            .then(rs => setRefs(rs.filter(r => r?.image?.kind === 'data' && r.kind !== 'plate')))
            .catch(err => console.warn('[app] refs load failed:', err));
    }, []);

    useEffect(() => { refreshSources(); }, [refreshSources, tab]);
    useEffect(() => {
        const onResize = () => setIsNarrow(window.innerWidth < 760);
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, []);

    const toggleAsset = (id: string) => setSelectedAssets(prev => {
        const next = new Set(prev);
        next.has(id) ? next.delete(id) : next.add(id);
        return next;
    });

    const toggleRef = (id: string) => setSelectedRefs(prev => {
        const next = new Set(prev);
        next.has(id) ? next.delete(id) : next.add(id);
        return next;
    });

    const switchBrand = (id: string) => {
        if (id === '__new__') {
            const name = window.prompt('New brand name:')?.trim();
            if (!name) return;
            const description = window.prompt('One line — category + positioning (drives every prompt):')?.trim() ?? '';
            const essence = window.prompt('Asset fidelity essentials (what must never change):')?.trim() ?? '';
            createBrand(name, description, essence).then(b => {
                setCurrentBrandId(b.id);
                window.location.reload();
            });
            return;
        }
        if (!window.confirm('Switch brand? The app reloads — anything unsaved (canvas layouts, running jobs, drafts) is lost.')) return;
        setCurrentBrandId(id);
        setBrandId(id);
        window.location.reload(); // simplest correctness: every view reloads its brand's data
    };

    const startSidebarResize = (event: React.MouseEvent<HTMLDivElement>) => {
        if (isNarrow) return;
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = sidebarWidth;
        const onMove = (moveEvent: MouseEvent) => {
            const next = Math.min(420, Math.max(212, startWidth + moveEvent.clientX - startX));
            setSidebarWidth(next);
        };
        const onUp = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    };

    return (
        <div style={{ ...S.page, ...(isNarrow ? { flexDirection: 'column' as const } : {}) }}>
            <LightboxHost />
            <style>{`
                * { box-sizing: border-box; }
                button {
                    transition: transform .18s cubic-bezier(.22,1,.36,1), box-shadow .18s cubic-bezier(.22,1,.36,1),
                        filter .15s ease, opacity .15s ease, background .15s ease, color .15s ease, border-color .15s ease;
                    font-family: inherit;
                    line-height: 1;
                    white-space: nowrap;
                    will-change: transform;
                }
                button:not(:disabled):hover {
                    transform: translateY(-1px);
                    filter: brightness(1.05);
                    box-shadow: 0 3px 10px rgba(0,0,0,.10);
                }
                button:not(:disabled):active {
                    transform: translateY(0) scale(.96);
                    filter: brightness(.97);
                    box-shadow: none;
                    transition-duration: .07s;
                }
                button:focus-visible, select:focus-visible, input:focus-visible, textarea:focus-visible {
                    outline: 2px solid rgba(24, 24, 27, 0.62);
                    outline-offset: 2px;
                }
                button:disabled { cursor: progress; }
                input, select, textarea { font-family: inherit; }
                @keyframes praxis-pulse { 0%,100% { opacity: 1; } 50% { opacity: .55; } }
                @keyframes praxis-pop {
                    from { opacity: 0; transform: scale(.92) translateY(5px); }
                    to { opacity: 1; transform: scale(1) translateY(0); }
                }
                @keyframes praxis-busy-float {
                    0%, 100% { transform: translateY(0); box-shadow: 0 10px 28px rgba(15,23,42,.08), inset 0 1px 0 rgba(255,255,255,.72); }
                    50% { transform: translateY(-1px); box-shadow: 0 16px 38px rgba(15,23,42,.12), inset 0 1px 0 rgba(255,255,255,.86); }
                }
                @keyframes praxis-busy-sheen {
                    from { transform: translateX(-120%) skewX(-18deg); opacity: 0; }
                    18% { opacity: .72; }
                    52% { opacity: .28; }
                    to { transform: translateX(180%) skewX(-18deg); opacity: 0; }
                }
                @keyframes praxis-busy-dot {
                    0%, 80%, 100% { transform: translateY(0) scale(.72); opacity: .42; }
                    40% { transform: translateY(-3px) scale(1); opacity: 1; }
                }
                @keyframes praxis-busy-ring {
                    from { transform: rotate(0deg); }
                    to { transform: rotate(360deg); }
                }
                .praxis-running {
                    position: relative;
                    overflow: hidden;
                    animation: praxis-busy-float 1.8s cubic-bezier(.22,1,.36,1) infinite;
                    isolation: isolate;
                }
                .praxis-running::before {
                    content: "";
                    width: 9px;
                    height: 9px;
                    margin-right: 8px;
                    border-radius: 999px;
                    border: 1.5px solid rgba(24,24,27,.18);
                    border-top-color: rgba(24,24,27,.82);
                    display: inline-block;
                    vertical-align: -1px;
                    animation: praxis-busy-ring .9s linear infinite;
                }
                .praxis-running-card::before { display: none; }
                .praxis-running::after {
                    content: "";
                    position: absolute;
                    inset: -35% auto -35% -28%;
                    width: 42%;
                    background: linear-gradient(90deg, transparent, rgba(255,255,255,.72), transparent);
                    filter: blur(.5px);
                    animation: praxis-busy-sheen 2.2s cubic-bezier(.22,1,.36,1) infinite;
                    pointer-events: none;
                    z-index: -1;
                }
                .praxis-busy-dot {
                    width: 14px;
                    height: 14px;
                    border-radius: 999px;
                    border: 1.5px solid rgba(24,24,27,.18);
                    border-top-color: rgba(24,24,27,.86);
                    display: inline-block;
                    animation: praxis-busy-ring .9s linear infinite;
                    flex: 0 0 auto;
                }
                .praxis-busy-dots {
                    display: inline-flex;
                    align-items: center;
                    gap: 3px;
                }
                .praxis-busy-dots span {
                    width: 4px;
                    height: 4px;
                    border-radius: 999px;
                    background: currentColor;
                    animation: praxis-busy-dot 1.05s ease-in-out infinite;
                }
                .praxis-busy-dots span:nth-child(2) { animation-delay: .12s; }
                .praxis-busy-dots span:nth-child(3) { animation-delay: .24s; }
                @media (prefers-reduced-motion: reduce) {
                    button, .praxis-running, .praxis-running::after, .praxis-busy-dot, .praxis-busy-dots span {
                        animation: none !important;
                        transition: none !important;
                    }
                }
                .praxis-sidebar button:not(:disabled):hover {
                    transform: none;
                    filter: none;
                    box-shadow: none;
                }
                .praxis-sidebar-item {
                    transition: background .15s ease, border-color .15s ease, color .15s ease;
                }
                .praxis-sidebar-item:hover {
                    background: #f7f7f8 !important;
                    border-color: #e2e3e7 !important;
                    color: #111113 !important;
                }
                .praxis-sidebar-tools {
                    opacity: 0;
                    pointer-events: none;
                    transition: opacity .15s ease;
                }
                .praxis-sidebar-item:hover .praxis-sidebar-tools,
                .praxis-sidebar-item:focus-within .praxis-sidebar-tools {
                    opacity: 1;
                    pointer-events: auto;
                }
            `}</style>
            <aside style={{
                ...S.sidebar,
                width: isNarrow ? '100%' : sidebarWidth,
                gap: 10,
                padding: 12,
                borderRight: '1px solid #e6e7eb',
                background: 'rgba(255,255,255,0.96)',
                backdropFilter: 'blur(22px) saturate(1.15)',
                WebkitBackdropFilter: 'blur(22px) saturate(1.15)',
                color: '#18181b',
                ...(isNarrow ? {
                    width: '100%',
                    maxHeight: 226,
                    borderRight: 'none',
                    borderBottom: '1px solid #e6e7eb',
                    overflow: 'auto',
                } : {}),
            }} className="praxis-sidebar">
                <div style={{ ...S.brandBlock, ...(isNarrow ? { paddingBottom: 0 } : {}) }}>
                    <span style={{ ...S.brand, color: '#18181b' }}>Praxis</span>
                    <span style={{ ...S.brandSubtle, color: '#7b8190' }}>AI design studio</span>
                </div>
                <nav style={{
                    ...S.nav,
                    ...(isNarrow ? {
                        flexDirection: 'row' as const,
                        overflowX: 'auto',
                        paddingBottom: 4,
                    } : {}),
                }}>
                {TABS.map(t => {
                    if (t.id === 'studio') {
                        return (
                            <button key={t.id} className="praxis-sidebar-item" onClick={() => {
                                setTab('studio');
                                studioRef.current?.reset();
                            }} style={{
                                ...S.tab,
                                ...(isNarrow ? { minWidth: 132, width: 'auto' } : {}),
                                ...(tab === t.id ? {
                                    background: '#f0f1f3',
                                    color: '#111113',
                                    border: '1px solid #e2e3e7',
                                    boxShadow: 'none',
                                } : {
                                    color: '#3f3f46',
                                }),
                            }}>
                                <span style={{ flex: 1 }}>{t.label}</span>
                            </button>
                        );
                    }

                    const isAssets = t.id === 'heroes';
                    const isInspiration = t.id === 'library';
                    if (!isAssets && !isInspiration) {
                        return (
                            <button key={t.id} className="praxis-sidebar-item" onClick={() => setTab(t.id)} style={{
                                ...S.tab,
                                ...(isNarrow ? { minWidth: 132, width: 'auto' } : {}),
                                ...(tab === t.id ? {
                                    background: '#f0f1f3',
                                    color: '#111113',
                                    border: '1px solid #e2e3e7',
                                    boxShadow: 'none',
                                } : {
                                    color: '#3f3f46',
                                }),
                            }}>
                                <span style={{ flex: 1 }}>{t.label}</span>
                            </button>
                        );
                    }

                    const open = isAssets ? assetsOpen : inspOpen;
                    const setOpen = isAssets ? setAssetsOpen : setInspOpen;
                    const items = isAssets ? assets : refs;

                    return (
                        <div key={t.id} style={{ display: 'flex', flexDirection: 'column', gap: 4, ...(isNarrow ? { minWidth: 184 } : {}) }}>
                            <div className="praxis-sidebar-item" style={{
                                ...S.tab,
                                ...(tab === t.id ? {
                                    background: '#f0f1f3',
                                    color: '#111113',
                                    border: '1px solid #e2e3e7',
                                    boxShadow: 'none',
                                } : {
                                    color: '#3f3f46',
                                }),
                                padding: '0 8px 0 10px',
                            }}>
                                <button
                                    type="button"
                                    onClick={() => setOpen(v => !v)}
                                    aria-label={`${open ? 'Collapse' : 'Expand'} ${t.label}`}
                                    title={`${open ? 'Collapse' : 'Expand'} ${t.label}`}
                                    style={{ flex: 1, minWidth: 0, height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'flex-start', gap: 6, border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', padding: 0, font: 'inherit', textAlign: 'left' }}
                                >
                                    <span>{t.label}</span>
                                </button>
                                <div className="praxis-sidebar-tools" style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                                    <button
                                        type="button"
                                        onClick={() => setOpen(v => !v)}
                                        aria-label={`${open ? 'Collapse' : 'Expand'} ${t.label}`}
                                        title={`${open ? 'Collapse' : 'Expand'} ${t.label}`}
                                        style={{ width: 22, height: 22, display: 'grid', placeItems: 'center', border: 'none', background: 'transparent', color: '#71717a', cursor: 'pointer', padding: 0, borderRadius: 6 }}
                                    >
                                        <Caret open={open} size={13} />
                                    </button>
                                    <button
                                        type="button"
                                        aria-label={`Open ${t.label} editor`}
                                        title={`Open ${t.label} editor`}
                                        onClick={() => setTab(t.id)}
                                        style={{ width: 22, height: 22, display: 'grid', placeItems: 'center', border: 'none', background: 'transparent', color: tab === t.id ? '#18181b' : '#71717a', cursor: 'pointer', padding: 0, borderRadius: 6, fontSize: 14 }}
                                    >
                                        ✎
                                    </button>
                                </div>
                            </div>
                            {open && !isNarrow && (
                                <div style={{
                                    display: 'grid',
                                    gridTemplateColumns: 'repeat(auto-fill, 48px)',
                                    gridAutoRows: 48,
                                    alignItems: 'start',
                                    justifyContent: 'start',
                                    gap: 6,
                                    padding: '4px 2px 8px',
                                    maxHeight: 170,
                                    overflowY: 'auto',
                                }}>
                                    {items.map(item => {
                                        const on = isAssets ? selectedAssets.has(item.id) : selectedRefs.has(item.id);
                                        const image = isAssets ? (item as Asset).photos[0]?.image.value : (item as Reference).image.value;
                                        return (
                                            <button
                                                key={item.id}
                                                onClick={() => {
                                                    if (tab === 'weave') {
                                                        isAssets ? weaveRef.current?.addAssetToCanvas(item.id) : weaveRef.current?.addReferenceToCanvas(item.id);
                                                        return;
                                                    }
                                                    isAssets ? toggleAsset(item.id) : toggleRef(item.id);
                                                }}
                                                title={tab === 'weave' ? `${item.name} — add to Canvas` : `${item.name}${on ? ' — selected' : ''}`}
                                                style={{ position: 'relative', width: 48, height: 48, border: on ? '1.5px solid #18181b' : '1px solid #e0e2e7', background: '#fff', borderRadius: 8, padding: 3, cursor: 'pointer', minWidth: 0, overflow: 'hidden' }}
                                            >
                                                {image ? (
                                                    <img src={image} alt="" draggable={false} style={{ width: '100%', height: '100%', borderRadius: 6, objectFit: 'cover', display: 'block' }} />
                                                ) : (
                                                    <div style={{ width: '100%', height: '100%', borderRadius: 6, background: '#f0f1f3' }} />
                                                )}
                                                {on && <span style={{ position: 'absolute', right: 5, top: 5, width: 15, height: 15, borderRadius: 999, background: '#18181b', color: '#fff', fontSize: 10, display: 'grid', placeItems: 'center', fontWeight: 900 }}>✓</span>}
                                            </button>
                                        );
                                    })}
                                    {items.length === 0 && <span style={{ gridColumn: '1 / -1', fontSize: 10.5, color: '#a1a1aa', padding: '4px 6px' }}>{isAssets ? 'No assets yet.' : 'No inspiration yet.'}</span>}
                                </div>
                            )}
                        </div>
                    );
                })}
                {!isNarrow && jobs.length > 0 && (() => {
                    const JOB_STAGE: Record<string, string> = { brief: 'Brief', concepts: 'Concepts', plan: 'Plan', execute: 'Execute', review: 'Review', done: 'Done' };
                    return (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, padding: '6px 2px 2px 6px', borderTop: '1px solid #eceef2', marginTop: 4 }}>
                            <button
                                type="button"
                                onClick={() => setTasksOpen(v => !v)}
                                style={{ display: 'flex', alignItems: 'center', gap: 5, border: 'none', background: 'transparent', cursor: 'pointer', padding: '2px 4px', fontSize: 10, fontWeight: 800, letterSpacing: 0.7, textTransform: 'uppercase', color: '#9aa0aa' }}
                            >
                                <Caret open={tasksOpen} size={11} />
                                Recents · {jobs.length}
                            </button>
                            {tasksOpen && (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 218, overflowY: 'auto' }}>
                                    {jobs.slice(0, 12).map(j => (
                                        <div key={j.id} style={{ position: 'relative' }}>
                                            <button
                                                type="button"
                                                onClick={() => openJob(j)}
                                                title={(j.title ?? '').trim() || j.brief.trim() || 'Open exploration'}
                                                style={{
                                                    width: '100%',
                                                    textAlign: 'left',
                                                    border: '1px solid transparent',
                                                    borderRadius: 8,
                                                    background: activeJobId === j.id && tab === 'studio' ? '#f0f1f3' : 'transparent',
                                                    cursor: 'pointer',
                                                    padding: '4px 38px 4px 8px',
                                                    display: 'flex',
                                                    flexDirection: 'column',
                                                    gap: 1,
                                                }}
                                            >
                                                <span style={{ fontSize: 11, fontWeight: 650, color: '#3f3f46', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>
                                                    {jobName(j)}
                                                </span>
                                                <span style={{ fontSize: 9, color: '#9aa0aa' }}>
                                                    {JOB_STAGE[j.stage] ?? j.stage} · {new Date(j.updatedAt).toLocaleDateString()}
                                                </span>
                                            </button>
                                            <button
                                                type="button"
                                                title="Rename this task"
                                                onClick={() => renameJob(j)}
                                                style={{ position: 'absolute', right: 20, top: 5, width: 16, height: 16, borderRadius: 999, border: 'none', background: 'transparent', color: '#c0c3ca', cursor: 'pointer', fontSize: 9, lineHeight: 1, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                                            >
                                                ✎
                                            </button>
                                            <button
                                                type="button"
                                                title="Delete this task (images stay in Gallery)"
                                                onClick={async () => {
                                                    if (!window.confirm(`Delete "${jobName(j)}"? The generated images stay in Gallery.`)) return;
                                                    await storage.deleteJob(j.id);
                                                    setJobs(prev => prev.filter(x => x.id !== j.id));
                                                    if (activeJobId === j.id) { setActiveJobId(null); studioRef.current?.reset(); }
                                                }}
                                                style={{ position: 'absolute', right: 3, top: 5, width: 16, height: 16, borderRadius: 999, border: 'none', background: 'transparent', color: '#c0c3ca', cursor: 'pointer', fontSize: 10, lineHeight: 1, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                                            >
                                                ✕
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    );
                })()}
                </nav>
                <div style={{
                    marginTop: 'auto',
                    paddingTop: 10,
                    paddingBottom: 8,
                    borderTop: '1px solid #eceef2',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 7,
                }}>
                    <span style={{ fontSize: 10, fontWeight: 850, letterSpacing: 0.7, textTransform: 'uppercase', color: '#9aa0aa', padding: '0 4px' }}>
                        Profile
                    </span>
                    <Select
                        value={brandId}
                        onChange={e => switchBrand(e.target.value)}
                        caretColor="#52525b"
                        style={{
                            ...S.sidebarSelect,
                            border: '1px solid #e0e2e7',
                            background: '#f7f7f8',
                            color: '#18181b',
                        }}
                    >
                        {brands.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                        <option value="__new__">＋ New brand…</option>
                    </Select>
                </div>
            </aside>
            {!isNarrow && (
                <div
                    aria-label="Resize sidebar"
                    onMouseDown={startSidebarResize}
                    style={{
                        width: 6,
                        flex: '0 0 6px',
                        cursor: 'col-resize',
                        background: 'transparent',
                        marginLeft: -3,
                        marginRight: -3,
                        zIndex: 4,
                    }}
                />
            )}
            <section style={{ ...S.shell, ...(isNarrow ? { minHeight: 0 } : {}) }}>
                <div style={{ ...S.topbar, ...(isNarrow ? { minHeight: 44, padding: '0 14px' } : {}) }}>
                    <div>
                        <div style={{ fontSize: 14, fontWeight: 800, color: '#0b0b0b', letterSpacing: -0.1 }}>
                            {TABS.find(t => t.id === tab)?.label}
                        </div>
                        <div style={{ fontSize: 11.5, color: '#7b8190', marginTop: 2 }}>
                            {brands.find(b => b.id === brandId)?.name ?? 'Current brand'}
                        </div>
                    </div>
                    <div style={{ ...S.label, textTransform: 'none', letterSpacing: 0, ...(isNarrow ? { display: 'none' } : {}) }}>
                        Standalone Praxis
                    </div>
                </div>
                <div style={S.main}>
                    {tab === 'studio' && (
                        <StudioView
                            ref={studioRef}
                            assets={assets}
                            refs={refs}
                            selectedAssets={selectedAssets}
                            selectedRefs={selectedRefs}
                            onJobsChange={handleJobsChange}
                            onNavigate={setTab}
                        />
                    )}
                    <div style={{ display: tab === 'weave' ? 'block' : 'none', height: '100%' }}>
                        <WeaveView ref={weaveRef} />
                    </div>
                    {tab === 'gallery' && <GalleryView />}
                    {tab === 'heroes' && <HeroView />}
                    {tab === 'library' && <LibraryView />}
                    {tab === 'knowledge' && <KnowledgeView />}
                    {tab === 'system' && <SystemView />}
                </div>
            </section>
        </div>
    );
}
