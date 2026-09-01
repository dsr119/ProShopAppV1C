-- Opening hours, one row per location per weekday.
--
-- Run this in the Supabase SQL editor. It replaces the Google Sheet the hours
-- used to live in: the app confirms the week here, and the public website
-- reads the same table over the REST API.
--
-- Fourteen rows, forever. Confirming a week UPDATES them -- it does not append
-- a new week -- because nobody has ever asked what the shop's hours were in
-- March. Keeping history would mean every reader needing "the latest week",
-- and the first bug would be a website showing a week that never ended.

-- ---------------------------------------------------------------------------
-- hours
-- ---------------------------------------------------------------------------
create table if not exists public.hours (
    id         uuid primary key default gen_random_uuid(),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    -- The customer-facing name, exactly as the website prints it.
    location   text not null,

    day        text not null
               check (day in ('Monday','Tuesday','Wednesday','Thursday',
                              'Friday','Saturday','Sunday')),

    -- The calendar date this weekday falls on in the current week. Moving
    -- these forward seven days is what "confirming the week" does.
    date       date,

    -- Times are TEXT, not `time`.
    --
    -- The shop does not only open at times. "After League", "By Appointment",
    -- "Closed" are all real answers that have been in this column for years,
    -- and a `time` column would reject every one of them. The website prints
    -- whatever is here verbatim, so text is not a shortcut -- it is the type
    -- that actually holds the data.
    --
    -- Empty open1 means closed. That is what the website renders it as.
    open1      text,
    close1     text,
    note1      text,

    -- The second opening, for a day that shuts and reopens -- Tuesday at Idle
    -- Hours is 11:30-2 and again 6-8:30. Empty on most rows.
    open2      text,
    close2     text,
    note2      text,

    -- Monday-first ordering, so no caller has to carry a day-name list around.
    -- A CASE over constants is immutable, which a generated column requires.
    day_index  smallint generated always as (
                   case day
                       when 'Monday'    then 1
                       when 'Tuesday'   then 2
                       when 'Wednesday' then 3
                       when 'Thursday'  then 4
                       when 'Friday'    then 5
                       when 'Saturday'  then 6
                       when 'Sunday'    then 7
                       else 8
                   end
               ) stored
);

-- One row per location per day. This is also the conflict target the app
-- upserts on, so it has to be a real constraint rather than an expression
-- index -- PostgREST's on_conflict cannot name an expression.
alter table public.hours drop constraint if exists hours_location_day_key;
alter table public.hours add  constraint hours_location_day_key unique (location, day);

create index if not exists hours_order_idx on public.hours (location, day_index);

-- schema.sql defines this, but it is not in every database this app has been
-- run against -- so create it here rather than assume. `create or replace` is
-- idempotent: where it already exists this rewrites it with the same body.
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists hours_touch on public.hours;
create trigger hours_touch before update on public.hours
    for each row execute function public.touch_updated_at();


-- ---------------------------------------------------------------------------
-- Row Level Security
--
-- Same shape as the other tables: anon reads, inserts and updates; no delete.
-- The public website reads this table with the same publishable key, so the
-- read policy is doing real work here rather than being a formality.
-- ---------------------------------------------------------------------------
alter table public.hours enable row level security;

drop policy if exists hours_read   on public.hours;
drop policy if exists hours_insert on public.hours;
drop policy if exists hours_update on public.hours;

create policy hours_read   on public.hours for select to anon using (true);
create policy hours_insert on public.hours for insert to anon with check (true);
create policy hours_update on public.hours for update to anon using (true) with check (true);


-- ---------------------------------------------------------------------------
-- Seed -- the fourteen rows, carried over from the spreadsheet.
--
-- Dated to the current week (Mon 2026-08-31 to Sun 2026-09-06) so the website
-- is correct the moment this runs. The first Sunday confirmation moves them
-- to 09-07 to 09-13 and every week after that.
-- ---------------------------------------------------------------------------
insert into public.hours (location, day, date, open1, close1, note1, open2, close2, note2)
values
  ('Valley Bowling Lanes', 'Monday',    '2026-08-31', '6:00 PM',  '8:30 PM',  null,                          null,      null,      null),
  ('Valley Bowling Lanes', 'Tuesday',   '2026-09-01', '6:00 PM',  '8:30 PM',  'Doug Only',                   null,      null,      null),
  ('Valley Bowling Lanes', 'Wednesday', '2026-09-02', '6:00 PM',  '8:30 PM',  null,                          null,      null,      null),
  ('Valley Bowling Lanes', 'Thursday',  '2026-09-03', '6:00 PM',  '8:30 PM',  null,                          null,      null,      null),
  ('Valley Bowling Lanes', 'Friday',    '2026-09-04', null,       null,       null,                          null,      null,      null),
  ('Valley Bowling Lanes', 'Saturday',  '2026-09-05', null,       null,       null,                          null,      null,      null),
  ('Valley Bowling Lanes', 'Sunday',    '2026-09-06', null,       null,       null,                          null,      null,      null),

  ('Idle Hours South',     'Monday',    '2026-08-31', '9:00 PM',  '10:30 PM', 'Shop will open after league', null,      null,      null),
  ('Idle Hours South',     'Tuesday',   '2026-09-01', '11:30 AM', '2:00 PM',  'Amy Only',                    '6:00 PM', '8:30 PM', null),
  ('Idle Hours South',     'Wednesday', '2026-09-02', null,       null,       null,                          null,      null,      null),
  ('Idle Hours South',     'Thursday',  '2026-09-03', '6:00 PM',  '8:00 PM',  null,                          null,      null,      null),
  ('Idle Hours South',     'Friday',    '2026-09-04', null,       null,       null,                          null,      null,      null),
  ('Idle Hours South',     'Saturday',  '2026-09-05', '9:00 AM',  '11:00 AM', null,                          null,      null,      null),
  ('Idle Hours South',     'Sunday',    '2026-09-06', null,       null,       null,                          null,      null,      null)
on conflict (location, day) do nothing;
