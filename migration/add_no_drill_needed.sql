-- Lets a customer order leave the drilling queue without claiming it was
-- drilled. Bags, shoes, totes and tape all arrive for a named customer and so
-- land on the drilling page, but nothing gets drilled -- marking them
-- "drilled" would put a false record on the order.
--
-- Run this in the Supabase SQL editor.

alter table public.orders
    add column if not exists no_drill_needed boolean not null default false;

-- Check:
--   select count(*) from orders where no_drill_needed;
