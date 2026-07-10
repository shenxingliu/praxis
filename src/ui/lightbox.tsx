import React, { useEffect, useState } from 'react';
import { downloadImage } from '../storage/images';

/**
 * Global lightbox — call openLightbox(src) from anywhere; <LightboxHost/>
 * (mounted once in App) renders the full-screen viewer.
 */

let setter: ((src: string | null) => void) | null = null;

export function openLightbox(src: string): void {
    setter?.(src);
}

export const LightboxHost: React.FC = () => {
    const [src, setSrc] = useState<string | null>(null);
    useEffect(() => {
        setter = setSrc;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSrc(null); };
        window.addEventListener('keydown', onKey);
        return () => { setter = null; window.removeEventListener('keydown', onKey); };
    }, []);
    if (!src) return null;
    return (
        <div onClick={() => setSrc(null)}
            style={{
                position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.85)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'zoom-out',
            }}>
            <img src={src} alt="" style={{ maxWidth: '94vw', maxHeight: '94vh', borderRadius: 12, boxShadow: '0 12px 60px rgba(0,0,0,0.5)' }} />
            <button
                onClick={e => { e.stopPropagation(); downloadImage(src, `praxis-${new Date().toISOString().slice(0, 10)}`); }}
                title="Download this image"
                style={{
                    position: 'fixed', top: 18, right: 18, minHeight: 36, padding: '0 16px',
                    borderRadius: 999, border: '1px solid rgba(255,255,255,0.28)',
                    background: 'rgba(255,255,255,0.14)', backdropFilter: 'blur(12px)',
                    WebkitBackdropFilter: 'blur(12px)', color: '#fff', fontSize: 13,
                    fontWeight: 700, cursor: 'pointer', display: 'inline-flex',
                    alignItems: 'center', gap: 7,
                }}
            >
                ↓ Download
            </button>
        </div>
    );
};

/** Standard props for any zoomable <img>. */
export const zoomable = (src: string): Pick<React.ImgHTMLAttributes<HTMLImageElement>, 'onClick' | 'style'> => ({
    onClick: (e) => { e.stopPropagation(); openLightbox(src); },
    style: { cursor: 'zoom-in' },
});
