# Praxis

**The open-source AI design studio that learns your brand.**

Most AI creative tools are stateless — every generation starts from zero, and your taste walks out the door when the tab closes. Praxis is built around the opposite bet: **every verdict you give becomes brand memory**. Likes, critiques, saved images, corrections — all of it distills into rules, calibrates the in-house critic, and feeds the next generation. Use it for a month and the gap isn't features; it's a month of your brand's taste data.

Live demo: https://praxis-dun-one.vercel.app · License: MIT

---

## What's inside

**🎬 Studio — an agent production line, not a prompt box.**
Chat-first workflow: brief → three creative directions → production plan → shoot → design crit. The plan gets a **pre-flight check** against your brand soul *before* any image spend; batch runs pass a **quality gate** (weak shots are re-shot with the critic's fixes before you ever see them); the final crit's suggestions are one click away from a targeted reshoot. Interject at any moment — your notes become standing directives every later step obeys.

**🎨 Canvas — a node board with a resident critic.**
Wire assets, prompts, extracted style facets and outputs on an infinite glass canvas. Any output can be **Crit**-ed on the spot (scored against brand soul on narrative / sensation / viewing), and the art director can **fold the critique back into the prompt automatically** — rewrite, re-run, compare. Multi-angle products, rotate-view generation with angle awareness, turntable GIF export, 12-dimension style extraction from any image.

**📦 Assets — source-of-truth fidelity.**
Product photos are treated as pixels-of-record: differential compression keeps construction and texture detail sharp into the model, subject profiles (product / person / food / apparel / space) drive fidelity and staging rules, multi-angle photo sets feed the nearest-angle reference automatically.

**🧠 Brand memory — the moat.**
Brand soul with locked red-lines, knowledge rules distilled from your feedback, a critic that **calibrates to your taste** (keep a set it scored low — it learns it was too strict), and a **Growth dashboard** that makes the learning visible: taste-alignment trend, rules accumulated, what you push back on most.

**💰 Honest costs.**
BYOK: your Gemini key, in your browser, ~$0.04 per Flash image — with a monthly budget cap, per-generation accounting and overrun blocking built in. Or deploy with a server-side proxy key and never expose it.

**🎓 LoRA door.**
Every saved image is archived with its exact prompt and full recipe — export the curated set as training pairs whenever you're ready to fine-tune.

## Quickstart (2 minutes, zero config)

```bash
git clone https://github.com/shenxingliu/praxis
cd praxis
npm install
npm run dev        # http://localhost:5200
```

Open **System → paste your Gemini API key** (get one free at [Google AI Studio](https://aistudio.google.com/apikey)). The key lives in your browser's localStorage only. Data persists in IndexedDB — fully offline, nothing to set up.

## Cloud sync (optional)

Want your brands, assets and results synced across devices? Create a free [Supabase](https://supabase.com) project, run [`praxis-tables.sql`](praxis-tables.sql) in its SQL editor (tables + image storage bucket in one paste), then add to `.env.local`:

```bash
VITE_SUPABASE_URL=https://<your-project>.supabase.co
VITE_SUPABASE_ANON_KEY=<your-anon-key>
```

Images are stored in a Supabase Storage bucket; database rows stay lean (URLs + metadata only). If you have older rows with inline images, **System → Migrate images to Storage** backfills them.

> Current policies are single-user (open). Before sharing a deployment with others, lock down RLS.

## Deploying to Vercel (proxy mode — key never leaves the server)

1. Fork this repo, import into Vercel.
2. Project → Settings → Environment Variables:
   - `GEMINI_API_KEY` — server-side only, never bundled
   - `APP_ACCESS_TOKEN` — a passphrase so strangers can't burn your quota
   - `VITE_USE_PROXY=1`
   - `VITE_APP_ACCESS_TOKEN` — same passphrase (this one is bundled; it gates the proxy, it is not a secret key)
3. The browser only ever talks to `/api/generate`; the Gemini key stays server-side.

**Key hygiene** (Google AI Studio): restrict the key to the Generative Language API, set a daily quota + billing alert, rotate on any suspicion. Never set `VITE_GEMINI_API_KEY` on a public deployment — `VITE_` variables are compiled into public JS.

## Architecture

```
src/domain/types.ts      Core entities: Brand / Asset / Reference / Element / KnowledgeRule / PraxisJob
src/storage/provider.ts  Storage abstraction — IndexedDB by default, Supabase when configured
src/storage/images.ts    Image offloading: pixels → storage bucket, rows keep URLs
src/engine/gemini.ts     Gemini client (BYOK or proxy), budget-aware, image preparation
src/engine/engine.ts     Unified generation pipeline: context → prompt → budget gate → generate → account
src/engine/weave.ts      Canvas generation: role manifests, angle awareness, facet extraction
src/studio/agents.ts     The agent crew: concepts, planner, pre-flight critic, quality gate,
                         design critic (owner-calibrated), art director (prompt rewrite)
src/learning/learning.ts Learning loop: signals → distilled rules → promoted references
src/brain/soul.ts        Brand soul: axes, weights, locked red-lines, feedback attribution
src/ui/GrowthView.tsx    The dashboard that makes the learning visible
api/generate.ts          Vercel serverless Gemini proxy
```

## Roadmap

- ✅ Agent workflow (brief → concepts → plan → shoot → review) with conversational steering
- ✅ Critic loop: pre-flight, quality gate, calibration, crit-to-reshoot, crit-to-prompt-rewrite
- ✅ Growth dashboard · image storage offloading · task history
- ⏳ Batch catalog production (N products → PDP sets, gate-checked, zipped)
- ⏳ Motion node (product turntable / cinemagraph via video models)
- ⏳ Multi-model adapters (FLUX / SD via fal.ai, BYOK)
- ⏳ Multi-user RLS + team spaces

## License

[MIT](LICENSE) © Jim Liu
