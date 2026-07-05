// Vercel Serverless Function: brand-website fetcher for soul archaeology.
//
//   POST /api/fetch-site  { "url": "https://brand.com" }
//   → { title, description, text, images: [{ src, dataUrl }] }
//
// The browser can't fetch arbitrary sites (CORS), so this endpoint pulls
// the page HTML server-side, extracts readable text + key images, and
// downloads up to 4 images as base64 so the client can feed them to the
// vision model directly.

// ---- Inline app access control ----
// (Duplicated per-function on purpose: Vercel compiles api/*.ts to ESM
// where extensionless relative imports fail at runtime.)
import { timingSafeEqual } from 'node:crypto';

const APP_WINDOW_MS = 60_000;
const APP_MAX_REQUESTS = 60;
const appBuckets = new Map();

function appSafeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function checkAppAccess(req, res) {
  const expected = process.env.APP_ACCESS_TOKEN;
  if (expected && expected.trim().length > 0) {
    const got = req.headers && req.headers['x-app-token'];
    const token = Array.isArray(got) ? got[0] : got;
    if (!token || !appSafeEqual(token, expected.trim())) {
      res.status(401).json({ error: { message: 'Unauthorized: missing or invalid x-app-token.' } });
      return false;
    }
  }
  const fwd = req.headers && req.headers['x-forwarded-for'];
  const raw = Array.isArray(fwd) ? fwd[0] : fwd;
  const ip = (raw ? String(raw).split(',')[0].trim() : '') || 'unknown';
  const now = Date.now();
  const bucket = appBuckets.get(ip);
  if (!bucket || now - bucket.windowStart >= APP_WINDOW_MS) {
    appBuckets.set(ip, { count: 1, windowStart: now });
  } else {
    bucket.count += 1;
    if (bucket.count > APP_MAX_REQUESTS) {
      res.setHeader('Retry-After', Math.ceil((bucket.windowStart + APP_WINDOW_MS - now) / 1000));
      res.status(429).json({ error: { message: 'Too many requests. Slow down and retry shortly.' } });
      return false;
    }
  }
  if (appBuckets.size > 5000) {
    for (const [key, b] of appBuckets) {
      if (now - b.windowStart >= APP_WINDOW_MS) appBuckets.delete(key);
    }
  }
  return true;
}
// ---- End inline app access control ----

export const config = { maxDuration: 30 };

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const MAX_IMAGES = 4;
const MAX_IMG_BYTES = 3_000_000;

const absolutize = (src: string, base: string): string | null => {
  try { return new URL(src, base).href; } catch { return null; }
};

function extract(html: string, baseUrl: string) {
  const pick = (re: RegExp) => (html.match(re)?.[1] ?? '').trim();
  const title = pick(/<title[^>]*>([^<]*)<\/title>/i);
  const description =
    pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) ||
    pick(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i);

  // Image candidates: og:image first, then <img> sources.
  const imgs: string[] = [];
  const og = pick(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']*)["']/i);
  if (og) imgs.push(og);
  const re = /<img[^>]+src=["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && imgs.length < 24) {
    const s = m[1];
    if (/\.svg|sprite|logo|icon|favicon|pixel|\.gif/i.test(s)) continue;
    imgs.push(s);
  }
  const imageUrls = [...new Set(imgs.map(s => absolutize(s, baseUrl)).filter(Boolean) as string[])];

  // Visible text: strip scripts/styles/tags, collapse whitespace.
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 9000);

  return { title, description, text, imageUrls };
}

export default async function handler(req: any, res: any) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-app-token');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: { message: 'POST only' } }); return; }
  if (!checkAppAccess(req, res)) return;

  const payload = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {});
  let url: URL;
  try {
    url = new URL(String(payload.url || ''));
    if (!/^https?:$/.test(url.protocol)) throw new Error('bad protocol');
  } catch {
    res.status(400).json({ error: { message: 'Expected JSON { url: "https://…" }.' } });
    return;
  }

  try {
    const page = await fetch(url.href, {
      headers: { 'user-agent': UA, accept: 'text/html' },
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
    });
    if (!page.ok) {
      res.status(502).json({ error: { message: `Site responded ${page.status}` } });
      return;
    }
    const html = await page.text();
    const { title, description, text, imageUrls } = extract(html, url.href);

    // Download up to MAX_IMAGES images as data URLs for the vision model.
    const images: Array<{ src: string; dataUrl: string }> = [];
    for (const src of imageUrls) {
      if (images.length >= MAX_IMAGES) break;
      try {
        const r = await fetch(src, {
          headers: { 'user-agent': UA, referer: url.href },
          signal: AbortSignal.timeout(10_000),
        });
        if (!r.ok) continue;
        const mime = r.headers.get('content-type') || 'image/jpeg';
        if (!mime.startsWith('image/')) continue;
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length < 15_000 || buf.length > MAX_IMG_BYTES) continue; // skip icons + monsters
        images.push({ src, dataUrl: `data:${mime};base64,${buf.toString('base64')}` });
      } catch { /* skip broken images */ }
    }

    res.status(200).json({ title, description, text, images });
  } catch (err: any) {
    res.status(502).json({ error: { message: 'Fetch failed', detail: err?.message || String(err) } });
  }
}
