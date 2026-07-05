# Praxis — AI-agent design studio

会越用越懂品牌的视觉生产系统。设计文档见上级目录 `LUMINA-2.0-需求与产品思考.md`。

V1.3 继续在 GitHub/Vercel 上服务；本项目独立开发，稳定后迁移到新仓库。

## 已确认的产品决策

单用户（暂无账号体系）· 预算可输入（月度上限 + 每次生成计成本 + 超限拦截）· LoRA 留门（好评图连同完整生成元数据存档，可导出为训练集）。

## 架构

```
src/domain/types.ts      三实体：Asset(产品真值) / Reference(审美参考) / Knowledge(经验规则)
src/storage/provider.ts  存储抽象接口（唯一持久化缝隙）
src/storage/local.ts     M1: IndexedDB 实现；M2 换 Supabase 只需重写这一个文件
src/engine/gemini.ts     Gemini 客户端（复用 V1 的代理/鉴权约定）+ 成本估算
src/engine/engine.ts     统一生成管道：上下文解析 → 配方出 prompt → 预算闸 → 生成 → 记账
src/engine/recipes.ts    四配方（scene/silo/detail/fabric）= 数据 + prompt builder
src/learning/learning.ts 学习闭环：信号采集(显式+隐式) → 蒸馏成规则 → 好评图晋升为参考图
scripts/migrate-v1.mjs   V1 数据迁移（只读 ../data，产出 migration-out/）
```

学习闭环的应用发生在 engine 里：规则按 scope 匹配注入 prompt；被点赞的成果图作为参考图直接喂给模型（Pro 支持 14 张参考图）。北极星指标 = 采纳率（保存/导出 ÷ 生成总数）。

## 开发

```bash
npm install
npm run migrate:v1     # 解析 V1 数据 → migration-out/
npm run dev            # http://localhost:5200 · M1 面板里点 Import 导入迁移数据
```

代理模式与 V1 相同：`VITE_USE_PROXY=true` + 服务端 `GEMINI_API_KEY`（+ `APP_ACCESS_TOKEN`）。

## 路线图

- **M1（当前）** 地基：域模型、存储抽象、生成引擎、学习闭环、V1 迁移 ✅
- **M2** CREATE 界面（从 V1.3 WorkspaceApp 移植）+ Knowledge 经验库页面 + Supabase 接入
- **M3** Board 节点画布模式、批量队列、生成前自检、成本看板
