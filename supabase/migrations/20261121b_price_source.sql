-- Where each bag and shoe price came from: 'shop' (the shop's own Square
-- prices, scraper/shop-prices.csv) or 'web' (bowling.com / bowlerx.com).
-- Website prices are never lowered; shop prices always win. Filled by
-- scraper/bowling-prices.mjs. Run once in Supabase -> SQL Editor.

alter table public.vendor_stock
  add column if not exists price_source text;
