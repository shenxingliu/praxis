import { GIFEncoder, quantize, applyPalette } from 'gifenc';

/**
 * Encode a set of frames (data URLs) into a looping GIF, client-side.
 * Used by the Canvas rotate node to turn the 8 turntable views into a
 * product spin animation — zero extra API cost, the views already exist.
 */

const loadImage = (src: string): Promise<HTMLImageElement> =>
    new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('GIF frame failed to load.'));
        img.src = src;
    });

export async function encodeSpinGif(frames: string[], size = 512, delayMs = 160): Promise<Blob> {
    if (frames.length < 2) throw new Error('Need at least 2 frames for a GIF.');
    const gif = GIFEncoder();
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Canvas 2D unavailable.');

    for (const src of frames) {
        const img = await loadImage(src);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, size, size);
        const scale = Math.min(size / img.naturalWidth, size / img.naturalHeight);
        const w = img.naturalWidth * scale;
        const h = img.naturalHeight * scale;
        ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
        const { data } = ctx.getImageData(0, 0, size, size);
        const palette = quantize(data, 256);
        const index = applyPalette(data, palette);
        gif.writeFrame(index, size, size, { palette, delay: delayMs });
    }

    gif.finish();
    return new Blob([gif.bytes()], { type: 'image/gif' });
}
