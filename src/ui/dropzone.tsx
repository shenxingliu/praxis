import React, { useState } from 'react';

/**
 * DropZone — wrap any area to accept drag & drop image uploads (multi-file).
 * Highlights on drag-over; filters to images; passes File[] to onFiles.
 */
export const DropZone: React.FC<{
    onFiles: (files: File[]) => void;
    children: React.ReactNode;
    style?: React.CSSProperties;
    hint?: string;
}> = ({ onFiles, children, style, hint }) => {
    const [over, setOver] = useState(false);
    return (
        <div
            onDragOver={e => { e.preventDefault(); setOver(true); }}
            onDragLeave={e => { e.preventDefault(); setOver(false); }}
            onDrop={e => {
                e.preventDefault();
                setOver(false);
                const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
                if (files.length > 0) onFiles(files);
            }}
            style={{
                position: 'relative', borderRadius: 12, transition: 'box-shadow .12s ease',
                boxShadow: over ? 'inset 0 0 0 2.5px #18181b' : 'none',
                ...style,
            }}
        >
            {children}
            {over && (
                <div style={{
                    position: 'absolute', inset: 0, zIndex: 5, borderRadius: 12,
                    background: 'rgba(24,24,27,0.06)', display: 'flex', alignItems: 'center',
                    justifyContent: 'center', pointerEvents: 'none',
                    fontSize: 13, fontWeight: 700, color: '#18181b',
                }}>
                    ⬇ {hint ?? 'Drop images here'}
                </div>
            )}
        </div>
    );
};

/** Normalize any file source to an image File[]. */
export const imageFiles = (src: FileList | File[] | null): File[] =>
    Array.from(src ?? []).filter(f => f.type.startsWith('image/'));
