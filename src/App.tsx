import React, { useEffect, useState } from 'react';
import StudioView from './ui/StudioView';
import CreateView from './ui/CreateView';
import ProductsView from './ui/ProductsView';
import LibraryView from './ui/LibraryView';
import KnowledgeView from './ui/KnowledgeView';
import SystemView from './ui/SystemView';
import { S } from './ui/styles';
import { Brand } from './domain/types';
import {
    listBrands, getCurrentBrandId, setCurrentBrandId, createBrand,
} from './domain/brand';

type Tab = 'studio' | 'quick' | 'products' | 'library' | 'knowledge' | 'system';

export default function App() {
    const [tab, setTab] = useState<Tab>('studio');
    const [brands, setBrands] = useState<Brand[]>([]);
    const [brandId, setBrandId] = useState(getCurrentBrandId());

    useEffect(() => { listBrands().then(setBrands); }, []);

    const switchBrand = (id: string) => {
        if (id === '__new__') {
            const name = window.prompt('New brand name:')?.trim();
            if (!name) return;
            const description = window.prompt('One line — category + positioning (drives every prompt):')?.trim() ?? '';
            const essence = window.prompt('Product fidelity essentials (what must never change):')?.trim() ?? '';
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
        <div style={S.page}>
            <style>{`
                button { transition: opacity .15s ease, transform .06s ease; }
                button:not(:disabled):hover { opacity: .8; }
                button:not(:disabled):active { transform: scale(.96); }
                button:disabled { cursor: progress; }
                @keyframes praxis-pulse { 0%,100% { opacity: 1; } 50% { opacity: .55; } }
                .praxis-running { animation: praxis-pulse 1.2s ease-in-out infinite; }
            `}</style>
            <div style={S.topbar}>
                <span style={S.brand}>Praxis</span>
                <select
                    value={brandId}
                    onChange={e => switchBrand(e.target.value)}
                    style={{ ...S.input, width: 160, fontWeight: 600 }}
                >
                    {brands.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                    <option value="__new__">＋ New brand…</option>
                </select>
                {(['studio', 'quick', 'products', 'library', 'knowledge', 'system'] as Tab[]).map(t => (
                    <button key={t} onClick={() => setTab(t)} style={{ ...S.tab, ...(tab === t ? S.tabActive : {}) }}>
                        {t === 'studio' ? 'Studio' : t === 'quick' ? 'Quick' : t === 'products' ? 'Products' : t === 'library' ? 'Library' : t === 'knowledge' ? 'Brain' : 'System'}
                    </button>
                ))}
            </div>
            <div style={S.main}>
                {tab === 'studio' && <StudioView />}
                {tab === 'quick' && <CreateView />}
                {tab === 'products' && <ProductsView />}
                {tab === 'library' && <LibraryView />}
                {tab === 'knowledge' && <KnowledgeView />}
                {tab === 'system' && <SystemView />}
            </div>
        </div>
    );
}
