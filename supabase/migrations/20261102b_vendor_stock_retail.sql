-- bowling.com consumer price, picture and link for Ace Mitchell items,
-- filled by scraper/bowling-prices.mjs. Run once in Supabase -> SQL Editor.

alter table public.vendor_stock
  add column if not exists consumer_price    numeric(10,2),
  add column if not exists retail_name       text,
  add column if not exists retail_url        text,
  add column if not exists retail_image      text,
  add column if not exists retail_checked_at timestamptz;

-- New columns go on the end so the view can be replaced in place.
create or replace view public.vendor_stock_public as
  select vendor, item_code, coalesce(site_name, display_name) as name, display_name, upc, category,
         image_url, qty_total, checked_at,
         consumer_price, retail_name, retail_url, retail_image
  from public.vendor_stock
  where qty_total > 0;

grant select on public.vendor_stock_public to anon, authenticated;
