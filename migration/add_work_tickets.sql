-- Storage for the work-tickets function (the G2 work ticket to-do app):
-- the Microsoft sign-in token and which tickets were checked off on the glasses.
-- No email is stored. Run once in Supabase -> SQL Editor.

create table if not exists public.work_tickets_kv (
  key        text primary key,
  value      jsonb,
  updated_at timestamptz not null default now()
);

-- Locked down: no policies, so only the service-role key (the function) can
-- read or write it. The publishable key the apps ship sees nothing.
alter table public.work_tickets_kv enable row level security;
