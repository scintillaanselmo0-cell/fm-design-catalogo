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
import Stripe from "https://esm.sh/stripe@17.5.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10?target=deno";
import { CORS, json, env, loadCatalog, makeExternalNumber } from "../_shared/util.ts";

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
