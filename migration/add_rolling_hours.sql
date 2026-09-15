-- Run after add_hours_two_weeks.sql. Keeps public hours available even when
-- nobody opens the order book. Existing dates are never overwritten.
begin;
create or replace function public.ensure_hours_fortnight()
returns void language sql security invoker set search_path = public as $$
  with dates as (
    select (date_trunc('week', now() at time zone 'America/New_York')::date + i) as d
    from generate_series(0, 13) i
  ), locations as (
    select distinct location from public.hours
  )
  insert into public.hours (location, day, date, open1, close1, note1, open2, close2, note2)
  select l.location,
         (array['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'])[extract(isodow from d.d)::int],
         d.d, t.open1, t.close1, t.note1, t.open2, t.close2, t.note2
  from locations l cross join dates d
  left join lateral (
    select h.* from public.hours h
    where h.location = l.location
      and h.day_index = extract(isodow from d.d)
      and h.date < d.d
    order by h.date desc limit 1
  ) t on true
  on conflict (location, date) do nothing;
$$;
select public.ensure_hours_fortnight();
-- Supabase supports pg_cron. Run as the project's SQL Editor database owner.
create extension if not exists pg_cron;
select cron.schedule('proshop-rolling-hours', '5 5 * * *',
                     'select public.ensure_hours_fortnight();');
commit;
