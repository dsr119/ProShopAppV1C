-- Run once in Supabase SQL Editor before deploying the updated app.
-- Existing bookings remain intact and can be linked using the appointment editor.
begin;
alter table public.appointments
  add column if not exists order_id uuid references public.orders(id);
create index if not exists appointments_order_id_idx
  on public.appointments(order_id) where deleted_at is null;
commit;
notify pgrst, 'reload schema';
