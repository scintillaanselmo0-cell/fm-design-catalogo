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
import Stripe from "https://esm.sh/stripe@17.5.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10?target=deno";
import { env } from "../_shared/util.ts";
import { buildEasyfattXml, EasyfattRow } from "../_shared/easyfatt.ts";

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

        // Email di notifica (Resend, se configurato)
        const resendKey = Deno.env.get("RESEND_API_KEY");
        const adminEmail = Deno.env.get("ADMIN_EMAIL");
        if (resendKey && adminEmail) {
          const lines = items.map((i) => `${i.qty}x ${i.name} (${i.sku})`).join("\n");
          await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { "Authorization": `Bearer ${resendKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              from: "FM Design Shop <onboarding@resend.dev>",
              to: [adminEmail],
              subject: `Nuovo ordine ${order.external_number} — ${order.total_eur} EUR`,
              text: `Ordine PAGATO ${order.external_number}\nCliente: ${order.customer_email}\nTotale: ${order.total_eur} EUR\n\n${lines}\n\nSpedizione:\n${order.ship_street ?? ""} ${order.ship_postcode ?? ""} ${order.ship_city ?? ""} ${order.ship_province ?? ""}`,
            }),
          }).catch((e) => console.error("Email fallita:", e));
        }

        // Invio automatico ad ActiveShop SOLO se esplicitamente attivato
        if (Deno.env.get("SUBMIT_AUTO") === "true") {
          try {
            const { placeDropshipOrder } = await import("../_shared/activeshop.ts");
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
