-- Stock from distributors (Ace Mitchell for now), filled by the
-- "Ace Mitchell stock" GitHub Action. Run once in Supabase -> SQL Editor.

create table if not exists public.vendor_stock (
  vendor            text        not null,
  item_code         text        not null,
  display_name      text,
  sales_description text,
  upc               text,
  category          text,          -- Shoes, Bags, Bowling Balls, ...
  net_price         numeric(10,2), -- our dealer cost: never shown on the website
  qty_oh            integer not null default 0,
  qty_ny            integer not null default 0,
  qty_tn            integer not null default 0,
  qty_total         integer not null default 0,
  checked_at        timestamptz not null default now(),
  primary key (vendor, item_code)
);

-- Locked down: only the service-role key (the Action) can read or write the
-- table, so dealer cost is not readable with the public key.
alter table public.vendor_stock enable row level security;

-- What the website may read: in-stock items, no cost.
create or replace view public.vendor_stock_public as
  select vendor, item_code, display_name, upc, category, qty_total, checked_at
  from public.vendor_stock
  where qty_total > 0;

grant select on public.vendor_stock_public to anon, authenticated;
