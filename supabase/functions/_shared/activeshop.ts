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
function env(k: string): string {
  // Deno (Supabase Edge) o Node
  const v = (globalThis as any).Deno?.env?.get?.(k) ?? (globalThis as any).process?.env?.[k];
  if (!v) throw new Error(`Variabile d'ambiente mancante: ${k}`);
  return v;
}
