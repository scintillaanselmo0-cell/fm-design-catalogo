// Utility condivise per le Edge Functions FM Design Shop

export const CATALOG_URL =
  "https://scintillaanselmo0-cell.github.io/fm-design-catalogo/shop/shop-data/index.json";

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

export function env(k: string): string {
  const v = Deno.env.get(k);
  if (!v) throw new Error(`Secret mancante: ${k}`);
  return v;
}

// Catalogo autoritativo: SKU -> { nome, prezzo (IVA incl.), stock, ... }
// Carica l'index pubblico del sito (fonte unica dei prezzi; MAI fidarsi del client).
export interface CatalogItem { k: string; n: string; p: number; s: number; i: string; b: string; }
let _cache: { at: number; map: Map<string, CatalogItem> } | null = null;

export async function loadCatalog(): Promise<Map<string, CatalogItem>> {
  if (_cache && Date.now() - _cache.at < 5 * 60_000) return _cache.map;
  const res = await fetch(CATALOG_URL, { headers: { "cache-control": "no-cache" } });
  if (!res.ok) throw new Error(`Catalogo non raggiungibile: ${res.status}`);
  const arr = await res.json() as CatalogItem[];
  const map = new Map(arr.map((x) => [String(x.k), x]));
  _cache = { at: Date.now(), map };
  return map;
}

// Numero ordine leggibile: FMD-AAAA-<timestamp base36>
export function makeExternalNumber(): string {
  const y = new Date().getFullYear();
  const t = Date.now().toString(36).toUpperCase().slice(-6);
  return `FMD-${y}-${t}`;
}
