/**
 * Image offloading — the root fix for Supabase statement timeouts.
 *
 * Base64 images inside jsonb rows detoast at ~0.5s+/MB and blow the 8s
 * statement timeout as tables grow. Images belong in object storage:
 * rows keep a public URL, reads become instant, the database stays lean.
 *
 * Everything here is BEST-EFFORT and self-healing:
 * - upload fails → caller keeps the data URL (no regression, retry next save)
 * - bucket missing → created on first use
 * - model calls need pixels → resolveToDataUrl() fetches URLs back to base64
 */

const BUCKET = 'praxis-images';

const supabaseUrl = (import.meta.env.VITE_SUPABASE_URL ?? '').replace(/\/$/, '');
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';

const enabled = () => !!supabaseUrl && !!supabaseKey;

const headers = () => ({ apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` });

// NOTE: anon policies usually allow object reads/writes but NOT bucket
// metadata reads — so never gate on "does the bucket exist"; just upload,
// and only try to create the bucket after a 404.
let bucketCreateTried = false;

async function tryCreateBucket(): Promise<void> {
    if (bucketCreateTried) return;
    bucketCreateTried = true;
    try {
        await fetch(`${supabaseUrl}/storage/v1/bucket`, {
            method: 'POST',
            headers: { ...headers(), 'content-type': 'application/json' },
            body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true }),
        });
    } catch { /* best-effort */ }
}

const dataUrlToBlob = (dataUrl: string): Blob | null => {
    try {
        const [head, b64] = dataUrl.split(',');
        const mime = head.match(/data:(.*?);/)?.[1] ?? 'image/jpeg';
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new Blob([bytes], { type: mime });
    } catch {
        return null;
    }
};

/** Upload a data URL; returns the public URL, or null if anything failed
 *  (caller keeps the data URL — nothing is ever lost). */
export async function uploadImage(dataUrl: string, path: string): Promise<string | null> {
    if (!enabled() || !dataUrl.startsWith('data:')) return null;
    const blob = dataUrlToBlob(dataUrl);
    if (!blob) return null;
    const attempt = () => fetch(`${supabaseUrl}/storage/v1/object/${BUCKET}/${path}`, {
        method: 'POST',
        headers: { ...headers(), 'content-type': blob.type, 'x-upsert': 'true' },
        body: blob,
    });
    try {
        let resp = await attempt();
        if (resp.status === 404) { // bucket missing — create once, retry
            await tryCreateBucket();
            resp = await attempt();
        }
        if (!resp.ok) return null;
        return `${supabaseUrl}/storage/v1/object/public/${BUCKET}/${path}`;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// URL → data URL (model calls need inline pixels)
// ---------------------------------------------------------------------------

const resolveCache = new Map<string, string>();

/** Any image value → data URL. Data URLs pass through; http(s) URLs are
 *  fetched once and cached. Returns the input on failure so callers can
 *  degrade gracefully. */
export async function resolveToDataUrl(value: string): Promise<string> {
    if (!value || value.startsWith('data:')) return value;
    const hit = resolveCache.get(value);
    if (hit) return hit;
    try {
        const sameSupabaseStorage = enabled() && value.startsWith(`${supabaseUrl}/storage/v1/object/`);
        const resp = await fetch(value, sameSupabaseStorage ? { headers: headers() } : undefined);
        if (!resp.ok) return value;
        const blob = await resp.blob();
        const dataUrl = await new Promise<string>((res, rej) => {
            const r = new FileReader();
            r.onload = () => res(String(r.result));
            r.onerror = rej;
            r.readAsDataURL(blob);
        });
        if (resolveCache.size > 40) resolveCache.clear();
        resolveCache.set(value, dataUrl);
        return dataUrl;
    } catch {
        return value;
    }
}

/** Download any image value (data URL or bucket URL) as a file. */
export async function downloadImage(value: string, name = 'praxis'): Promise<void> {
    const dataUrl = await resolveToDataUrl(value);
    if (!dataUrl.startsWith('data:')) { window.open(value, '_blank'); return; }
    const ext = dataUrl.match(/^data:image\/(\w+)/)?.[1] ?? 'png';
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `${name}.${ext === 'jpeg' ? 'jpg' : ext}`;
    a.click();
}

/** Rough content hash so re-saving the same image reuses the same object path. */
export const imageStamp = (dataUrl: string): string => {
    let h = 5381;
    const step = Math.max(1, Math.floor(dataUrl.length / 4096));
    for (let i = 0; i < dataUrl.length; i += step) h = ((h << 5) + h + dataUrl.charCodeAt(i)) >>> 0;
    return `${h.toString(36)}-${dataUrl.length.toString(36)}`;
};
