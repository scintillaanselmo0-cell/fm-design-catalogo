# FM Design Shop — Backend (Supabase + Stripe)

Backend e-commerce dello shop. Il frontend statico (`/shop/`) chiama la Edge Function
`create-checkout`, che ricalcola i prezzi **lato server** dal catalogo pubblico
(`shop-data/index.json`), crea l'ordine `pending_payment` e apre **Stripe Checkout**.
Al pagamento, `stripe-webhook` segna l'ordine `paid`, genera l'XML **EasyFatt** e invia
l'email di notifica. L'inoltro ad **ActiveShop** resta **SPENTO** finché `SUBMIT_AUTO="true"`.

Stato: **test mode**. Niente chiavi live, niente ordini reali al fornitore.

## Componenti
- `functions/create-checkout` — crea sessione Stripe + ordine pending (prezzi server-side, check stock).
- `functions/stripe-webhook` — `checkout.session.completed` → ordine `paid`, XML EasyFatt in `orders.notes`, email Resend, (opzionale) invio ActiveShop.
- `functions/_shared/` — `util.ts` (catalogo/CORS), `easyfatt.ts` (XML Danea), `activeshop.ts` (Checkout API B2B).
- `schema.sql` — tabelle `orders`, `order_items`, `webhook_events` (+ RLS).

## Deploy (una tantum)

Prerequisiti: Node + [Supabase CLI](https://supabase.com/docs/guides/cli), account Stripe in **Test mode**.

```bash
# 1. Login e link al progetto
supabase login
supabase link --project-ref ooitmnhacdotfhoaxuni

# 2. Applica lo schema DB (sul progetto remoto)
#    (oppure incolla schema.sql nella SQL Editor del dashboard Supabase)
supabase db push            # se usi le migration
# in alternativa: Dashboard → SQL Editor → incolla supabase/schema.sql → Run

# 3. Imposta i SECRET (mai nel codice!) — valori TEST
supabase secrets set \
  STRIPE_SECRET_KEY=sk_test_xxx \
  STRIPE_WEBHOOK_SECRET=whsec_xxx \
  SHOP_URL=https://scintillaanselmo0-cell.github.io/fm-design-catalogo/shop \
  SHIPPING_FLAT_EUR=0 \
  ADMIN_EMAIL=tua@email.it \
  RESEND_API_KEY=re_xxx            # opzionale (email). Senza, l'ordine si registra lo stesso.
# ActiveShop: NON impostare SUBMIT_AUTO (resta spento). Le creds servono solo quando andremo live:
#   ACTIVESHOP_USER / ACTIVESHOP_PASS  → lasciare NON impostate per ora.

# 4. Deploy funzioni
supabase functions deploy create-checkout
supabase functions deploy stripe-webhook
```

`STRIPE_WEBHOOK_SECRET` si ottiene creando l'endpoint webhook su Stripe:
Dashboard Stripe (Test) → Developers → Webhooks → *Add endpoint*
- URL: `https://ooitmnhacdotfhoaxuni.supabase.co/functions/v1/stripe-webhook`
- Evento: `checkout.session.completed`
- Copia il *Signing secret* (`whsec_...`) e mettilo nei secret (passo 3), poi ri-deploya il webhook.

## Test end-to-end (carta di prova)
1. Apri lo shop, aggiungi un prodotto, vai al checkout, compila e "Vai al pagamento".
2. Su Stripe usa la carta test `4242 4242 4242 4242`, data futura, CVC qualsiasi.
3. Dopo il pagamento: ordine `paid` in tabella `orders`, email all'ADMIN_EMAIL, XML EasyFatt in `orders.notes`.
4. ActiveShop: **nessun** ordine inviato (corretto, è spento).

## Andare live (solo con OK esplicito)
- Stripe: chiavi `sk_live_...` + nuovo webhook live.
- `ACTIVESHOP_USER`/`ACTIVESHOP_PASS` + `SUBMIT_AUTO=true` per l'inoltro automatico al fornitore.
- Verifica fiscale (IVA, fattura elettronica / corrispettivi via EasyFatt) prima dell'apertura.
