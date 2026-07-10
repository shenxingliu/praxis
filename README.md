# Praxis

**The open-source AI design studio that learns your brand.**

Most AI creative tools are stateless — every generation starts from zero, and your taste walks out the door when the tab closes. Praxis is built around the opposite bet: **every verdict you give becomes brand memory**. Likes, critiques, saved images, corrections — all of it distills into rules, calibrates the in-house critic, and feeds the next generation. Use it for a month and the gap isn't features; it's a month of your brand's taste data.

Live demo: https://praxis-dun-one.vercel.app · License: MIT · 中文说明[在文末](#中文快览)

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

## 中文快览

**Praxis 是一个会越用越懂你品牌的开源 AI 设计工作室。** 大多数 AI 创意工具是无状态的 —— 每次生成都从零开始；Praxis 押相反的注：你的每一次评判（点赞、批评、保存、修正）都会沉淀为品牌记忆 —— 蒸馏成规则、校准内置评委、喂给下一次生成。

- **Studio**：对话式 agent 生产线 —— brief → 三个创意方向 → 排产计划（生成前预检品牌冲突）→ 拍摄（批量质检门自动返工废片）→ 设计评审（建议一键重拍）。随时插话，你的话变成后续每一步都服从的指令。
- **Canvas**：节点画布 + 驻场评委 —— 任何产出图一键 Crit 评分，美术指导自动把批评意见改写回 prompt，重跑对比。多角度产品、旋转视图、转台 GIF、12 维风格提取。
- **资产保真**：产品照片按"真值像素"对待，差异化压缩保细节，主体档案驱动保真规则。
- **成长面板**：品味对齐率曲线、规则积累、高频批评 —— 学习过程可视化。
- **成本诚实**：BYOK 自带 Gemini key（约 $0.04/张 Flash），月度预算上限 + 超限拦截；或 Vercel 代理模式，key 永不出服务端。

快速开始：`npm install && npm run dev`，打开 System 页粘贴 [Google AI Studio](https://aistudio.google.com/apikey) 的免费 key 即可，数据默认存本地 IndexedDB。云端同步与部署见上文英文说明。

## License

[MIT](LICENSE) © Jim Liu
