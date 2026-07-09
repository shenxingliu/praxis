/// <reference types="vite/client" />
import { GoogleGenAI } from '@google/genai';

/**
 * Gemini client — proxy-aware, budget-aware. Ported from V1's apiManager
 * with the same env contract so the existing Vercel proxy works unchanged:
 *   VITE_USE_PROXY / VITE_GEMINI_API_KEY / VITE_APP_ACCESS_TOKEN
 */

export const MODELS = {
    imagePro: 'gemini-3-pro-image',
    imageFlash: 'gemini-3.1-flash-image',
    text: 'gemini-2.5-flash',
} as const;

/** Rough $/generation used for budget accounting — tune against real bills. */
export const COST_ESTIMATE_USD: Record<string, number> = {
    [MODELS.imagePro]: 0.24,
    [MODELS.imageFlash]: 0.04,
    [MODELS.text]: 0.002,
};

const isProxyMode = (): boolean =>
    String(import.meta.env.VITE_USE_PROXY || '').toLowerCase() === 'true';

export const appApiHeaders = (): Record<string, string> => {
    const token = import.meta.env.VITE_APP_ACCESS_TOKEN;
    return token ? { 'x-app-token': token } : {};
};

export const getApiKey = (): string | null => {
    if (isProxyMode()) return 'PROXY';
    const local = typeof window !== 'undefined' ? localStorage.getItem('GEMINI_API_KEY') : null;
    return local?.trim() || import.meta.env.VITE_GEMINI_API_KEY || null;
};

export const createClient = (): GoogleGenAI => {
    const apiKey = getApiKey();
    if (!apiKey) throw new Error('No API key. Set it in Settings or enable proxy mode.');
    if (isProxyMode()) {
        // Absolute URL — newer @google/genai versions reject relative baseUrl.
        const base = `${window.location.origin}/api/gemini`;
        return new GoogleGenAI({
            apiKey,
            httpOptions: { baseUrl: base, headers: appApiHeaders() },
        });
    }
    return new GoogleGenAI({ apiKey });
};

export interface ImagePart {
    inlineData: { mimeType: string; data: string };
}

export const toInlinePart = (dataUrl: string): ImagePart => {
    const [meta, data] = dataUrl.split(',');
    const mimeType = meta.split(';')[0].split(':')[1] || 'image/png';
    return { inlineData: { mimeType, data } };
};

const imageResizeCache = new Map<string, string>();

const dataChars = (dataUrl: string): number => dataUrl.split(',')[1]?.length ?? dataUrl.length;

const canResizeInBrowser = (): boolean =>
    typeof document !== 'undefined' && typeof Image !== 'undefined';

const loadDataUrlImage = (src: string): Promise<HTMLImageElement> =>
    new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Could not read reference image.'));
        img.src = src;
    });

async function shrinkDataUrl(dataUrl: string, opts: {
    maxEdge: number;
    quality: number;
    maxDataChars: number;
}): Promise<string> {
    if (!dataUrl.startsWith('data:image/') || !canResizeInBrowser()) return dataUrl;

    const cacheKey = `${dataUrl.length}:${opts.maxEdge}:${opts.quality}:${opts.maxDataChars}`;
    const cached = imageResizeCache.get(cacheKey);
    if (cached) return cached;

    try {
        const img = await loadDataUrlImage(dataUrl);
        let edge = opts.maxEdge;
        let quality = opts.quality;
        let best = dataUrl;

        for (let attempt = 0; attempt < 6; attempt++) {
            const scale = Math.min(1, edge / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height));
            const width = Math.max(1, Math.round((img.naturalWidth || img.width) * scale));
            const height = Math.max(1, Math.round((img.naturalHeight || img.height) * scale));
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            if (!ctx) break;
            ctx.drawImage(img, 0, 0, width, height);
            best = canvas.toDataURL('image/jpeg', quality);
            if (dataChars(best) <= opts.maxDataChars || edge <= 520) break;
            edge = Math.round(edge * 0.78);
            quality = Math.max(0.52, quality - 0.08);
        }

        const out = dataChars(best) < dataChars(dataUrl) ? best : dataUrl;
        if (imageResizeCache.size > 80) imageResizeCache.clear();
        imageResizeCache.set(cacheKey, out);
        return out;
    } catch {
        return dataUrl;
    }
}

async function prepareInlineParts(images: string[], mode: 'image' | 'json'): Promise<ImagePart[]> {
    const maxImages = mode === 'image' ? 14 : 8;
    const totalBudget = isProxyMode()
        ? mode === 'image' ? 2_800_000 : 1_900_000
        : mode === 'image' ? 7_000_000 : 3_500_000;
    const perImageBudget = mode === 'image' ? 520_000 : 380_000;
    const maxEdge = mode === 'image' ? 1280 : 960;
    const quality = mode === 'image' ? 0.74 : 0.7;
    const capped = images.slice(0, maxImages);
    const parts: ImagePart[] = [];
    for (const img of capped) {
        const resized = await shrinkDataUrl(img, { maxEdge, quality, maxDataChars: perImageBudget });
        parts.push(toInlinePart(resized));
    }
    const used = parts.reduce((sum, part) => sum + part.inlineData.data.length, 0);
    if (used <= totalBudget) return parts;

    // Over budget: recompress EVERYTHING harder instead of dropping images —
    // dropping desyncs the prompt's image-role manifest (image N no longer
    // means what the prompt says it means).
    const perImage = Math.max(120_000, Math.floor(totalBudget / Math.max(1, capped.length)));
    const recompressed: ImagePart[] = [];
    for (const img of capped) {
        const resized = await shrinkDataUrl(img, {
            maxEdge: Math.round(maxEdge * 0.7),
            quality: Math.max(0.5, quality - 0.14),
            maxDataChars: perImage,
        });
        recompressed.push(toInlinePart(resized));
    }
    return recompressed;
}

/**
 * REST call to Gemini generateContent.
 *
 * Proxy mode uses OUR /api/generate endpoint (model in the body) because
 * Vercel's router 404s on request paths containing ':' — the standard
 * `models/{model}:generateContent` path can never reach a Vercel function.
 * Direct mode calls Google straight with the local key.
 */
async function restGenerate(model: string, body: unknown): Promise<any> {
    // Hard timeout: a hung request must NEVER freeze the UI (busy-state
    // buttons stay disabled until the promise settles).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    let resp: Response;
    try {
        if (isProxyMode()) {
            resp = await fetch('/api/generate', {
                method: 'POST',
                headers: { 'content-type': 'application/json', ...appApiHeaders() },
                body: JSON.stringify({ model, body }),
                signal: controller.signal,
            });
        } else {
            const apiKey = getApiKey();
            if (!apiKey) throw new Error('No API key. Set it in Settings or enable proxy mode.');
            resp = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
                {
                    method: 'POST',
                    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
                    body: JSON.stringify(body),
                    signal: controller.signal,
                }
            );
        }
    } catch (err: any) {
        if (err?.name === 'AbortError') throw new Error('Request timed out (120s) — try again.');
        throw err;
    } finally {
        clearTimeout(timer);
    }
    const text = await resp.text();
    if (!resp.ok) {
        const hint = resp.status === 413
            ? ' Payload too large after compression; try fewer/lower-resolution reference images.'
            : '';
        throw new Error(`Gemini ${resp.status}: ${text.slice(0, 300)}${hint}`);
    }
    return JSON.parse(text);
}

/**
 * Single image-generation entry point with retry/backoff.
 * All recipes call this — one place for model selection, retries, cost.
 */
export async function generateImage(opts: {
    prompt: string;
    referenceImages: string[]; // data URLs, most important first (max 14 for pro)
    model: string;
    aspectRatio: string;
    /** '1K' | '2K' | '4K' — silently dropped if the model rejects it. */
    imageSize?: string;
}): Promise<{ image: string; model: string }> {
    const imageParts = await prepareInlineParts(opts.referenceImages, 'image');
    const parts: Array<ImagePart | { text: string }> = [
        ...imageParts,
        { text: opts.prompt },
    ];
    const makeBody = (withSize: boolean) => ({
        contents: [{ parts }],
        generationConfig: {
            responseModalities: ['TEXT', 'IMAGE'],
            imageConfig: {
                aspectRatio: opts.aspectRatio,
                ...(withSize && opts.imageSize ? { imageSize: opts.imageSize } : {}),
            },
        },
    });
    let body = makeBody(true);

    const MAX_RETRIES = 2;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            const data = await restGenerate(opts.model, body);
            for (const part of data.candidates?.[0]?.content?.parts || []) {
                // A real image is tens of KB of base64 — a tiny/empty payload
                // is an API glitch and must fail (and retry), not get saved
                // as a permanently broken data URL.
                if (typeof part.inlineData?.data === 'string' && part.inlineData.data.length > 1000) {
                    return {
                        image: `data:image/png;base64,${part.inlineData.data}`,
                        model: opts.model,
                    };
                }
            }
            throw new Error('No image in response.');
        } catch (err: any) {
            lastErr = err;
            const msg = String(err?.message || err);
            // Model doesn't support imageSize → drop it and retry immediately.
            if (opts.imageSize && /imageSize|image_size|Unknown name|INVALID_ARGUMENT/i.test(msg) && JSON.stringify(body).includes('imageSize')) {
                body = makeBody(false);
                continue;
            }
            const retriable = /429|quota|rate|unavailable|deadline|timeout|timed out|500|503|504/i.test(msg);
            if (!retriable || attempt === MAX_RETRIES) break;
            await new Promise(r => setTimeout(r, 3000 * Math.pow(2, attempt)));
        }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Text generation (JSON mode). Optional image data-URLs enable vision
 *  tasks — decomposition, review scoring, visual archaeology. */
export async function generateJson<T>(prompt: string, images: string[] = []): Promise<T> {
    const imageParts = await prepareInlineParts(images, 'json');
    const data = await restGenerate(MODELS.text, {
        contents: [{ parts: [...imageParts, { text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json' },
    });
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? 'null';
    return JSON.parse(text) as T;
}
