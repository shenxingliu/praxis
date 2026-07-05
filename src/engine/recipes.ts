import { Recipe, promptBlocks, REALISM_SKELETON } from './engine';
import { Purpose } from '../domain/types';

/**
 * Output recipes — data + one prompt builder each. Brand-agnostic: every
 * brand-specific word comes from ctx.brand / ctx.contextMode / ctx.elements.
 *
 * 'scene' is the universal context recipe: its environment grammar and
 * realism come entirely from the brand's context mode — a furniture brand
 * gets a photorealistic room, a perfume brand gets a surreal dreamscape,
 * through the same recipe.
 */

const PURPOSE_DIRECTIVES: Record<Purpose, string> = {
    hero: 'Usage: e-commerce listing hero. Clean uncluttered stage, generous negative space centered on the product, calm even light, background that never competes. Must read instantly at thumbnail size.',
    pdp: 'Usage: product detail page image. The product clearly the protagonist within a believable, richly rendered environment. Balanced editorial composition, true-to-life product scale.',
    social: 'Usage: social media content. Atmospheric, mood-forward, a captured moment rather than a staged catalog. Tighter intimate framing; emotion lands before product.',
    seasonal: 'Usage: seasonal or campaign image. Weave the seasonal theme from the note into the environment, light and palette accents — brand voice always wins over the season. Thematic, never kitsch.',
};

export const RECIPES: Record<string, Recipe> = {
    scene: {
        id: 'scene',
        name: 'Context',
        referenceBudget: { assetPhotos: 8, aesthetic: 4 },
        defaultModel: 'pro',
        buildPrompt: ({ params, assets, rules, brand, contextMode, elements }) => {
            const skeleton = REALISM_SKELETON[contextMode?.realism ?? 'photographic'];
            return `${skeleton.opener}

${promptBlocks.productFidelity(assets, brand)}
${promptBlocks.brand(brand)}
${promptBlocks.context(contextMode)}
${promptBlocks.elements(elements)}
${promptBlocks.knowledge(rules)}
${promptBlocks.studio(params)}

### DIRECTION ###
${params.purpose ? PURPOSE_DIRECTIVES[params.purpose] : ''}
${params.room && !contextMode ? `Environment: ${params.room}.` : ''}
${params.note ? `Additional direction: ${params.note}` : ''}

### REQUIREMENTS ###
${skeleton.physics} Place every listed product naturally and prominently. Attached aesthetic reference images carry the extracted fragments above — follow their light, color and material language without copying their subjects.`;
        },
    },

    silo: {
        id: 'silo',
        name: 'Silo',
        referenceBudget: { assetPhotos: 10, aesthetic: 2 },
        defaultModel: 'pro',
        buildPrompt: ({ params, assets, rules, brand, plate }) => `Professional e-commerce product photography on a clean backdrop.

${promptBlocks.productFidelity(assets, brand)}
${promptBlocks.knowledge(rules)}
${promptBlocks.studio(params)}

### BACKDROP ###
${plate
        ? `PLATE-ANCHORED BACKDROP: the FIRST attached reference image is the backdrop plate. Reconstruct that exact backdrop — same surface, color, texture, lighting gradient — with ZERO drift, and place the product into it. Extrapolate naturally beyond the plate's edges if the frame is larger.`
        : params.backdrop === 'env'
            ? 'Softly styled environmental backdrop, shallow depth of field, product remains the unmistakable subject.'
            : `Seamless studio backdrop, ${params.backdrop === 'warm' ? 'warm gray (#EAE7E1)' : 'pure white (#FFFFFF)'}, soft studio lighting, gentle grounding shadow.`}
${params.bedding && params.bedding !== 'none' ? `Styling: dress the piece with ${params.bedding === 'styled' ? 'fully styled, neatly layered brand-neutral textiles' : 'minimal styling — a fitted layer only, crisp and unobtrusive'}.` : ''}
${params.note ? `Additional direction: ${params.note}` : ''}

### REQUIREMENTS ###
Product perfectly centered with ~${params.margin ?? 10}% margin to every edge, true colors, crisp material detail, no props touching the product, no text or watermarks. Catalog-grade, 8k.`,
    },

    detail: {
        id: 'detail',
        name: 'Detail',
        referenceBudget: { assetPhotos: 10, aesthetic: 2 },
        defaultModel: 'pro',
        buildPrompt: ({ params, assets, rules, brand }) => `Macro / close-up product craftsmanship photography.

${promptBlocks.productFidelity(assets, brand)}
${promptBlocks.brand(brand)}
${promptBlocks.knowledge(rules)}
${promptBlocks.studio(params)}

### SHOT ###
Focus: ${params.focus ?? 'the most distinctive construction or material detail'}.
Extreme fidelity to material texture and craft. Soft raking light that reveals surface topology. Shallow depth of field, f/2.8 feel.
${params.note ? `Additional direction: ${params.note}` : ''}

### REQUIREMENTS ###
Photorealistic macro photography, 8k, no invented details — every visible element must exist in the reference photos.`,
    },

    fabric: {
        id: 'fabric',
        name: 'Texture',
        referenceBudget: { assetPhotos: 8, aesthetic: 4 },
        defaultModel: 'pro',
        buildPrompt: ({ params, assets, rules, brand }) => `Material and texture presentation photography.

${promptBlocks.productFidelity(assets, brand)}
${promptBlocks.brand(brand)}
${promptBlocks.knowledge(rules)}
${promptBlocks.studio(params)}

### TREATMENT ###
Render the product with its surface material as the visual protagonist — weave, grain, texture and finish clearly legible. Soft daylight, neutral staging.
${params.note ? `Additional direction: ${params.note}` : ''}

### REQUIREMENTS ###
True material color and texture from the reference photos, photorealistic, 8k.`,
    },
};
