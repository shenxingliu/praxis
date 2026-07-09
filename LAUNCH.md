# Praxis 发布启动计划（执行手册）

> 本文档自包含：交给任何 AI 助手或协作者，按顺序执行即可，不需要额外背景。
> 每个任务写明"做什么 / 怎么验收"。执行时可以逐项打勾。
> 创建于 2026-07-08。启动时间由 Jim 决定，未启动前只执行"阶段 0"。

## 一、背景（执行者必读）

**产品**：Praxis — AI 品牌视觉生产系统。用户上传产品/场景/人物照片（Assets）作为像素真值，
在自由画布（Canvas）上组合灵感参考（Inspiration）、维度拆解卡（Facet）、转台视角（Rotate）
织出品牌成片；内置一致性检查员（生成后自动核对产品保真度并手术纠错）和学习闭环
（好评图蒸馏成规则，越用越懂品牌）。

**技术事实**（写文案前必须知道的）：
- 仓库：github.com/shenxingliu/praxis（当前 Private，启动时改 Public）
- 线上实例：https://praxis-dun-one.vercel.app/（代理模式，key 在 Vercel 服务端）
- 技术栈：React + Vite 单页应用 + Vercel serverless（api/generate 代理 Gemini）
- 许可证：MIT（已加）
- Key 方案：开源用户 BYOK（System 页粘贴自己的 Gemini key，存 localStorage）；
  自有实例走服务端代理 + APP_ACCESS_TOKEN 口令。**不承诺免费托管生成**
- 成本卖点：flash 档 $0.04/张，pro 档（带一致性检查员）$0.24/张
- 三个差异化叙事点（所有推广文案围绕这三点，不要写成"又一个 AI 生图工具"）：
  1. 产品像素级保真：真值照首尾夹击 + 生成后自动检查员 + 手术纠错 + ✓/⚠ 徽章
  2. 越用越懂品牌：反馈信号 → 蒸馏规则 → 好评图晋升参考，学习闭环
  3. 自由画布工作流：节点连线、7 维度 Facet 拆解（"取这张的光 + 那张的材质"）、
     3D 轨迹球转台任意视角 / 360°

**已完成**（不要重复做）：MIT LICENSE、BYOK 输入框（System 页）、
.env.example、README 部署与 Key 安全章节、两轮代码审查修复（品牌隔离/预算竞态/
一致性检查诚实化/参考图序号对齐/内存上限等 13 项）。

## 二、阶段 0 —— 启动前准备（未启动也可做）

- [ ] **0.1 英文 README**
  做什么：现 README 是中文。改为英文为主（顶部一句话 + hero 截图 + Features +
  Quick start + Deploy 章节），中文版移至 README.zh.md，两者互链。
  验收：GitHub 渲染正常，英文无机器翻译腔，Deploy 章节与现有中文内容一致。

- [ ] **0.2 截图 / GIF 物料**（需要 Jim 提供真实产品照生成的结果，不用占位图）
  清单：① Canvas 全景（多节点连线 + 一张成品）② 一致性检查 ✓ 徽章特写
  ③ Facet 维度选择面板 ④ 转台 360° 八视图 ⑤ Studio 批量出图。
  验收：README 顶部至少 1 张 hero 图 + Features 每条配图，文件放 docs/media/。

- [ ] **0.3 演示视频（60-90 秒）分镜脚本已备**（见附录 A），需要 Jim 录制。
  验收：真实速度录屏（生成等待可加速并标注），无声版也能看懂，上传 YouTube + 仓库链接。

- [ ] **0.4 Vercel 环境确认**（Jim 或有 Vercel 权限者执行）
  确认 praxis 项目已设：GEMINI_API_KEY、APP_ACCESS_TOKEN、VITE_USE_PROXY=1、
  VITE_APP_ACCESS_TOKEN。验收：无口令的请求被 /api/generate 拒绝（401）。

- [ ] **0.5 Supabase RLS**（若继续用云存储；仅本地 IndexedDB 则跳过）
  给所有 praxis_* 表配行级安全策略。验收：匿名 key 无法读写其他用户数据。

- [ ] **0.6 新手体验自查**：全新浏览器（无缓存）打开线上站 →
  是否 3 分钟内能明白"填 key → 上传产品照 → 生成第一张图"？
  修掉过程中发现的引导断点（空状态提示、首次引导）。
  验收：一个没用过的人不看文档能出第一张图。

- [ ] **0.7 GitHub 仓库整备**（启动日之前最后做）
  Settings → Code security 开 Secret scanning + Push protection；
  加 About 描述与 topics：`ai` `image-generation` `gemini` `design-tools`
  `node-canvas` `brand`；确认 Issues 开启。

## 三、阶段 1 —— 启动周执行（等 Jim 说"启动"再做）

**D0（启动日）**
- [ ] 仓库改 Public（Settings → General → Danger Zone → Change visibility）
- [ ] 发 Show HN。标题用（可微调）：
  `Show HN: Praxis – node canvas that weaves product photos into brand imagery`
  正文要点：为什么做（电商产品图成本）、三个差异点、BYOK 免费自用、MIT、
  求反馈的具体问题（"一致性检查员的判定你们信得过吗"比"求反馈"好）。
- [ ] 同日发 X/Twitter 首条线程（3-5 条：痛点 → demo 视频 → 差异点 → 链接）。
- [ ] 中文渠道：即刻 + V2EX 分享创造节点，用附录 B 中文模板。

**D1-D7**
- [ ] 每天固定两次查看并回复所有评论/Issue（HN 尤其头 6 小时）。
- [ ] Reddit r/SideProject、r/artificial 各一帖（间隔 1-2 天，改写勿复制）。
- [ ] 小红书 1-2 条面向家居电商运营的图文（用附录 B）。
- [ ] 记录指标基线（见第五节）。

## 四、阶段 2 —— 垂直深耕（启动后 2-8 周，视反馈）

- [ ] 写 1 篇 case study：Greenington 家具真实工作流，含具体数字
  （每张成本、出图时间 vs 摄影棚），中英各一版。
- [ ] 定向触达家具/家居 DTC 和跨境电商社群（微信群、Facebook groups、
  r/FulfillmentByAmazon 等），以 case study 而非产品页开场。
- [ ] 收集 BYOK 用户反馈，验证"托管付费版"意愿（问愿不愿意 $X/月免配 key）。
- [ ] 若付费意愿明确 → 立项阶段 3：Supabase Auth + RLS + 服务端统一 key +
  按用户配额 + Stripe。此前不投入。

## 五、指标（每周记录一次）

| 指标 | 工具 |
|---|---|
| GitHub stars / forks / issues | 仓库页 |
| 线上站 UV、填 key 转化、首图完成率 | Vercel Analytics（需开启） |
| 各渠道帖子的曝光/点击 | 各平台后台 |
| 北极星：采纳率（保存+导出 ÷ 生成数） | 应用内已埋（learning signals） |

## 六、风险与预案

- **HN 冷场**（多数情况）：正常，两周后换叙事角度重发一次（规则允许）。
- **API 代理被滥用**：APP_ACCESS_TOKEN 已挡陌生调用；若口令泄露就轮换。
- **有人部署收费竞品**：MIT 允许。护城河在迭代速度和学习闭环数据，不在代码。
- **Gemini 政策/价格变动**：BYOK 模式下风险在用户侧；关注官方公告即可。

---

## 附录 A：演示视频分镜（60-90s）

1. 0-8s：痛点字幕 "One product photo shoot: $2,000. This image: $0.24." 配成品图
2. 8-20s：拖 3 张产品照进 Canvas → 出现 Asset 节点
3. 20-35s：加一张灵感图 → 点 Facets → 7 维度卡弹出 → 只选 LIGHT 和 MATERIAL
4. 35-50s：连线到 Output → Run → 成品出现 → 镜头推近 ✓ consistency 徽章
5. 50-65s：转台节点拖 3D 立方体 → Render 135° → 360° 八视图铺开
6. 65-80s：Gallery 里点赞 → Brain 页出现新蒸馏规则（"越用越懂你的品牌"字幕）
7. 80-90s：GitHub 地址 + "MIT licensed. Bring your own free Gemini key."

## 附录 B：文案模板

**X/Twitter 首条**：
"Product photography costs $100-500 per image. I built an open-source canvas
that weaves real product photos into brand imagery for $0.24 — with an AI
inspector that verifies the product stayed pixel-faithful. MIT licensed,
bring your own free Gemini key. [视频] [repo链接]"

**即刻/V2EX（中文）**：
"开源了一个 AI 品牌视觉工具 Praxis：把真实产品照当'像素真值'，在节点画布上
和灵感图、维度拆解卡（只取这张的光、那张的材质）自由组合织成品牌成片。
生成后有个'检查员'自动核对产品有没有走样，不过关就手术式修一遍。
好评的图会被蒸馏成规则，越用越懂你的品牌。MIT 协议，填自己的免费 Gemini key
就能用。求砸反馈：github.com/shenxingliu/praxis"

**小红书（家居电商向）**：
标题：产品图拍一次几千块？我用 AI 把成本打到 2 毛一张
正文要点：晒对比图（实拍 vs 生成）、强调"产品不走样"（检查员机制）、
教程三步走（传产品照→选场景灵感→出图）、评论区放 GitHub 链接。

## 附录 C：执行边界（给代执行的 AI 模型）

- 所有对外发布动作（发帖、改仓库可见性）必须经 Jim 确认后执行。
- 文案可代拟，账号操作由 Jim 完成或授权。
- 不要修改 Key 方案（BYOK + 代理）和 MIT 许可这两个已定决策。
- 代码改动照常走 commit + push（praxis 仓库 main 分支）。
