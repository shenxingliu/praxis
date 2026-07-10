import React from 'react';

/**
 * Shared micro-controls — ONE chevron glyph for the whole app.
 * Every collapsible and every dropdown uses these, so indicators are
 * optically centered and rotate with the same motion everywhere.
 */

export function Caret({ open, size = 12, color = 'currentColor' }: { open?: boolean; size?: number; color?: string }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 16 16"
            aria-hidden="true"
            style={{
                display: 'block',
                flexShrink: 0,
                transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
                transition: 'transform 240ms cubic-bezier(0.22,1,0.36,1)',
            }}
        >
            <path d="M6 4l4 4-4 4" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}

type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement> & {
    wrapStyle?: React.CSSProperties;
    caretSize?: number;
    caretColor?: string;
};

/** Native select with the OS arrow removed and one centered chevron drawn in. */
export function Select({ style, wrapStyle, caretSize = 12, caretColor = '#71717a', children, ...rest }: SelectProps) {
    const { width, ...inner } = style ?? {};
    return (
        <span style={{ position: 'relative', display: 'inline-flex', ...(width !== undefined ? { width } : {}), ...wrapStyle }}>
            <select
                {...rest}
                style={{
                    ...inner,
                    width: '100%',
                    appearance: 'none',
                    WebkitAppearance: 'none',
                    MozAppearance: 'none',
                    paddingRight: caretSize + 14,
                }}
            >
                {children}
            </select>
            <svg
                width={caretSize}
                height={caretSize}
                viewBox="0 0 16 16"
                aria-hidden="true"
                style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%) rotate(90deg)', pointerEvents: 'none', display: 'block' }}
            >
                <path d="M6 4l4 4-4 4" fill="none" stroke={caretColor} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
        </span>
    );
}
