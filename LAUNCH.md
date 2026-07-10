# Praxis Launch Playbook

> Self-contained: hand this to any AI assistant or collaborator and execute top-to-bottom — no extra context needed.
> Every task states WHAT to do and HOW to verify. Check items off as you go.
> Created 2026-07-08, updated 2026-07-10. Launch timing is Jim's call; until he says "launch", only Stage 0 may be executed.

## 1 · Background (required reading for the executor)

**Product**: Praxis — an open-source AI design studio that learns your brand. Users upload product / scene / people photos (Assets) as pixel ground-truth, combine inspiration references, style facet cards and rotate views on a free-form node canvas (Canvas), or run the conversational agent pipeline (Studio: brief → concepts → plan → shoot → review). Built-in critic system (pre-flight plan check, batch quality gate, design crit with owner calibration) and a learning loop (verdicts distill into rules; the studio gets better with use — visible on the Growth dashboard).

**Technical facts** (know these before writing any copy):
- Repo: github.com/shenxingliu/praxis — **already Public**
- Live instance: https://praxis-dun-one.vercel.app/ (proxy mode; key lives server-side on Vercel)
- Stack: React + Vite SPA + Vercel serverless (api/generate proxies Gemini)
- License: MIT (done)
- Key scheme: open-source users BYOK (paste your own Gemini key on the System page, stored in localStorage); the hosted instance uses a server-side proxy + APP_ACCESS_TOKEN passphrase. **No free hosted generation is promised.**
- Cost story: Flash tier $0.04/image, Pro tier (with the consistency inspector) $0.24/image
- Differentiation — ALL promo copy orbits these; never write "yet another AI image tool":
  1. **Pixel-faithful products**: ground-truth photos bracket the prompt + post-generation inspector + surgical correction + ✓/⚠ badges
  2. **Learns your brand**: feedback signals → distilled rules → liked images promoted to references; critic calibrates to the owner's taste; Growth dashboard makes it visible
  3. **Two workflows, one brain**: conversational agent pipeline (Studio) and node canvas (Canvas) share the same critic, calibration memory and learning loop
  4. **Cross-category**: assets typed product / person / food / apparel / space — fidelity, staging and inspector standards adapt per type; not just a furniture tool

**Already done** (do not redo): MIT LICENSE, BYOK input (System page), .env.example, English README with deploy + key-security sections, two code-review rounds (13 fixes: brand isolation, budget race, consistency honesty, reference index alignment, memory caps…), image storage offloading (Supabase bucket), critic loop, Growth dashboard.

## 2 · Stage 0 — pre-launch prep (safe to do before launch)

- [x] **0.1 English README** — done 2026-07-10 (positioning, features, quickstart, deploy, architecture, roadmap).

- [ ] **0.2 Screenshots / GIF assets** (needs real generations from Jim's product photos — no placeholders)
  Shot list: ① Studio conversation flow with a plan + amber pre-flight warnings ② Canvas with nodes wired + a finished output ③ Canvas Crit panel on an output ④ Growth dashboard with a real taste-alignment curve ⑤ turntable 360° eight-view spread.
  Verify: README gets at least 1 hero image; files live in docs/media/.

- [ ] **0.3 Demo video (60–90s)** — storyboard ready in Appendix A; Jim records.
  Verify: real-speed screen capture (generation waits may be time-lapsed and labeled), understandable with sound off, uploaded to YouTube + linked from the repo.

- [ ] **0.4 Vercel env confirmation** (Jim or anyone with Vercel access)
  Confirm the praxis project has: GEMINI_API_KEY, APP_ACCESS_TOKEN, VITE_USE_PROXY=1, VITE_APP_ACCESS_TOKEN.
  Verify: a request without the passphrase gets 401 from /api/generate.

- [ ] **0.5 Supabase RLS** (only if cloud storage stays enabled; skip for local-IndexedDB-only)
  Add row-level security to all praxis_* tables and the praxis-images bucket.
  Verify: an anonymous key cannot read or write another user's data.

- [ ] **0.6 First-run self-audit**: open the live site in a fresh browser (no cache) —
  can a stranger understand "paste key → upload product photos → first image" within 3 minutes?
  Fix any onboarding gaps found (empty states, first-run hints).
  Verify: someone who has never seen it produces a first image without reading docs.

- [ ] **0.7 GitHub repo grooming** (last thing before launch day)
  Settings → Code security: enable Secret scanning + Push protection.
  About: description + topics `ai` `image-generation` `gemini` `design-tools` `node-canvas` `brand` `agents`. Confirm Issues are enabled.
  Suggested description: `The open-source AI design studio that learns your brand — agent workflow, resident critic, brand memory. BYOK Gemini.`

## 3 · Stage 1 — launch week (ONLY after Jim says "launch")

**D0 (launch day)**
- [ ] Show HN post. Title (may tune):
  `Show HN: Praxis – an AI design studio that learns your brand`
  Body beats: why (product photography cost), the three differentiators, BYOK free self-use, MIT, and a SPECIFIC feedback ask ("would you trust the consistency inspector's verdicts?" beats "feedback welcome").
- [ ] Same day: first X/Twitter thread (3–5 posts: pain point → demo video → differentiators → link).
- [ ] Chinese channels: Jike + V2EX share posts — translate/adapt the Appendix B template into Chinese when posting (channel copy is written at post time; this playbook stays English).

**D1–D7**
- [ ] Check and answer every comment/issue twice daily (HN especially in the first 6 hours).
- [ ] Reddit r/SideProject and r/artificial, one post each, 1–2 days apart, rewritten not copy-pasted.
- [ ] 1–2 Xiaohongshu posts aimed at home-goods e-commerce operators (adapt Appendix B).
- [ ] Record the metrics baseline (Section 5).

## 4 · Stage 2 — vertical depth (weeks 2–8 post-launch, feedback-driven)

- [ ] Write one case study: the real Greenington furniture workflow with hard numbers
  (cost per image, turnaround vs a photo studio). English + Chinese versions.
- [ ] Direct outreach to furniture / home-goods DTC and cross-border e-commerce communities
  (WeChat groups, Facebook groups, r/FulfillmentByAmazon…) — open with the case study, not the product page.
- [ ] Collect BYOK-user feedback; probe willingness to pay for a hosted tier ("would you pay $X/mo to skip key setup?").
- [ ] If payment intent is clear → green-light Stage 3: Supabase Auth + RLS + server-side pooled key + per-user quotas + Stripe. No investment before that signal.

## 5 · Metrics (record weekly)

| Metric | Tool |
|---|---|
| GitHub stars / forks / issues | repo page |
| Live-site UV, key-paste conversion, first-image completion | Vercel Analytics (enable it) |
| Per-channel post impressions/clicks | each platform's dashboard |
| North star: adoption rate (saves + exports ÷ generations) | already instrumented (learning signals) |

## 6 · Risks & responses

- **HN flops** (the common case): normal — repost once ~2 weeks later with a different narrative angle (allowed by HN rules).
- **Proxy abuse**: APP_ACCESS_TOKEN already blocks strangers; rotate the passphrase if it leaks.
- **Someone ships a paid fork**: MIT allows it. The moat is iteration speed and accumulated learning data, not the code.
- **Gemini policy/price changes**: under BYOK the exposure is on the user side; just track official announcements.

---

## Appendix A — demo video storyboard (60–90s)

1. 0–8s: pain-point caption "One product photo shoot: $2,000. This image: $0.24." over a finished shot
2. 8–20s: drag 3 product photos onto Canvas → Asset nodes appear
3. 20–35s: add an inspiration image → Extract → facet cards pop out → pick only LIGHT and MATERIAL
4. 35–50s: wire to Output → Run → result appears → push in on the ✓ consistency badge
5. 50–65s: rotate node, drag the 3D trackball → render 135° → 360° eight-view spread
6. 65–80s: 👍 an image → a freshly distilled rule appears in Brand memory + the Growth curve ticks up (caption: "it learns your brand")
7. 80–90s: GitHub URL + "MIT licensed. Bring your own free Gemini key."

## Appendix B — copy templates (adapt per channel; translate to Chinese for Chinese channels at post time)

**X/Twitter opener**:
"Product photography costs $100–500 per image. I built an open-source studio that turns real product photos into brand imagery for $0.24 — with an AI inspector that verifies the product stayed pixel-faithful, and a memory that learns your taste with every verdict. MIT licensed, bring your own free Gemini key. [video] [repo]"

**Jike / V2EX (translate to Chinese when posting)**:
"Open-sourced Praxis: an AI brand-imagery studio that treats real product photos as pixel ground-truth. Wire them with inspiration images and facet cards (take THIS photo's light + THAT one's material) on a node canvas, or run the conversational agent pipeline. A built-in inspector verifies the product didn't drift — and surgically corrects it if it did. Liked images distill into rules: it gets better the more you use it. MIT, works with your own free Gemini key. Feedback welcome: github.com/shenxingliu/praxis"

**Xiaohongshu (home e-commerce angle, translate to Chinese when posting)**:
Title: "A product shoot costs thousands. I got it down to $0.04 a shot."
Beats: before/after comparison (real shoot vs generated), stress "the product doesn't drift" (inspector mechanism), 3-step tutorial (upload product photos → pick scene inspiration → generate), GitHub link in comments.

## Appendix C — execution boundaries (for any AI model running this)

- Every outward-facing action (posting, changing repo settings) requires Jim's explicit confirmation first.
- Copy may be drafted on his behalf; account actions are performed or authorized by Jim.
- Do not alter two locked decisions: the key scheme (BYOK + proxy) and the MIT license.
- Code changes flow as usual: commit + push to praxis main.
- Everything published — code, comments, docs, filenames, UI copy — is written in English. (Channel copy for Chinese platforms is translated at post time.)
