// FILE AUTOGENERATO self-contained per il deploy da Dashboard Supabase.
// Sorgente reale: supabase/functions/* — modifica li e rigenera, non qui.

import Stripe from "https://esm.sh/stripe@17.5.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10?target=deno";

/* ===== util.ts ===== */
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


/* ===== create-checkout ===== */
/**
 * create-checkout — crea la sessione di pagamento Stripe e l'ordine (pending).
 *
 * Il prezzo NON si fida mai del client: viene ricalcolato dal catalogo
 * pubblico del sito (fonte unica). Verifica anche la disponibilità.
 *
 * Secret necessari (impostati in Supabase, mai nel codice):
 *   STRIPE_SECRET_KEY         (chiave test: sk_test_...)
 *   SUPABASE_URL              (automatico in Edge)
 *   SUPABASE_SERVICE_ROLE_KEY (automatico in Edge)
 *   SHOP_URL                  (es. https://scintillaanselmo0-cell.github.io/fm-design-catalogo/shop)
 *   SHIPPING_FLAT_EUR         (opzionale, default 0 — spedizione forfettaria finché non colleghiamo ActiveShop)
 */

interface CartLine { sku: string; qty: number; }
interface Body {
  items: CartLine[];
  customer: { email: string; first?: string; last?: string; phone?: string };
  shipping?: { street?: string; city?: string; postcode?: string; province?: string; country?: string };
  wants_invoice?: boolean;
  fiscal?: { company?: string; vat?: string; tax_code?: string; sdi?: string; pec?: string };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Metodo non consentito" }, 405);

  try {
    const body = await req.json() as Body;
    if (!body.items?.length) return json({ error: "Carrello vuoto" }, 400);
    if (!body.customer?.email) return json({ error: "Email mancante" }, 400);

    const catalog = await loadCatalog();
    const stripe = new Stripe(env("STRIPE_SECRET_KEY"), { apiVersion: "2024-12-18.acacia" });
    const supa = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));
    const shopUrl = env("SHOP_URL");
    const shippingFlat = Number(Deno.env.get("SHIPPING_FLAT_EUR") ?? "0");

    // Ricalcolo prezzi lato server + verifica stock
    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [];
    const orderItems: Record<string, unknown>[] = [];
    let subtotal = 0;
    for (const l of body.items) {
      const p = catalog.get(String(l.sku));
      if (!p) return json({ error: `Prodotto non trovato: ${l.sku}` }, 400);
      if (!(l.qty > 0)) return json({ error: `Quantità non valida: ${l.sku}` }, 400);
      if (p.s <= 0) return json({ error: `Esaurito: ${p.n}` }, 409);
      const qty = Math.min(l.qty, p.s);
      const lineTotal = +(p.p * qty).toFixed(2);
      subtotal += lineTotal;
      lineItems.push({
        quantity: qty,
        price_data: {
          currency: "eur",
          unit_amount: Math.round(p.p * 100), // IVA inclusa
          product_data: { name: p.n, metadata: { sku: p.k } },
        },
      });
      orderItems.push({
        sku: p.k, name: p.n, qty, unit_price_eur: p.p, line_total_eur: lineTotal, image: p.i,
      });
    }

    if (shippingFlat > 0) {
      lineItems.push({
        quantity: 1,
        price_data: { currency: "eur", unit_amount: Math.round(shippingFlat * 100),
          product_data: { name: "Spedizione" } },
      });
    }

    const total = +(subtotal + shippingFlat).toFixed(2);
    const taxEur = +(total - total / 1.22).toFixed(2); // quota IVA 22% evidenziata
    const externalNumber = makeExternalNumber();

    // Crea ordine pending
    const { data: order, error: oerr } = await supa.from("orders").insert({
      external_number: externalNumber,
      status: "pending_payment",
      customer_email: body.customer.email,
      customer_first: body.customer.first ?? null,
      customer_last: body.customer.last ?? null,
      customer_phone: body.customer.phone ?? null,
      wants_invoice: !!body.wants_invoice,
      company_name: body.fiscal?.company ?? null,
      vat_number: body.fiscal?.vat ?? null,
      tax_code: body.fiscal?.tax_code ?? null,
      sdi_code: body.fiscal?.sdi ?? null,
      pec: body.fiscal?.pec ?? null,
      ship_street: body.shipping?.street ?? null,
      ship_city: body.shipping?.city ?? null,
      ship_postcode: body.shipping?.postcode ?? null,
      ship_province: body.shipping?.province ?? null,
      ship_country: body.shipping?.country ?? "IT",
      subtotal_eur: subtotal, shipping_eur: shippingFlat, tax_eur: taxEur, total_eur: total,
    }).select("id").single();
    if (oerr) throw oerr;

    const rows = orderItems.map((r) => ({ ...r, order_id: order.id }));
    const { error: ierr } = await supa.from("order_items").insert(rows);
    if (ierr) throw ierr;

    // Sessione Stripe Checkout
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: lineItems,
      customer_email: body.customer.email,
      success_url: `${shopUrl}/?order=success&ref=${externalNumber}`,
      cancel_url: `${shopUrl}/?order=cancelled`,
      metadata: { order_id: order.id, external_number: externalNumber },
      locale: "it",
    });

    await supa.from("orders").update({ stripe_session_id: session.id }).eq("id", order.id);

    return json({ url: session.url, order: externalNumber });
  } catch (e) {
    console.error("create-checkout error:", e);
    return json({ error: "Errore nella creazione del pagamento" }, 500);
  }
});