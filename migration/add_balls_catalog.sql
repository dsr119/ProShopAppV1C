-- Ball catalog for the public website's Bowling Balls page.
--
-- Replaces the "Proshop Ball Sheet" Google Sheet. The daily scraper
-- (scraper/ball-scraper.mjs, run by .github/workflows/ball-scraper.yml) is
-- the only writer: it uses the service-role key, which bypasses RLS. The
-- public website and the app read with the publishable key, so anon gets
-- SELECT and nothing else.

create table if not exists public.balls (
  id                uuid primary key default gen_random_uuid(),
  -- brand|ball-name key the scraper matches on (bowwwlProductKey_), so a ball
  -- renamed slightly on bowling.com updates its row instead of duplicating.
  match_key         text not null unique,
  product_url       text,
  brand             text not null,
  name              text not null,
  release_month     date,            -- first of the month
  price             numeric(10, 2),
  image_url         text,
  rg                text,
  diff              text,
  int_diff          text,
  cover_type        text,
  core_type         text,
  cover_finish      text,
  ball_place        text,            -- performance tier, e.g. "High-Performance"
  oil_condition     text,
  ball_finish       text,
  fragrance         text,
  coverstock        text,
  core              text,
  discontinued      text not null default 'Unknown'
                    check (discontinued in ('Yes', 'No', 'Unknown')),
  -- The newest reactive balls, recomputed by every scraper run. This is what
  -- the sheet's "Recent Releases" tab held.
  is_recent_release boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists balls_recent_idx on public.balls (is_recent_release) where is_recent_release;

-- Staff picks on the Bowling Balls page. One row per person, balls in the
-- order they should show. Edited by hand in the Supabase table editor.
create table if not exists public.staff_bags (
  staff_member text primary key,
  sort_order   integer not null default 0,
  balls        text[] not null default '{}',
  updated_at   timestamptz not null default now()
);

alter table public.balls      enable row level security;
alter table public.staff_bags enable row level security;

create policy balls_read on public.balls
  for select to anon, authenticated using (true);

create policy staff_bags_read on public.staff_bags
  for select to anon, authenticated using (true);

-- No insert/update/delete policies: with RLS on, anon and authenticated
-- cannot write either table. The scraper's service-role key bypasses RLS.
