# Canvas — feature design

Inspiration: Figma Weave. Essence: a free-form board — whatever you place on it gets woven into one image.

## Node types (all draggable, deletable, freely combinable)

| Node | Source | Role in generation |
|---|---|---|
| 🛋 **Product** | picked from the Assets library | Product ground truth: single or multi-angle photos all attached, **high fidelity** (fidelity rules + product exclusivity + inspector surgical correction) |
| 💡 **Concept** | picked from Inspiration concept cards | Abstract concept injection (V/F/C concept + grounded translation) |
| 🖼 **Image** | upload / drag-drop / generated results fed back | Fusion material: whole-image mood blending (light/palette/material/atmosphere), copying subjects forbidden |
| ⚡ **Facet card** | one-click extraction from an Image node | **Dimensional decomposition**: one image splits into light / palette / composition / material / texture / mood / space nodes — keep only the dimensions you want, delete the rest: "this image's LIGHT + that image's MATERIAL" |
| 📝 **Prompt** | add freely, multiple allowed | Free-form prompt / art direction, injected line by line (as detailed as you like) |

## Global controls (toolbar)

- **Ratio**: 1:1 / 16:9 / 4:3 / 3:4 / 9:16
- **Pixels**: 1K / 2K / 4K (auto-downgrades when unsupported)
- **Two tiers**: Draft (flash, $0.04, fast validation) → Weave pro ($0.24, final + consistency inspector)

## Dimensional extraction (the core mechanism)

Click ⚡ Extract on any Image node → one vision call splits out facet cards, each carrying a concrete description of its dimension. Generation then references dimensions precisely:

```
Image 5: FACET SOURCE — take ONLY its LIGHT and MATERIAL as described;
ignore its composition, palette, subjects entirely.
### DIMENSIONAL EXTRACTION ###
- From image 5, LIGHT: low warm side light, long soft shadows…
- From image 6, PALETTE: desaturated sage + bone white, low contrast…
```

The source pixels are still attached to the model (visual DNA preserved), but the role manifest restricts them to "these dimensions only" — a finer level of control than whole-image fusion.

## Fidelity system (same tier as Studio, fully inherited)

Product photos bracket the prompt · image role manifest · three iron rules (fidelity / exclusivity / mandatory staging) · soul red-lines · pro-tier consistency inspector + surgical correction · results carry ✓/⚠ badges. With no product on the board = pure aesthetic-reference generation mode (Fusion Lab's canvas form).

## Iteration loop

Result cards have a **↩ board** button — pull a generated image back onto the canvas as fusion material (and ⚡ extract it again), weaving generation after generation. ★ save to Gallery (feeds the training set) and ⬇ download as usual.
