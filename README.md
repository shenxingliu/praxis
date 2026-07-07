# Praxis — AI-agent design studio

会越用越懂品牌的视觉生产系统。Praxis 现在作为独立项目运行，线上地址：https://praxis-dun-one.vercel.app/。

## 产品定位

单用户（暂无账号体系）· 多品牌工作区 · 预算可输入（月度上限 + 每次生成计成本 + 超限拦截）· LoRA 留门（好评图连同完整生成元数据存档，可导出为训练集）。

## 架构

```
src/domain/types.ts      核心实体：Brand / Asset(hero truth) / Reference / Element / Knowledge / Job
src/storage/provider.ts  存储抽象接口
src/storage/local.ts     IndexedDB 本地实现；配置 Supabase env 后自动切换云端存储
src/storage/supabase.ts  praxis_* 独立表，和旧项目数据隔离
src/engine/gemini.ts     Gemini 客户端与 Praxis /api/generate 代理
src/engine/engine.ts     统一生成管道：上下文解析 -> prompt -> 预算闸 -> 生成 -> 记账
src/engine/recipes.ts    scene / silo / detail / fabric 配方
src/learning/learning.ts 学习闭环：信号采集 -> 蒸馏规则 -> 好评图晋升参考图
api/generate.ts          Vercel Gemini generateContent 代理
api/fetch-site.ts        品牌网站抓取代理
```

学习闭环的应用发生在 engine 里：规则按 scope 匹配注入 prompt；被点赞的成果图作为参考图直接喂给模型。北极星指标 = 采纳率（保存/导出 ÷ 生成总数）。

## 开发

```bash
npm install
npm run dev        # http://localhost:5200
npm run build      # TypeScript + Vite production build
```

本地开发默认把 /api 请求代理到 Praxis 线上 Vercel app。生产部署需要在 Vercel 配置 GEMINI_API_KEY；如启用访问令牌，还需要 APP_ACCESS_TOKEN，并在前端环境配置 VITE_APP_ACCESS_TOKEN。

## 数据

- 默认：IndexedDB 本地存储，适合离线开发。
- 云端：配置 VITE_SUPABASE_URL 和 VITE_SUPABASE_ANON_KEY 后使用 Supabase 的 praxis_* 表。
- Legacy import：scripts/migrate-v1.mjs 和 System 页的 legacy 按钮仅用于一次性导入旧数据，正常运行不依赖旧项目。

## 路线图

- **M1** 独立项目、域模型、存储抽象、生成引擎、学习闭环 ✅
- **M2** Studio / Weave / Heroes / Library / Brain 工作流打磨
- **M3** Board 节点画布模式、批量队列、生成前自检、成本看板
