-- Shop words for Square items, used by the voice assistant's invoices.
-- "standard drill" -> "Drilling - Standard": when what's said contains
-- `spoken`, the assistant searches Square's item library for `square_item`
-- instead. Edit rows in Supabase's Table Editor; the longest match wins.
-- Run through Supabase SQL Editor. Safe to run again.
create table if not exists public.voice_aliases (
    id uuid primary key default gen_random_uuid(),
    spoken text not null unique check (btrim(spoken) <> ''),
    square_item text not null check (btrim(square_item) <> ''),
    created_at timestamptz not null default now()
);

-- Only the voice function (service key) reads it; the browser never does.
alter table public.voice_aliases enable row level security;
revoke all on public.voice_aliases from anon, authenticated;

-- Examples: change the right-hand names to the items' exact names in Square.
insert into public.voice_aliases (spoken, square_item) values
    ('standard drill', 'Standard Drill'),
    ('slug combo', 'Slug Combo')
on conflict (spoken) do nothing;
