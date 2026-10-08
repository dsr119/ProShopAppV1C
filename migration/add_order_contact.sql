-- Run in Supabase SQL Editor before deploying the Drilling "Texted" button.
-- Existing orders have no recorded contact; no history is inferred.
alter table public.orders
  add column if not exists last_contacted_at timestamptz;

notify pgrst, 'reload schema';
