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


/* ===== easyfatt.ts ===== */
/**
 * Generatore XML in formato Danea EasyFatt (tracciato "EasyfattDocuments").
 * Produce il documento di un ordine da importare in EasyFatt.
 *
 * NOTA: il tracciato EasyFatt ha molti campi opzionali; questo copre i
 * principali per corrispettivo/fattura di vendita online. Da validare con
 * UN import di prova nella tua versione di EasyFatt e rifinire se serve.
 */

export interface EasyfattRow {
  code?: string;      // SKU
  description: string;
  qty: number;
  price: number;      // prezzo unitario IVA INCLUSA (lordo)
  vatPercent: number; // es. 22
}

export interface EasyfattDoc {
  // "I" = Fattura, "C" = Corrispettivo (vendita senza fattura)
  documentType: "I" | "C";
  number?: string;        // lascia vuoto per numerazione automatica di EasyFatt
  date: string;           // YYYY-MM-DD
  customerName: string;
  customerAddress?: string;
  customerPostcode?: string;
  customerCity?: string;
  customerProvince?: string;
  customerCountry?: string;  // "IT"
  customerVat?: string;      // P.IVA
  customerTaxCode?: string;  // Codice Fiscale
  customerEmail?: string;
  customerSdi?: string;      // Codice destinatario SdI
  customerPec?: string;
  rows: EasyfattRow[];
  shippingCost?: number;     // IVA inclusa
  shippingVatPercent?: number;
  paymentName?: string;      // es. "Stripe"
  externalNumber?: string;   // nostro riferimento ordine
}

const esc = (s: string | undefined) =>
  (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");

const num = (n: number) => n.toFixed(2);

// Prezzo netto (imponibile) da lordo IVA inclusa
const netOf = (gross: number, vat: number) => gross / (1 + vat / 100);

export function buildEasyfattXml(doc: EasyfattDoc): string {
  const rowsXml = doc.rows.map((r) => {
    const netUnit = netOf(r.price, r.vatPercent);
    return `   <Row>
    <Code>${esc(r.code)}</Code>
    <Description>${esc(r.description)}</Description>
    <Qty>${r.qty}</Qty>
    <Um>pz</Um>
    <Price>${num(netUnit)}</Price>
    <Discounts></Discounts>
    <VatCode Perc="${r.vatPercent}" Class="Imponibile">${r.vatPercent}</VatCode>
    <Total>${num(netUnit * r.qty)}</Total>
   </Row>`;
  }).join("\n");

  const shipXml = (doc.shippingCost && doc.shippingCost > 0)
    ? `   <Row>
    <Description>Spese di spedizione</Description>
    <Qty>1</Qty>
    <Price>${num(netOf(doc.shippingCost, doc.shippingVatPercent ?? 22))}</Price>
    <VatCode Perc="${doc.shippingVatPercent ?? 22}" Class="Imponibile">${doc.shippingVatPercent ?? 22}</VatCode>
   </Row>`
    : "";

  // Totale documento lordo
  const grossTotal = doc.rows.reduce((s, r) => s + r.price * r.qty, 0) + (doc.shippingCost ?? 0);

  return `<?xml version="1.0" encoding="UTF-8"?>
<EasyfattDocuments AppVersion="2" Creator="FM Design Shop">
 <Documents>
  <Document>
   <DocumentType>${doc.documentType}</DocumentType>
   ${doc.number ? `<Number>${esc(doc.number)}</Number>` : ""}
   <Date>${doc.date}</Date>
   <CustomerName>${esc(doc.customerName)}</CustomerName>
   <CustomerAddress>${esc(doc.customerAddress)}</CustomerAddress>
   <CustomerPostcode>${esc(doc.customerPostcode)}</CustomerPostcode>
   <CustomerCity>${esc(doc.customerCity)}</CustomerCity>
   <CustomerProvince>${esc(doc.customerProvince)}</CustomerProvince>
   <CustomerCountry>${esc(doc.customerCountry ?? "IT")}</CustomerCountry>
   <CustomerVatCode>${esc(doc.customerVat)}</CustomerVatCode>
   <CustomerTel></CustomerTel>
   <CustomerEmail>${esc(doc.customerEmail)}</CustomerEmail>
   <CustomerFiscalCode>${esc(doc.customerTaxCode)}</CustomerFiscalCode>
   <CustomerEInvoiceDestCode>${esc(doc.customerSdi)}</CustomerEInvoiceDestCode>
   <CustomerPecEmail>${esc(doc.customerPec)}</CustomerPecEmail>
   <PaymentName>${esc(doc.paymentName ?? "Stripe")}</PaymentName>
   <InternalComment>Ordine web ${esc(doc.externalNumber)}</InternalComment>
   <Total>${num(grossTotal)}</Total>
   <Rows>
${rowsXml}${shipXml ? "\n" + shipXml : ""}
   </Rows>
  </Document>
 </Documents>
</EasyfattDocuments>`;
}


/* ===== activeshop.ts ===== */
/**
 * ActiveShop B2B — Checkout API client (dropshipping)
 * Magento 2 REST + estensioni "activ-checkout".
 *
 * Runtime-agnostico: usa fetch globale (Supabase Edge/Deno, Node 18+, Cloudflare).
 * Credenziali SOLO da variabili d'ambiente — mai hardcoded.
 *
 *   ACTIVESHOP_USER      = username account B2B FM Design
 *   ACTIVESHOP_PASS      = password account B2B FM Design
 *
 * Flusso (doc ufficiale, step 1→12):
 *   token → crea carrello → add item → set-currency EUR → stima spedizione
 *   → set spedizione → synchronizeQuoteParams(order_type:"dropshipping")
 *   → set-payment → place order (external_number + notification_email)
 * Post-ordine: orderTracking, orderDocuments.
 */

const HOST = "https://b2b.activeshop.com.pl";
const STORE = "B2B_PL_pl";
const BASE = `${HOST}/rest/${STORE}/V1`;

export interface Address {
  firstname: string;
  lastname: string;
  company?: string;
  street: string[];       // es. ["Via Roma", "12"]
  city: string;
  postcode: string;
  country_id: string;     // es. "IT"
  region_id?: number;     // opzionale (per IT spesso non serve)
  region?: string;        // provincia, se region_id assente
  telephone: string;
  email?: string;
}

export interface OrderLine { sku: string; qty: number; }

export interface PlaceOrderInput {
  lines: OrderLine[];
  shipping: Address;
  externalNumber: string;        // il NOSTRO numero d'ordine (es. "FMD-1042")
  notificationEmail: string;     // dove ActiveShop manda gli aggiornamenti
  comment?: string;
  currency?: "EUR" | "PLN";      // default EUR
  // Metodo con cui PAGHI ActiveShop. Da confermare con loro quale usare.
  supplierPaymentMethod?: string; // es. "banktransfer" | "payu_gateway" ...
}

// ─────────────────────────────────────────────────────────────
// Core HTTP
// ─────────────────────────────────────────────────────────────
let tokenCache: { token: string; exp: number } | null = null;

async function req<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init.headers as Record<string, string> || {}),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  const text = await res.text();
  if (!res.ok) {
    throw new ActiveShopError(res.status, path, text);
  }
  return (text ? JSON.parse(text) : null) as T;
}

export class ActiveShopError extends Error {
  constructor(public status: number, public path: string, public body: string) {
    super(`ActiveShop ${status} @ ${path}: ${body.slice(0, 300)}`);
    this.name = "ActiveShopError";
  }
}

// ─────────────────────────────────────────────────────────────
// 1. Token (login customer → bearer). Cache ~50 min.
// ─────────────────────────────────────────────────────────────
export async function getToken(force = false): Promise<string> {
  const now = Date.now();
  if (!force && tokenCache && tokenCache.exp > now + 60_000) return tokenCache.token;

  const username = env("ACTIVESHOP_USER");
  const password = env("ACTIVESHOP_PASS");
  const token = await req<string>("/integration/customer/token", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
  tokenCache = { token, exp: now + 50 * 60_000 }; // conservativo; i token Magento durano ~1-4h
  return token;
}

// ─────────────────────────────────────────────────────────────
// Passi del checkout
// ─────────────────────────────────────────────────────────────
// 2. Crea carrello → quoteId
export const createCart = (t: string) =>
  req<number>("/carts/mine", { method: "POST" }, t);

// 3. Aggiungi articolo
export const addItem = (t: string, quoteId: number, sku: string, qty: number) =>
  req("/carts/mine/items", {
    method: "POST",
    body: JSON.stringify({ cartItem: { sku, qty, quote_id: quoteId } }),
  }, t);

// 4. Valuta
export const availableCurrencies = (t: string, quoteId: number) =>
  req<string[]>("/activ-checkout/available-currencies", {
    method: "POST",
    body: JSON.stringify({ quoteId, addressInformation: {} }),
  }, t);

export const setCurrency = (t: string, currencyCode: string) =>
  req("/activ-checkout/set-currency", {
    method: "POST", body: JSON.stringify({ currencyCode }),
  }, t);

// 5. Stima metodi di spedizione per l'indirizzo cliente
export const estimateShipping = (t: string, address: Address) =>
  req<ShippingMethod[]>("/carts/mine/estimate-shipping-methods", {
    method: "POST", body: JSON.stringify({ address }),
  }, t);

export interface ShippingMethod {
  carrier_code: string; method_code: string;
  carrier_title: string; method_title: string;
  amount: number; price_incl_tax: number; available: boolean; error_message: string;
}

// 6. Imposta la spedizione → ritorna metodi di pagamento + totali
export const setShippingInformation = (
  t: string, address: Address, carrier: string, method: string,
) => req<ShippingInfoResult>("/carts/mine/shipping-information", {
  method: "POST",
  body: JSON.stringify({
    addressInformation: {
      shipping_address: address,
      shipping_carrier_code: carrier,
      shipping_method_code: method,
    },
  }),
}, t);

export interface ShippingInfoResult {
  payment_methods: { code: string; title: string }[];
  totals: Record<string, unknown>;
}

// 9. Parametri: order_type dropshipping + commento → ritorna gli accordi da accettare
export const syncParams = (t: string, comment: string, orderType: "own" | "dropshipping") =>
  req<Agreement[]>("/activ-checkout/synchronizeQuoteParams", {
    method: "POST", body: JSON.stringify({ params: { comment, order_type: orderType } }),
  }, t);

export interface Agreement { id: number; name: string; is_required: boolean; }

// 7. Imposta il metodo di pagamento (verso ActiveShop)
export const setPaymentInformation = (t: string, cartId: number, method: string) =>
  req("/carts/mine/set-payment-information", {
    method: "POST", body: JSON.stringify({ cartId, paymentMethod: { method } }),
  }, t);

// 12. Crea l'ordine → ritorna orderId
export const placeOrder = (
  t: string, method: string, agreementIds: number[], externalNumber: string, notificationEmail: string,
) => req<string>("/carts/mine/payment-information", {
  method: "POST",
  body: JSON.stringify({
    paymentMethod: {
      method,
      extension_attributes: {
        agreement_ids: agreementIds,
        external_number: externalNumber,
        notification_email: notificationEmail,
      },
    },
  }),
}, t);

// 13-14. Tracking e documenti (fatture)
export const orderTracking = (t: string, orderIds: string[]) =>
  req<TrackingInfo[]>("/orderTracking", { method: "POST", body: JSON.stringify({ orderIds }) }, t);

export const orderDocuments = (t: string, orderIds: string[]) =>
  req<DocumentInfo[]>("/orderDocuments", { method: "POST", body: JSON.stringify({ orderIds }) }, t);

export interface TrackingInfo {
  order_id: string; order_status: string; carrier: string | null;
  tracking_number: string | null; delivered_at: string | null; tracking_url: string | null;
}
export interface DocumentInfo {
  order_increment_id: string; document_number: string; document_type: string;
  issue_date: string; net_value: number; gross_value: number; currency: string;
}

// ─────────────────────────────────────────────────────────────
// Orchestratore: piazza un ordine dropshipping completo
// ─────────────────────────────────────────────────────────────
export async function placeDropshipOrder(input: PlaceOrderInput): Promise<{ orderId: string; totals: unknown }> {
  const currency = input.currency ?? "EUR";
  const t = await getToken();

  const quoteId = await createCart(t);
  for (const l of input.lines) await addItem(t, quoteId, l.sku, l.qty);

  await setCurrency(t, currency);

  // Scegli il metodo di spedizione: preferiamo il più economico disponibile all'indirizzo IT.
  const methods = (await estimateShipping(t, input.shipping)).filter(m => m.available);
  if (!methods.length) throw new Error("Nessun metodo di spedizione disponibile per l'indirizzo cliente.");
  const ship = methods.sort((a, b) => a.price_incl_tax - b.price_incl_tax)[0];

  const shipInfo = await setShippingInformation(t, input.shipping, ship.carrier_code, ship.method_code);

  // order_type dropshipping + accordi obbligatori
  const agreements = await syncParams(t, input.comment ?? "", "dropshipping");
  const agreementIds = agreements.filter(a => a.is_required).map(a => a.id);

  // Metodo con cui PAGHIAMO ActiveShop (da confermare col fornitore).
  const payMethod = input.supplierPaymentMethod
    ?? shipInfo.payment_methods[0]?.code
    ?? "banktransfer";

  await setPaymentInformation(t, quoteId, payMethod);
  const orderId = await placeOrder(t, payMethod, agreementIds, input.externalNumber, input.notificationEmail);

  return { orderId, totals: shipInfo.totals };
}

// ─────────────────────────────────────────────────────────────


/* ===== stripe-webhook ===== */
/**
 * stripe-webhook — riceve gli eventi Stripe.
 * Su 'checkout.session.completed': segna l'ordine PAGATO, genera l'XML EasyFatt,
 * invia l'email di conferma. L'invio ad ActiveShop resta MANUALE (vedi submit-to-supplier)
 * finché SUBMIT_AUTO non è "true" (default: spento, per sicurezza — niente ordini reali nei test).
 *
 * Secret:
 *   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (automatici)
 *   RESEND_API_KEY        (per email; opzionale)
 *   ADMIN_EMAIL           (dove ricevi la notifica ordine)
 *   SUBMIT_AUTO           ("true" per inviare automaticamente ad ActiveShop; default spento)
 */

Deno.serve(async (req) => {
  const sig = req.headers.get("stripe-signature");
  if (!sig) return new Response("no signature", { status: 400 });

  const stripe = new Stripe(env("STRIPE_SECRET_KEY"), { apiVersion: "2024-12-18.acacia" });
  const supa = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));

  let event: Stripe.Event;
  const raw = await req.text();
  try {
    event = await stripe.webhooks.constructEventAsync(raw, sig, env("STRIPE_WEBHOOK_SECRET"));
  } catch (e) {
    console.error("Firma webhook non valida:", e);
    return new Response("bad signature", { status: 400 });
  }

  // Idempotenza: se già visto, esci
  const { error: dupErr } = await supa.from("webhook_events")
    .insert({ id: event.id, type: event.type });
  if (dupErr) return new Response("ok (duplicato)", { status: 200 });

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const orderId = session.metadata?.order_id;
    if (orderId) {
      await supa.from("orders").update({
        status: "paid",
        paid_at: new Date().toISOString(),
        stripe_payment_intent: String(session.payment_intent ?? ""),
      }).eq("id", orderId);

      // Carica ordine + righe per EasyFatt / email
      const { data: order } = await supa.from("orders").select("*").eq("id", orderId).single();
      const { data: items } = await supa.from("order_items").select("*").eq("order_id", orderId);

      if (order && items) {
        // XML EasyFatt (I = fattura se richiesta, C = corrispettivo)
        const rows: EasyfattRow[] = items.map((it) => ({
          code: it.sku, description: it.name, qty: it.qty,
          price: Number(it.unit_price_eur), vatPercent: 22,
        }));
        const xml = buildEasyfattXml({
          documentType: order.wants_invoice ? "I" : "C",
          date: new Date().toISOString().slice(0, 10),
          customerName: order.company_name ||
            [order.customer_first, order.customer_last].filter(Boolean).join(" ") || order.customer_email,
          customerAddress: order.ship_street, customerPostcode: order.ship_postcode,
          customerCity: order.ship_city, customerProvince: order.ship_province,
          customerCountry: order.ship_country, customerVat: order.vat_number,
          customerTaxCode: order.tax_code, customerEmail: order.customer_email,
          customerSdi: order.sdi_code, customerPec: order.pec,
          rows, shippingCost: Number(order.shipping_eur), shippingVatPercent: 22,
          externalNumber: order.external_number,
        });
        // Salva l'XML come nota (recupero manuale) — in futuro: upload su Storage / invio a EasyFatt
        await supa.from("orders").update({ notes: xml }).eq("id", orderId);

        // Email di notifica (Resend, se configurato) — con XML EasyFatt in allegato
        const resendKey = Deno.env.get("RESEND_API_KEY");
        const adminEmail = Deno.env.get("ADMIN_EMAIL");
        if (resendKey && adminEmail) {
          const lines = items.map((i) => `${i.qty}x ${i.name} (${i.sku})`).join("\n");
          // base64 UTF-8 sicuro dell'XML da allegare
          const bytes = new TextEncoder().encode(xml);
          let bin = "";
          for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
          const xmlB64 = btoa(bin);
          const docLabel = order.wants_invoice ? "fattura" : "corrispettivo";
          await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { "Authorization": `Bearer ${resendKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              from: "FM Design Shop <onboarding@resend.dev>",
              to: [adminEmail],
              subject: `Nuovo ordine ${order.external_number} — ${order.total_eur} EUR`,
              text: `Ordine PAGATO ${order.external_number}\nCliente: ${order.customer_email}\nTotale: ${order.total_eur} EUR\nDocumento: ${docLabel}\n\n${lines}\n\nSpedizione:\n${order.ship_street ?? ""} ${order.ship_postcode ?? ""} ${order.ship_city ?? ""} ${order.ship_province ?? ""}\n\nIn allegato l'XML da importare in Danea EasyFatt (Strumenti > Importa > Documenti, tracciato "EasyfattDocuments").`,
              attachments: [{ filename: `${order.external_number}.xml`, content: xmlB64 }],
            }),
          }).catch((e) => console.error("Email fallita:", e));
        }

        // Invio automatico ad ActiveShop SOLO se esplicitamente attivato
        if (Deno.env.get("SUBMIT_AUTO") === "true") {
          try {
            const res = await placeDropshipOrder({
              lines: items.map((i) => ({ sku: i.sku, qty: i.qty })),
              shipping: {
                firstname: order.customer_first ?? "Cliente",
                lastname: order.customer_last ?? order.external_number,
                street: [order.ship_street ?? ""], city: order.ship_city ?? "",
                postcode: order.ship_postcode ?? "", country_id: order.ship_country ?? "IT",
                telephone: order.customer_phone ?? "0000000000", email: order.customer_email,
              },
              externalNumber: order.external_number,
              notificationEmail: order.customer_email,
              currency: "EUR",
            });
            await supa.from("orders").update({
              status: "submitted_to_supplier",
              activeshop_order_id: res.orderId,
              submitted_at: new Date().toISOString(),
            }).eq("id", orderId);
          } catch (e) {
            console.error("Invio ActiveShop fallito (ordine resta 'paid'):", e);
          }
        }
      }
    }
  }

  return new Response("ok", { status: 200 });
});