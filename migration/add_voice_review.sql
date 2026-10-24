-- Things the voice assistant didn't understand or had to guess (an item it
-- couldn't find in Square or matched loosely, a customer it couldn't pin
-- down, a conversation that went nowhere), for review. Look in Supabase's
-- Table Editor -> voice_review; tick `reviewed` once dealt with.
-- Run through Supabase SQL Editor. Safe to run again.
create table if not exists public.voice_review (
    id uuid primary key default gen_random_uuid(),
    created_at timestamptz not null default now(),
    problem text not null,
    heard text,
    reply text,
    location text,
    reviewed boolean not null default false
);

-- Only the voice function (service key) writes it; the browser never reads it.
alter table public.voice_review enable row level security;
revoke all on public.voice_review from anon, authenticated;
