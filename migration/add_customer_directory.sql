-- Supplemental customer contacts for the shared name/phone picker.
-- Run through Supabase SQL Editor. This contains no customer data.
create table if not exists public.customer_directory (
    id uuid primary key default gen_random_uuid(),
    customer_name text not null check (btrim(customer_name) <> ''),
    phone text not null check (phone ~ '^[0-9]{3}-[0-9]{3}-[0-9]{4}$'),
    source text not null default 'square',
    created_at timestamptz not null default now(),
    deleted_at timestamptz
);

-- The same name can legitimately have several numbers; relatives may share one.
create unique index if not exists customer_directory_contact_unique
    on public.customer_directory (
        lower(regexp_replace(btrim(customer_name), '\s+', ' ', 'g')),
        phone
    );

alter table public.customer_directory enable row level security;
-- Matches the current app's anonymous read access. Imports require SQL Editor;
-- the browser cannot insert, update, or delete directory records.
revoke all on public.customer_directory from anon, authenticated;
grant select on public.customer_directory to anon, authenticated;
drop policy if exists customer_directory_read on public.customer_directory;
create policy customer_directory_read on public.customer_directory
    for select to anon, authenticated using (deleted_at is null);
