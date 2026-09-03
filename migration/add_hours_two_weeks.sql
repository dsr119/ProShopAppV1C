-- Two weeks of hours, not one.
--
-- Run this in the Supabase SQL editor, after add_hours.sql.
--
-- add_hours.sql held fourteen rows and overwrote them every Sunday, on the
-- argument that nobody asks what the shop's hours were in March. That was
-- right about history and wrong about the future: the shop needs to fix a
-- Thursday in the week it is *currently* working, without that meaning it has
-- to leave next week's plan alone, and vice versa.
--
-- So the key moves from (location, day) to (location, date). A row is now a
-- specific day, not a slot, and two weeks -- or ten -- can exist at once.
--
-- The website is what makes this safe. It asks for the current week by date
-- range, not for "the latest rows", so a week nobody confirmed shows nothing
-- and says to ring the shop. It cannot show a stale week as though it were
-- this one, which is the failure the single-week design was avoiding.

-- ---------------------------------------------------------------------------
-- The key
-- ---------------------------------------------------------------------------

-- A row without a date can no longer be identified at all.
update public.hours set date = current_date where date is null;
alter table public.hours alter column date set not null;

alter table public.hours drop constraint if exists hours_location_day_key;
alter table public.hours drop constraint if exists hours_location_date_key;
alter table public.hours add  constraint hours_location_date_key unique (location, date);

-- The website's only query is "this location, this week", so index the range.
drop index if exists public.hours_order_idx;
create index if not exists hours_date_idx on public.hours (date);
create index if not exists hours_loc_date_idx on public.hours (location, date);


-- ---------------------------------------------------------------------------
-- Fill in whichever of the two weeks is missing
--
-- Whatever the table holds now becomes the starting point for both the
-- current week and the next one. Each missing day is copied from that
-- location's most recent row for the same weekday, which is the same "last
-- week's hours as the starting point" the dialog has always offered.
--
-- Existing rows are left exactly as they are -- `on conflict do nothing`.
-- Safe to run twice.
-- ---------------------------------------------------------------------------
with fortnight as (
    select generate_series(
               date_trunc('week', current_date)::date,          -- Postgres weeks start Monday
               date_trunc('week', current_date)::date + 13,
               interval '1 day'
           )::date as d
),
latest as (
    -- One template row per location per weekday: the most recent one.
    select distinct on (location, day_index)
           location, day, day_index,
           open1, close1, note1, open2, close2, note2
    from public.hours
    order by location, day_index, date desc
)
insert into public.hours (location, day, date, open1, close1, note1, open2, close2, note2)
select latest.location, latest.day, fortnight.d,
       latest.open1, latest.close1, latest.note1,
       latest.open2, latest.close2, latest.note2
from fortnight
join latest on latest.day_index = extract(isodow from fortnight.d)
on conflict (location, date) do nothing;


-- ---------------------------------------------------------------------------
-- What you should see: 28 rows, two weeks, seven days each per location.
-- ---------------------------------------------------------------------------
select date_trunc('week', date)::date as week_of,
       location,
       count(*) as days,
       min(date) as from_date,
       max(date) as to_date
from public.hours
group by 1, 2
order by 1, 2;


-- Rows accumulate from here -- 28 a fortnight, about 730 a year. They are
-- inert: nothing queries a week that has passed. Clearing out last season is
-- a `delete from public.hours where date < current_date - 60` whenever it
-- starts to bother you, and never urgent.
