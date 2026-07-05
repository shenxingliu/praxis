import React, { useEffect, useState } from 'react';
import CreateView from './ui/CreateView';
import KnowledgeView from './ui/KnowledgeView';
import SystemView from './ui/SystemView';
import { S } from './ui/styles';
import { Brand } from './domain/types';
import {
    listBrands, getCurrentBrandId, setCurrentBrandId, createBrand,
} from './domain/brand';

type Tab = 'studio' | 'knowledge' | 'system';

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
                {(['studio', 'knowledge', 'system'] as Tab[]).map(t => (
                    <button key={t} onClick={() => setTab(t)} style={{ ...S.tab, ...(tab === t ? S.tabActive : {}) }}>
                        {t === 'studio' ? 'Studio' : t === 'knowledge' ? 'Brain' : 'System'}
                    </button>
                ))}
            </div>
            <div style={S.main}>
                {tab === 'studio' && <CreateView />}
                {tab === 'knowledge' && <KnowledgeView />}
                {tab === 'system' && <SystemView />}
            </div>
        </div>
    );
}
