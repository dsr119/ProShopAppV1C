-- Run once in the ProShopAppV1C Supabase SQL Editor before using Order Check In.
-- Existing orders remain unchecked; no historical arrivals are guessed.
alter table public.orders add column if not exists checked_in_at timestamptz;
create index if not exists orders_checked_in_at_idx
    on public.orders (checked_in_at) where deleted_at is null;
