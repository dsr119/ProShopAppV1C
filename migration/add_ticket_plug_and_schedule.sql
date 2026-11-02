-- Run once in Supabase SQL Editor before deploying the tickets queue update.
--
-- tickets.plug_state: where a plug job is. NULL = not started.
--   prepped -> at_keiths -> plugged (plugged in shop)
-- appointments.ticket_id: the ticket an appointment was booked from, so the
--   ticket can show "Scheduled". Existing rows are untouched.
begin;
alter table public.tickets
  add column if not exists plug_state text;
alter table public.tickets
  drop constraint if exists tickets_plug_state_check;
alter table public.tickets
  add constraint tickets_plug_state_check
  check (plug_state is null or plug_state in ('prepped','at_keiths','plugged'));

alter table public.appointments
  add column if not exists ticket_id uuid references public.tickets(id);
create index if not exists appointments_ticket_id_idx
  on public.appointments(ticket_id) where deleted_at is null;
commit;
notify pgrst, 'reload schema';
