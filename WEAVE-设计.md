# Weave 画布 — 功能设计

灵感：Figma Weave。本质：一块自由画板，板上放什么，就把什么织成一张图。

## 节点类型（都可拖动、可删除、可混搭）

| 节点 | 来源 | 在生成中的角色 |
|---|---|---|
| 🛋 **Product** | Products 库选择 | 产品真值：单个或多角度照片全部附上，**高度还原**（保真规则 + 家具排他 + 检查员手术纠错） |
| 💡 **Concept** | Library 概念卡选择 | 抽象概念注入（V/F/C 概念 + 落地转译） |
| 🖼 **Image** | 上传 / 拖放 / 生成结果回填 | 融合素材：整体气质融合（光/色/材质/氛围），禁止照抄主体 |
| ⚡ **Facet 维度卡** | 从 Image 节点一键分解 | **多维度分解组合**：一张图拆成 光线 / 色板 / 构图 / 材质 / 质感 / 氛围 / 空间感 7 个维度节点，只用想要的维度，删掉其余——"取这张的光 + 那张的材质" |
| 📝 **Prompt** | 任意添加，多个可并存 | 自由 prompt / 艺术指令，逐条注入（想写多细写多细） |

## 全局控制（工具栏）

- **比例**：1:1 / 16:9 / 4:3 / 3:4 / 9:16
- **像素**：1K / 2K / 4K（不支持时自动降级）
- **两档生成**：Draft（flash，$0.04，快速验证）→ Weave pro（$0.24，正式 + 一致性检查员）

## 多维度分解组合（核心机制）

任何 Image 节点点 ⚡ Decompose → 一次视觉调用拆出 7 张维度卡，每张带该维度的具体描述。生成时按维度精准引用：

```
Image 5: FACET SOURCE — take ONLY its LIGHT and MATERIAL as described; 
ignore its composition, palette, subjects entirely.
### DIMENSIONAL EXTRACTION ###
- From image 5, LIGHT: low warm side light, long soft shadows…
- From image 6, PALETTE: desaturated sage + bone white, low contrast…
```

即：源图像素照常附给模型（保留视觉 DNA），但角色清单限定"只许取这几个维度"——这是比整图融合更精细的一层。

## 保真体系（与 Studio 同级，全部继承）

产品照首尾夹击 · 图片角色清单 · 三条铁律（保真/排他/强制布置）· soul 红线 · pro 档一致性检查员 + 手术纠错 · 结果带 ✓/⚠ 徽章。无产品时 = 纯美学参考生成模式（Fusion Lab 的画布形态）。

## 迭代闭环

结果卡有 **↩ board** 按钮——把生成图拉回画布当融合素材（也可再 ⚡ 分解），一代一代织下去。★ 存 Gallery（进训练集）、⬇ 下载照常。
