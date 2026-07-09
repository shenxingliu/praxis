import React, { useEffect, useRef, useState } from 'react';
import { Asset } from '../domain/types';
import { storage } from '../storage/local';
import { getCurrentBrandId } from '../domain/brand';
import { INVENTORY_CHANGED_EVENT } from './events';
import { openLightbox } from './lightbox';
import { DropZone, imageFiles } from './dropzone';
import { S } from './styles';

/**
 * HEROES — the hero-truth library (zero-deviation source pixels).
 * Upload photos to create assets; add more photos to existing ones.
 * References (aesthetics) live in Inspiration; assets live here.
 */

const fileToDataUrl = (f: File): Promise<string> =>
    new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result));
        r.onerror = rej;
        r.readAsDataURL(f);
    });

export default function HeroView() {
    const [assets, setAssets] = useState<Asset[]>([]);
    const [busy, setBusy] = useState('');
    const [notice, setNotice] = useState('');
    const newRef = useRef<HTMLInputElement>(null);
    const addRef = useRef<HTMLInputElement>(null);
    const [addTarget, setAddTarget] = useState<Asset | null>(null);

    const refresh = () => storage.listAssets().then(setAssets);
    useEffect(() => { refresh(); }, []);

    const announce = () => window.dispatchEvent(new CustomEvent(INVENTORY_CHANGED_EVENT));

    const createHero = async (input: FileList | File[] | null) => {
        const files = imageFiles(input);
        if (files.length === 0) return;
        const name = window.prompt('Asset name:', files[0].name.replace(/\.[^.]+$/, ''))?.trim();
        if (!name) return;
        const category = window.prompt('Category (optional — e.g. Bed, Desk, Bottle):')?.trim() || undefined;
        setBusy(`Uploading ${files.length} photo${files.length === 1 ? '' : 's'}…`);
        setNotice('');
        try {
            const photos = [];
            for (let i = 0; i < files.length; i++) {
                photos.push({
                    id: crypto.randomUUID(),
                    image: { kind: 'data' as const, value: await fileToDataUrl(files[i]) },
                    role: (i === 0 ? 'hero' : 'detail') as 'hero' | 'detail',
                });
            }
            const asset: Asset = {
                id: crypto.randomUUID(),
                brandId: getCurrentBrandId(),
                name, category,
                tags: [],
                photos,
                createdAt: Date.now(),
                updatedAt: Date.now(),
            };
            await storage.upsertAsset(asset);
            setNotice(`"${name}" added with ${photos.length} photo${photos.length === 1 ? '' : 's'}`);
            announce();
        } catch (err: any) { setNotice(`${err?.message || err}`); }
        setBusy('');
        refresh();
    };

    const addPhotosTo = async (target: Asset, input: FileList | File[] | null) => {
        const files = imageFiles(input);
        if (files.length === 0) return;
        setBusy(`Adding photos to ${target.name}…`);
        setNotice('');
        try {
            const extra = [];
            for (const f of files) {
                extra.push({
                    id: crypto.randomUUID(),
                    image: { kind: 'data' as const, value: await fileToDataUrl(f) },
                    role: 'detail' as const,
                });
            }
            await storage.upsertAsset({ ...target, photos: [...target.photos, ...extra], updatedAt: Date.now() });
            setNotice(`${extra.length} photo${extra.length === 1 ? '' : 's'} added to "${target.name}"`);
            announce();
        } catch (err: any) { setNotice(`${err?.message || err}`); }
        setBusy('');
        refresh();
    };

    const addPhotos = async (files: FileList | null) => {
        const target = addTarget;
        setAddTarget(null);
        if (target) await addPhotosTo(target, files);
    };

    const removePhoto = async (a: Asset, photoId: string) => {
        if (a.photos.length <= 1) { setNotice('An asset needs at least one photo — delete the asset instead.'); return; }
        await storage.upsertAsset({ ...a, photos: a.photos.filter(p => p.id !== photoId), updatedAt: Date.now() });
        announce();
        refresh();
    };

    const rename = async (a: Asset) => {
        const name = window.prompt('Asset name:', a.name)?.trim();
        if (!name) return;
        await storage.upsertAsset({ ...a, name, updatedAt: Date.now() });
        announce();
        refresh();
    };

    const remove = async (a: Asset) => {
        if (!window.confirm(`Delete hero "${a.name}" and its ${a.photos.length} photo${a.photos.length === 1 ? '' : 's'}?`)) return;
        await storage.deleteAsset(a.id);
        setNotice(`"${a.name}" deleted`);
        announce();
        refresh();
    };

    return (
        <div style={{ maxWidth: 980, margin: '0 auto', padding: '22px 28px', display: 'flex', flexDirection: 'column', gap: 16 }}>
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

            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={S.label}>HEROES · {assets.length}</span>
                <button style={S.btn} disabled={!!busy} onClick={() => newRef.current?.click()}>＋ New asset (upload photos)</button>
                <span style={{ fontSize: 10, color: '#a1a1aa' }}>Source of truth — or drag & drop photos: onto the page = new asset, onto a card = add to that asset.</span>
                <input ref={newRef} type="file" multiple accept="image/*" style={{ display: 'none' }} onChange={e => { createHero(e.target.files); e.target.value = ''; }} />
                <input ref={addRef} type="file" multiple accept="image/*" style={{ display: 'none' }} onChange={e => { addPhotos(e.target.files); e.target.value = ''; }} />
            </div>

            <DropZone onFiles={createHero} hint="Drop photos — creates a new asset">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12, minHeight: 120 }}>
                {assets.map(a => (
                    <DropZone key={a.id} onFiles={fs => addPhotosTo(a, fs)} hint={`Add to ${a.name}`}>
                    <div style={{ ...S.card, display: 'flex', flexDirection: 'column', gap: 8, height: '100%', boxSizing: 'border-box' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                            <span style={{ fontSize: 13, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
                            <span style={{ fontSize: 10, color: '#a1a1aa', flexShrink: 0 }}>{a.category || '—'} · {a.photos.length}</span>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4 }}>
                            {a.photos.map(p => (
                                <div key={p.id} style={{ position: 'relative' }}>
                                    <img src={p.image.value} alt="" onClick={() => openLightbox(p.image.value)}
                                        style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: 6, display: 'block', cursor: 'zoom-in' }} />
                                    <button onClick={() => removePhoto(a, p.id)} title="Remove photo"
                                        style={{ position: 'absolute', top: 2, right: 2, border: 'none', borderRadius: 5, background: 'rgba(0,0,0,0.45)', color: '#fff', fontSize: 8, cursor: 'pointer', padding: '1px 4px' }}>✕</button>
                                </div>
                            ))}
                        </div>
                        <div style={{ display: 'flex', gap: 6, marginTop: 'auto' }}>
                            <button style={S.btnGhost} disabled={!!busy} onClick={() => { setAddTarget(a); addRef.current?.click(); }}>＋ Photos</button>
                            <button style={S.btnGhost} disabled={!!busy} onClick={() => rename(a)}>Rename</button>
                            <button style={{ ...S.btnGhost, color: '#18181b', marginLeft: 'auto' }} disabled={!!busy} onClick={() => remove(a)}>Delete</button>
                        </div>
                    </div>
                    </DropZone>
                ))}
                {assets.length === 0 && (
                    <p style={{ fontSize: 12, color: '#a1a1aa' }}>
                        No assets yet. Upload or drag & drop asset photos here, or import legacy data in System.
                    </p>
                )}
            </div>
            </DropZone>
        </div>
    );
}
