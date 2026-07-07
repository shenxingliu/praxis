import React, { useEffect, useState } from 'react';
import StudioView from './ui/StudioView';
import WeaveView from './ui/WeaveView';
import QuickView from './ui/QuickView';
import GalleryView from './ui/GalleryView';
import HeroView from './ui/HeroView';
import LibraryView from './ui/LibraryView';
import KnowledgeView from './ui/KnowledgeView';
import SystemView from './ui/SystemView';
import { S } from './ui/styles';
import { LightboxHost } from './ui/lightbox';
import { Brand } from './domain/types';
import {
    listBrands, getCurrentBrandId, setCurrentBrandId, createBrand,
} from './domain/brand';

type Tab = 'studio' | 'weave' | 'quick' | 'gallery' | 'heroes' | 'library' | 'knowledge' | 'system';

const TABS: Array<{ id: Tab; label: string; meta: string }> = [
    { id: 'studio', label: 'Studio', meta: 'workflow' },
    { id: 'weave', label: 'Weave', meta: 'canvas' },
    { id: 'quick', label: 'Quick', meta: 'presets' },
    { id: 'gallery', label: 'Gallery', meta: 'outputs' },
    { id: 'heroes', label: 'Heroes', meta: 'truth' },
    { id: 'library', label: 'Library', meta: 'references' },
    { id: 'knowledge', label: 'Brain', meta: 'learning' },
    { id: 'system', label: 'System', meta: 'settings' },
];

export default function App() {
    const [tab, setTab] = useState<Tab>('studio');
    const [brands, setBrands] = useState<Brand[]>([]);
    const [brandId, setBrandId] = useState(getCurrentBrandId());
    const [isNarrow, setIsNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < 760);

    useEffect(() => { listBrands().then(setBrands); }, []);
    useEffect(() => {
        const onResize = () => setIsNarrow(window.innerWidth < 760);
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, []);

    const switchBrand = (id: string) => {
        if (id === '__new__') {
            const name = window.prompt('New brand name:')?.trim();
            if (!name) return;
            const description = window.prompt('One line — category + positioning (drives every prompt):')?.trim() ?? '';
            const essence = window.prompt('Hero fidelity essentials (what must never change):')?.trim() ?? '';
            createBrand(name, description, essence).then(b => {
                setCurrentBrandId(b.id);
                window.location.reload();
            });
            return;
        }
        setCurrentBrandId(id);
        setBrandId(id);
        window.location.reload(); // simplest correctness: every view reloads its brand's data
    };

    return (
        <div style={{ ...S.page, ...(isNarrow ? { flexDirection: 'column' as const } : {}) }}>
            <LightboxHost />
            <style>{`
                * { box-sizing: border-box; }
                button {
                    transition: opacity .15s ease, transform .06s ease, background .15s ease, border-color .15s ease;
                    font-family: inherit;
                    line-height: 1;
                    white-space: nowrap;
                }
                button:not(:disabled):hover { opacity: .86; }
                button:not(:disabled):active { transform: scale(.96); }
                button:focus-visible, select:focus-visible, input:focus-visible, textarea:focus-visible {
                    outline: 2px solid rgba(24, 24, 27, 0.62);
                    outline-offset: 2px;
                }
                button:disabled { cursor: progress; }
                input, select, textarea { font-family: inherit; }
                @keyframes praxis-pulse { 0%,100% { opacity: 1; } 50% { opacity: .55; } }
                .praxis-running { animation: praxis-pulse 1.2s ease-in-out infinite; }
            `}</style>
            <aside style={{
                ...S.sidebar,
                ...(isNarrow ? {
                    width: '100%',
                    maxHeight: 226,
                    borderRight: 'none',
                    borderBottom: '1px solid rgba(255,255,255,0.12)',
                    overflow: 'auto',
                } : {}),
            }}>
                <div style={{ ...S.brandBlock, ...(isNarrow ? { paddingBottom: 0 } : {}) }}>
                    <span style={S.brand}>Praxis</span>
                    <span style={S.brandSubtle}>AI design studio</span>
                </div>
                <select
                    value={brandId}
                    onChange={e => switchBrand(e.target.value)}
                    style={S.sidebarSelect}
                >
                    {brands.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                    <option value="__new__">＋ New brand…</option>
                </select>
                <nav style={{
                    ...S.nav,
                    ...(isNarrow ? {
                        flexDirection: 'row' as const,
                        overflowX: 'auto',
                        paddingBottom: 4,
                    } : {}),
                }}>
                {TABS.map(t => (
                    <button key={t.id} onClick={() => setTab(t.id)} style={{
                        ...S.tab,
                        ...(isNarrow ? { minWidth: 132, width: 'auto' } : {}),
                        ...(tab === t.id ? S.tabActive : {}),
                    }}>
                        <span style={{ flex: 1 }}>{t.label}</span>
                        <span style={{ fontSize: 10.5, color: tab === t.id ? 'rgba(255,255,255,0.58)' : '#747c89', fontWeight: 650 }}>
                            {t.meta}
                        </span>
                    </button>
                ))}
                </nav>
            </aside>
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
                    {tab === 'studio' && <StudioView />}
                    {tab === 'weave' && <WeaveView />}
                    {tab === 'quick' && <QuickView />}
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
