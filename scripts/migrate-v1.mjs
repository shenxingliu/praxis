#!/usr/bin/env node
/**
 * V1 → 2.0 data migration.
 *
 * Reads the V1 repo data (this project lives inside it as ./lumina-2.0):
 *   ../data/inventory/*.json        → assets.json
 *   ../data/bulk/brand-profile.json → brand-profile.json
 *   ../src/constants/feedback.json  → signals.json (like/dislike history)
 *   ../public/material-references/  → references.json (material swatches)
 *
 * Writes normalized JSON to ./migration-out/. The app's Import button (or
 * the Supabase seeder later) loads these via storage.importBulk().
 * READ-ONLY on V1 data — nothing in ../ is modified.
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const v1Root = join(here, '..', '..');
const outDir = join(here, '..', 'migration-out');
mkdirSync(outDir, { recursive: true });

const readJson = (p) => JSON.parse(readFileSync(p, 'utf-8'));
const report = {};

// ---- Assets from inventory ----
const assets = [];
const invDir = join(v1Root, 'data', 'inventory');
if (existsSync(invDir)) {
    for (const file of readdirSync(invDir).filter(f => f.endsWith('.json'))) {
        try {
            const item = readJson(join(invDir, file));
            if (!item?.name) continue;
            assets.push({
                // Deterministic: reuse the V1 id so re-imports upsert, not duplicate.
                id: `v1a:${item.id}`,
                v1Id: item.id,
                name: item.name,
                category: item.category,
                collection: item.collection,
                finish: item.finish,
                tags: item.tags ?? [],
                photos: (item.photos ?? []).map((p, i) => ({
                    id: `v1p:${item.id}:${i}`,
                    image: { kind: 'data', value: p },
                    role: item.photoMeta?.[i]?.role ?? (i === 0 ? 'hero' : 'detail'),
                })),
                dimensions: item.dimensions,
                createdAt: Date.now(),
                updatedAt: Date.now(),
            });
        } catch (e) {
            console.warn(`skip ${file}: ${e.message}`);
        }
    }
}
report.assets = assets.length;
writeFileSync(join(outDir, 'assets.json'), JSON.stringify(assets));

// ---- Brand profile ----
const brandPath = join(v1Root, 'data', 'bulk', 'brand-profile.json');
if (existsSync(brandPath)) {
    const v1 = readJson(brandPath);
    const src = v1?.payload ?? v1;
    const brand = {
        brandName: src.brandName ?? 'Greenington',
        identity: src.identity ?? '',
        emotionalAnchors: src.emotionalAnchors ?? [],
        environmentSignature: {
            architecture: src.environmentSignature?.architecture ?? [],
            lightCharacter: src.environmentSignature?.lightCharacter ?? [],
            spatialPalette: src.environmentSignature?.spatialPalette ?? [],
        },
        forbiddenMoves: src.forbiddenMoves ?? [],
        v1Raw: src,
    };
    writeFileSync(join(outDir, 'brand-profile.json'), JSON.stringify(brand));
    report.brandProfile = 1;
} else {
    report.brandProfile = 0;
}

// ---- Feedback → signals (history preserved for future distillation) ----
const signals = [];
const fbPath = join(v1Root, 'src', 'constants', 'feedback.json');
if (existsSync(fbPath)) {
    for (const e of readJson(fbPath)) {
        signals.push({
            id: `v1s:${e.imageId}:${e.timestamp ?? 0}`,
            resultId: `v1:${e.imageId}`,
            type: e.rating === 'like' ? 'like' : 'dislike',
            reason: e.reason,
            scope: {
                outputType: 'scene',
                room: e.sceneName?.toLowerCase().includes('bedroom') ? 'Bedroom' : undefined,
            },
            createdAt: e.timestamp ?? Date.now(),
            distilled: false,
        });
    }
}
report.signals = signals.length;
writeFileSync(join(outDir, 'signals.json'), JSON.stringify(signals));

// ---- Backdrop plates (Silo anchoring) → references(kind 'plate') ----
const references = [];
const platesDir = join(v1Root, 'data', 'plates');
if (existsSync(platesDir)) {
    for (const file of readdirSync(platesDir).filter(f => f.endsWith('.json'))) {
        try {
            const p = readJson(join(platesDir, file));
            if (!p?.imageData) continue;
            references.push({
                id: `v1plate:${p.id}`,
                kind: 'plate',
                name: p.name || 'Plate',
                image: { kind: 'data', value: p.imageData },
                tags: ['v1-plate'],
                source: 'upload',
                weight: 1,
                createdAt: p.createdAt ?? Date.now(),
            });
        } catch (e) {
            console.warn(`skip plate ${file}: ${e.message}`);
        }
    }
}

// ---- Material references (file list only — images stay on disk; the app
//      imports the actual pixels from public/ at import time) ----
const matDir = join(v1Root, 'public', 'material-references');
if (existsSync(matDir)) {
    for (const material of readdirSync(matDir, { withFileTypes: true }).filter(d => d.isDirectory())) {
        for (const img of readdirSync(join(matDir, material.name)).filter(f => /\.(jpe?g|png|webp)$/i.test(f))) {
            references.push({
                id: `v1mat:${material.name}:${img}`,
                kind: 'material',
                name: `${material.name} · ${basename(img, extname(img))}`,
                image: { kind: 'url', value: `/material-references/${material.name}/${img}` },
                tags: [material.name],
                source: 'upload',
                weight: 1,
                createdAt: Date.now(),
            });
        }
    }
}
report.references = references.length;
writeFileSync(join(outDir, 'references.json'), JSON.stringify(references));

console.log('Migration complete →', outDir);
console.table(report);
