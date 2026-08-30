-- Adds drill tracking to orders. Run this in the Supabase SQL editor before
-- opening the Drilling page.
--
-- Drilling is its own step, not a rename of an existing flag: a ball can be
-- drilled and still sitting on the shelf waiting for the customer, so this
-- cannot reuse out_the_door.

alter table public.orders
    add column if not exists drilled     boolean not null default false,
    add column if not exists drilled_at  timestamptz;

-- The drilling queue is "customer orders that are not finished yet", so the
-- index matches that shape.
create index if not exists orders_drill_queue_idx
    on public.orders (drilled, out_the_door, shop_order_date)
    where is_stock = false;

-- Anything already out the door was necessarily drilled first -- backfill so
-- the page does not open with a hundred rows of finished work.
update public.orders
   set drilled = true,
       drilled_at = coalesce(drilled_at, updated_at)
 where out_the_door = true
   and is_stock = false
   and drilled = false;

-- Check:
--   select count(*) from orders where drilled;             -- backfilled
--   select count(*) from orders
--    where is_stock = false and not drilled and not out_the_door
--      and (shop_order_date is null or quarter = '2026 Q3');
