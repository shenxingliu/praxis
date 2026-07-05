import React, { useEffect, useState } from 'react';

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
        </div>
    );
};

/** Standard props for any zoomable <img>. */
export const zoomable = (src: string): Pick<React.ImgHTMLAttributes<HTMLImageElement>, 'onClick' | 'style'> => ({
    onClick: (e) => { e.stopPropagation(); openLightbox(src); },
    style: { cursor: 'zoom-in' },
});
