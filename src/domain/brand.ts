import { Brand, ContextMode } from './types';

/**
 * Brand context — which workspace is active, and the Brand CRUD.
 *
 * The current brand id lives in localStorage (synchronous, importable by
 * storage providers without circular deps). The brands list itself lives
 * in storage kv under the global key 'praxis:brands'.
 */

const CURRENT_KEY = 'praxis:currentBrand';
export const BRAND_CHANGED_EVENT = 'praxis:brand-changed';
export const DEFAULT_BRAND_ID = 'greenington';

export const getCurrentBrandId = (): string => {
    try { return localStorage.getItem(CURRENT_KEY) || DEFAULT_BRAND_ID; } catch { return DEFAULT_BRAND_ID; }
};

export const setCurrentBrandId = (id: string): void => {
    try { localStorage.setItem(CURRENT_KEY, id); } catch { /* ignore */ }
    window.dispatchEvent(new Event(BRAND_CHANGED_EVENT));
};

// ---------------------------------------------------------------------------
// Brand CRUD (kv-backed; lazy storage import avoids circular deps)
// ---------------------------------------------------------------------------

const BRANDS_KEY = 'praxis:brands';

const seedGreenington = (): Brand => ({
    id: DEFAULT_BRAND_ID,
    name: 'Greenington',
    description: 'Premium solid-bamboo furniture brand — modern, sustainable, crafted; sold through dealers and direct.',
    productEssence: 'Exact silhouette, joinery, bamboo grain direction, finish color and hardware of each piece.',
    contextModes: [
        { id: 'bedroom', label: 'Bedroom', directive: 'A believable, lived-in bedroom interior appropriate to the brand.', realism: 'photographic' },
        { id: 'living', label: 'Living Room', directive: 'A believable living room interior appropriate to the brand.', realism: 'photographic' },
        { id: 'dining', label: 'Dining Room', directive: 'A believable dining room interior appropriate to the brand.', realism: 'photographic' },
        { id: 'office', label: 'Office / Study', directive: 'A believable home office or study interior appropriate to the brand.', realism: 'photographic' },
    ],
    createdAt: Date.now(),
    updatedAt: Date.now(),
});

export async function listBrands(): Promise<Brand[]> {
    const { storage } = await import('../storage/local');
    const brands = (await storage.kvGet<Brand[]>(BRANDS_KEY)) ?? [];
    if (brands.length === 0) {
        const seed = seedGreenington();
        await storage.kvSet(BRANDS_KEY, [seed]);
        return [seed];
    }
    return brands;
}

export async function getCurrentBrand(): Promise<Brand> {
    const brands = await listBrands();
    return brands.find(b => b.id === getCurrentBrandId()) ?? brands[0];
}

export async function saveBrand(brand: Brand): Promise<void> {
    const { storage } = await import('../storage/local');
    const brands = (await storage.kvGet<Brand[]>(BRANDS_KEY)) ?? [];
    const next = { ...brand, updatedAt: Date.now() };
    const idx = brands.findIndex(b => b.id === brand.id);
    if (idx >= 0) brands[idx] = next; else brands.push(next);
    await storage.kvSet(BRANDS_KEY, brands);
}

export async function createBrand(
    name: string,
    description: string,
    productEssence: string,
    contextModes: ContextMode[] = []
): Promise<Brand> {
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || crypto.randomUUID().slice(0, 8);
    const brand: Brand = {
        id, name, description, productEssence, contextModes,
        createdAt: Date.now(), updatedAt: Date.now(),
    };
    await saveBrand(brand);
    return brand;
}

/** Brand-scoped kv key helper — per-brand soul, attributions, etc. */
export const brandKey = (key: string, brandId = getCurrentBrandId()): string =>
    `b:${brandId}:${key}`;
