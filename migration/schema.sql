-- Perfexxxxion Pro Shop -- Supabase schema
-- Run this in the Supabase SQL editor before importing the migration CSVs.

-- ---------------------------------------------------------------------------
-- orders
-- ---------------------------------------------------------------------------
create table if not exists public.orders (
    id                uuid primary key default gen_random_uuid(),
    legacy_id         text,                       -- e.g. 20251210-YP4, from the workbook
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now(),

    submitted_at      timestamptz,                -- when the customer ordered
    source            text not null default 'in_shop'
                      check (source in ('google_form','website','in_shop','import')),

    customer_name     text not null,
    is_stock          boolean not null default false,   -- shop stock, not a customer
    phone             text,
    email             text,

    item              text not null,
    quantity          integer not null default 1 check (quantity > 0),
    fitting           text,                       -- "Specs on file" / "Need appointment"
    notes             text,                       -- customer-visible notes

    order_location    text check (order_location in ('Valley','South Side','Both')),
    pickup_location   text check (pickup_location in ('Valley','South Side','Both')),

    -- NULL here is the whole point: it means the shop has not placed this
    -- order with a distributor yet. That is what pins a row to the top of
    -- the orders page.
    shop_order_date   date,

    supplier          text,
    supplier_order_no text,
    invoice_no        text,
    price             numeric(10,2),

    paid              boolean not null default false,
    out_the_door      boolean not null default false,
    has_been_called   boolean not null default false,
    time_called       timestamptz,

    staff_member      text,
    internal_notes    text,                       -- was "Amy's Notes"

    -- Soft delete. The database is reachable by anyone with the URL, so
    -- nothing is ever hard-deleted through the app -- rows are hidden and
    -- stay recoverable. Drop this if you later add a login.
    deleted_at        timestamptz,

    -- Populated by the migration; safe to drop once the flagged rows are
    -- cleaned up. See migration/output/review_needed.csv.
    migration_flag    text,
    source_sheet      text,
    source_row        integer,

    -- Derived so the quarter filter is indexable rather than computed in JS.
    quarter           text generated always as (
                          case when shop_order_date is null then null
                               else extract(year    from shop_order_date)::text
                                    || ' Q'
                                    || extract(quarter from shop_order_date)::text
                          end
                      ) stored
);

create index if not exists orders_shop_order_date_idx on public.orders (shop_order_date);
create index if not exists orders_quarter_idx         on public.orders (quarter);
create index if not exists orders_customer_idx        on public.orders (lower(customer_name));
create index if not exists orders_item_idx            on public.orders (lower(item));
create index if not exists orders_deleted_idx         on public.orders (deleted_at);

-- The default view of the orders page: unordered first (oldest wait first),
-- then everything else newest first.
create index if not exists orders_queue_idx
    on public.orders ((shop_order_date is null) desc, submitted_at asc);


-- ---------------------------------------------------------------------------
-- appointments
-- ---------------------------------------------------------------------------
create table if not exists public.appointments (
    id             uuid primary key default gen_random_uuid(),
    legacy_id      text,
    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now(),

    customer_name  text not null,
    phone          text,
    service        text not null,               -- "what we are doing"
    location       text check (location in ('Valley','South Side')),
    appt_date      date not null,
    appt_time      time,
    completed      boolean not null default false,
    notes          text,

    deleted_at     timestamptz,
    migration_flag text,
    source_sheet   text,
    source_row     integer
);

create index if not exists appointments_date_idx    on public.appointments (appt_date);
create index if not exists appointments_deleted_idx on public.appointments (deleted_at);


-- ---------------------------------------------------------------------------
-- items -- autocomplete source, seeded from 10 years of order history
-- ---------------------------------------------------------------------------
create table if not exists public.items (
    item          text primary key,
    times_ordered integer not null default 0,
    last_ordered  date
);

create index if not exists items_name_idx on public.items (lower(item));


-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists orders_touch on public.orders;
create trigger orders_touch before update on public.orders
    for each row execute function public.touch_updated_at();

drop trigger if exists appointments_touch on public.appointments;
create trigger appointments_touch before update on public.appointments
    for each row execute function public.touch_updated_at();


-- ---------------------------------------------------------------------------
-- Row Level Security
--
-- Per the current decision the app is open to the public internet with no
-- login, so the anon role gets read/insert/update. It deliberately does NOT
-- get delete -- the app soft-deletes by setting deleted_at, which keeps a
-- publicly reachable endpoint from being able to wipe order history.
--
-- To lock this down later: add Supabase Auth, then change `to anon` to
-- `to authenticated` on each policy below. No table changes needed.
-- ---------------------------------------------------------------------------
alter table public.orders       enable row level security;
alter table public.appointments enable row level security;
alter table public.items        enable row level security;

drop policy if exists orders_read   on public.orders;
drop policy if exists orders_insert on public.orders;
drop policy if exists orders_update on public.orders;

create policy orders_read   on public.orders for select to anon using (true);
create policy orders_insert on public.orders for insert to anon with check (true);
create policy orders_update on public.orders for update to anon using (true) with check (true);

drop policy if exists appointments_read   on public.appointments;
drop policy if exists appointments_insert on public.appointments;
drop policy if exists appointments_update on public.appointments;

create policy appointments_read   on public.appointments for select to anon using (true);
create policy appointments_insert on public.appointments for insert to anon with check (true);
create policy appointments_update on public.appointments for update to anon using (true) with check (true);

drop policy if exists items_read   on public.items;
drop policy if exists items_insert on public.items;
drop policy if exists items_update on public.items;

create policy items_read   on public.items for select to anon using (true);
create policy items_insert on public.items for insert to anon with check (true);
create policy items_update on public.items for update to anon using (true) with check (true);


-- ---------------------------------------------------------------------------
-- Importing the CSVs
--
-- Option A -- Supabase dashboard: Table Editor -> orders -> Insert -> Import
-- data from CSV. Repeat for appointments and items. Blank cells become NULL.
--
-- Option B -- psql, which is faster and reports errors precisely:
--
--   \copy public.orders (legacy_id, submitted_at, source, customer_name,
--     is_stock, phone, email, item, quantity, fitting, notes, order_location,
--     pickup_location, shop_order_date, supplier, supplier_order_no,
--     invoice_no, price, paid, out_the_door, has_been_called, time_called,
--     staff_member, internal_notes, migration_flag, source_sheet, source_row)
--     from 'output/orders.csv' with (format csv, header true, null '');
--
--   \copy public.appointments (legacy_id, customer_name, phone, service,
--     location, appt_date, appt_time, completed, notes, migration_flag,
--     source_sheet, source_row)
--     from 'output/appointments.csv' with (format csv, header true, null '');
--
--   \copy public.items (item, times_ordered, last_ordered)
--     from 'output/items.csv' with (format csv, header true, null '');
--
-- Sanity checks after import:
--
--   select count(*) from orders;                        -- expect 2176
--   select count(*) from orders where shop_order_date is null;   -- expect 15
--   select count(*) from appointments;                  -- expect 179
--   select quarter, count(*) from orders group by 1 order by 1;
-- ---------------------------------------------------------------------------
