import { CSSProperties } from 'react';

/** Minimal shared inline styles — no CSS framework in 2.0 yet. */
export const S: Record<string, CSSProperties> = {
    page: { fontFamily: 'system-ui', height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#fafafa', color: '#18181b' },
    topbar: { display: 'flex', alignItems: 'center', gap: 4, padding: '10px 20px', borderBottom: '1px solid #e4e4e7', background: '#fff' },
    brand: { fontWeight: 700, fontSize: 15, marginRight: 16 },
    tab: { padding: '6px 14px', borderRadius: 8, border: 'none', background: 'transparent', fontSize: 13, fontWeight: 600, color: '#71717a', cursor: 'pointer' },
    tabActive: { background: '#18181b', color: '#fff' },
    main: { flex: 1, overflow: 'auto' },
    label: { fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase' as const, color: '#a1a1aa' },
    chip: { padding: '4px 12px', borderRadius: 999, border: '1px solid #d4d4d8', background: '#fff', fontSize: 12, fontWeight: 600, color: '#52525b', cursor: 'pointer' },
    chipOn: { background: '#18181b', color: '#fff', borderColor: '#18181b' },
    card: { background: '#fff', border: '1px solid #e4e4e7', borderRadius: 14, padding: 16 },
    btn: { padding: '8px 18px', borderRadius: 10, border: 'none', background: '#18181b', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' },
    btnGhost: { padding: '6px 12px', borderRadius: 8, border: '1px solid #d4d4d8', background: '#fff', fontSize: 12, fontWeight: 600, color: '#52525b', cursor: 'pointer' },
    input: { border: '1px solid #d4d4d8', borderRadius: 8, padding: '8px 12px', fontSize: 13, outline: 'none' },
    err: { background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c', borderRadius: 10, padding: '10px 14px', fontSize: 12 },
};

export const chip = (on: boolean): CSSProperties => ({ ...S.chip, ...(on ? S.chipOn : {}) });
