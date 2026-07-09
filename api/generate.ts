// Vercel Serverless Function: colon-free Gemini generateContent proxy.
//
// Why this exists: Vercel's router returns a platform 404 for request
// paths containing ':' (e.g. /models/gemini-2.5-flash:generateContent),
// so the pass-through proxy at /api/gemini/[...path] can never receive
// generateContent calls. This endpoint moves the model into the JSON
// body instead:
//
//   POST /api/generate  { "model": "gemini-2.5-flash", "body": { ...REST generateContent body... } }
//
// and forwards to
//   POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
//
// Auth: same shared-token + rate-limit scheme as the other endpoints.

// ---- Inline app access control ----
// (Shared logic duplicated per-function on purpose: Vercel compiles api/*.ts
// to ESM where extensionless relative imports fail at runtime, so functions
// must stay self-contained.)
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
  if (!expected || expected.trim().length === 0) {
    // Auth is optional by design, but a missing env var must not be silent —
    // an open endpoint burns API quota for whoever finds it.
    console.warn('[api/generate] APP_ACCESS_TOKEN is not set — endpoint accepts unauthenticated requests');
  }
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


export const config = {
  // Pro-model image generation regularly takes 30-90s. Fluid compute
  // (default on new projects) allows up to 300s on Hobby.
  maxDuration: 300,
};

const UPSTREAM = 'https://generativelanguage.googleapis.com/v1beta/models';
const MODEL_RE = /^[a-z0-9.-]+$/i;

export default async function handler(req: any, res: any) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-app-token');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: { message: 'POST only' } });
    return;
  }

  if (!checkAppAccess(req, res)) return;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error: { message: 'Server is missing GEMINI_API_KEY. Set it in Vercel env and redeploy.' },
    });
    return;
  }

  const payload = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {});
  const model = String(payload.model || '');
  const body = payload.body;
  if (!MODEL_RE.test(model) || !body) {
    res.status(400).json({ error: { message: 'Expected JSON { model, body }.' } });
    return;
  }

  try {
    const upstream = await fetch(`${UPSTREAM}/${model}:generateContent`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(body),
    });
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader('content-type', upstream.headers.get('content-type') || 'application/json');
    res.send(text);
  } catch (err: any) {
    res.status(502).json({
      error: { message: 'Upstream error', detail: err?.message || String(err) },
    });
  }
}
