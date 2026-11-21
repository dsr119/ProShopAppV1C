-- bowling.com filter values for each bag and shoe (type, balls held, holds
-- shoes, gender, athletic/performance, width, hand, brand, color), filled by
-- scraper/bowling-prices.mjs, so the website's Shoes and Bags pages can
-- filter by them. Run once in Supabase -> SQL Editor.
--
-- Example: {"bag_type":["Roller/Tote"],"balls_held":["3"],"holds_shoes":true,
--           "brand":["Storm"],"color":["Black","Blue"]}

alter table public.vendor_stock
  add column if not exists retail_attrs jsonb;

-- New columns go on the end so the view can be replaced in place.
create or replace view public.vendor_stock_public as
  select vendor, item_code, coalesce(site_name, display_name) as name, display_name, upc, category,
         image_url, qty_total, checked_at,
         consumer_price, retail_name, retail_url, retail_image,
         retail_attrs
  from public.vendor_stock
  where qty_total > 0;

grant select on public.vendor_stock_public to anon, authenticated;
