-- ============================================================
-- FM Design Shop — Schema database ordini (Supabase / PostgreSQL)
-- Da incollare in: Supabase → SQL Editor → New query → Run
-- Sicuro da rieseguire (usa IF NOT EXISTS / create or replace).
-- ============================================================

-- Stato dell'ordine (ciclo di vita)
do $$ begin
  create type order_status as enum (
    'pending_payment',       -- creato, in attesa di pagamento Stripe
    'paid',                  -- pagato dal cliente
    'submitted_to_supplier', -- inviato ad ActiveShop
    'shipped',               -- spedito (con tracking)
    'delivered',             -- consegnato
    'cancelled',             -- annullato
    'refunded'               -- rimborsato
  );
exception when duplicate_object then null; end $$;

-- ------------------------------------------------------------
-- ORDERS — un record per ordine
-- ------------------------------------------------------------
create table if not exists public.orders (
  id                 uuid primary key default gen_random_uuid(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  external_number    text unique,            -- nostro numero (es. FMD-2026-0001)
  status             order_status not null default 'pending_payment',

  -- Cliente
  customer_email     text not null,
  customer_first     text,
  customer_last      text,
  customer_phone     text,

  -- Dati fatturazione (compilati se il cliente chiede fattura)
  wants_invoice      boolean not null default false,
  company_name       text,
  vat_number         text,                   -- P.IVA
  tax_code           text,                   -- Codice Fiscale
  sdi_code           text,                   -- Codice destinatario SdI
  pec                text,

  -- Indirizzo di spedizione
  ship_street        text,
  ship_city          text,
  ship_postcode      text,
  ship_province      text,
  ship_country       text not null default 'IT',

  -- Totali (in euro, IVA inclusa dove indicato)
  currency           text not null default 'EUR',
  subtotal_eur       numeric(10,2) not null default 0,  -- imponibile+IVA dei prodotti
  shipping_eur       numeric(10,2) not null default 0,
  tax_eur            numeric(10,2) not null default 0,   -- quota IVA (evidenziata in fattura)
  total_eur          numeric(10,2) not null default 0,

  -- Pagamento (Stripe)
  stripe_session_id        text,
  stripe_payment_intent    text,
  paid_at                  timestamptz,

  -- Fornitore (ActiveShop)
  activeshop_order_id      text,
  submitted_at             timestamptz,
  tracking_carrier         text,
  tracking_number          text,
  tracking_url             text,
  supplier_cost_eur        numeric(10,2),     -- quanto paghiamo ad ActiveShop (margine = total - questo - commissioni)

  -- Fatturazione (EasyFatt)
  easyfatt_exported        boolean not null default false,
  easyfatt_doc_number      text,

  notes                    text
);

-- ------------------------------------------------------------
-- ORDER_ITEMS — righe dell'ordine (snapshot al momento dell'acquisto)
-- ------------------------------------------------------------
create table if not exists public.order_items (
  id                 uuid primary key default gen_random_uuid(),
  order_id           uuid not null references public.orders(id) on delete cascade,
  sku                text not null,           -- codice ActiveShop (indeks)
  ean                text,
  name               text not null,           -- nome al momento dell'acquisto
  qty                integer not null check (qty > 0),
  unit_price_eur     numeric(10,2) not null,  -- prezzo di vendita unitario (IVA inclusa)
  line_total_eur     numeric(10,2) not null,
  supplier_net_pln   numeric(10,2),           -- costo netto fornitore (PLN) per riconciliazione
  image              text
);

create index if not exists order_items_order_id_idx on public.order_items(order_id);
create index if not exists orders_status_idx on public.orders(status);
create index if not exists orders_created_idx on public.orders(created_at desc);

-- ------------------------------------------------------------
-- WEBHOOK_EVENTS — idempotenza eventi Stripe (evita doppioni)
-- ------------------------------------------------------------
create table if not exists public.webhook_events (
  id           text primary key,             -- id evento Stripe
  received_at  timestamptz not null default now(),
  type         text
);

-- ------------------------------------------------------------
-- updated_at automatico su orders
-- ------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists orders_touch_updated_at on public.orders;
create trigger orders_touch_updated_at
  before update on public.orders
  for each row execute function public.touch_updated_at();

-- ------------------------------------------------------------
-- SICUREZZA (RLS): nessun accesso pubblico agli ordini.
-- Le Edge Functions useranno la service_role key, che bypassa RLS.
-- Così gli ordini NON sono leggibili dal browser dei clienti.
-- ------------------------------------------------------------
alter table public.orders        enable row level security;
alter table public.order_items   enable row level security;
alter table public.webhook_events enable row level security;
-- (nessuna policy = nessun accesso con anon key; solo service_role entra)

-- ============================================================
-- Fine schema. Prossimo passo: Edge Functions (Stripe + ActiveShop + EasyFatt).
-- ============================================================
