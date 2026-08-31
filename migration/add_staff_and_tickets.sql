-- Staff roster and the staff ticket queue.
--
-- Run this in the Supabase SQL editor before opening the Tickets pages.
--
-- Two tables rather than one: the roster is referenced from tickets, from the
-- drilling queue and from appointments, so it cannot live inside tickets. It
-- is joined by NAME, not by id -- orders.staff_member was already free text
-- from the workbook import, and a foreign key would have rejected every
-- historical row. The roster's job is to feed the dropdowns and keep the
-- spelling consistent, not to police ten years of typed-in names.

-- ---------------------------------------------------------------------------
-- staff
-- ---------------------------------------------------------------------------
create table if not exists public.staff (
    id         uuid primary key default gen_random_uuid(),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    name       text not null,

    -- Soft removal. Someone who leaves still has their name on last year's
    -- tickets and orders, so the row has to stay readable -- it just stops
    -- appearing in the "assign to" dropdowns.
    active     boolean not null default true,

    -- Hand-ordered so the people who pick up most of the work sit at the top
    -- of every dropdown. NULLs sort last, then alphabetical.
    sort_order integer
);

-- One live person per name. Case-insensitive, because "keith" and "Keith"
-- assigned to the same human is the bug this prevents. Partial, so an
-- inactive Keith does not block re-hiring one.
create unique index if not exists staff_name_unique
    on public.staff (lower(name)) where active;


-- ---------------------------------------------------------------------------
-- tickets
-- ---------------------------------------------------------------------------
create table if not exists public.tickets (
    id            uuid primary key default gen_random_uuid(),
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now(),

    -- When the staff member hit submit. Distinct from created_at so a ticket
    -- entered later on someone's behalf can carry the real time.
    submitted_at  timestamptz not null default now(),
    submitted_by  text not null,
    location      text check (location in ('Valley','South Side','Both')),

    title         text not null,
    details       text,
    category      text check (category in
                    ('Equipment','Building','Supplies','Customer','Computer','Other')),
    priority      text not null default 'normal'
                  check (priority in ('low','normal','high','urgent')),

    -- 'new' is the review queue: everything Keith has not looked at yet.
    status        text not null default 'new'
                  check (status in ('new','assigned','in_progress','blocked','done')),

    assigned_to   text,          -- a staff.name, kept as text -- see note above
    assigned_at   timestamptz,
    due_date      date,

    resolution    text,
    completed_at  timestamptz,

    -- Soft delete, same reasoning as orders: the endpoint is public.
    deleted_at    timestamptz
);

create index if not exists tickets_status_idx   on public.tickets (status);
create index if not exists tickets_assigned_idx on public.tickets (lower(assigned_to));
create index if not exists tickets_due_idx      on public.tickets (due_date);
create index if not exists tickets_deleted_idx  on public.tickets (deleted_at);

-- The default view of the review page: unreviewed first, oldest wait first.
create index if not exists tickets_queue_idx
    on public.tickets ((status = 'new') desc, submitted_at asc);


-- ---------------------------------------------------------------------------
-- updated_at maintenance -- reuses the trigger function from schema.sql
-- ---------------------------------------------------------------------------
drop trigger if exists staff_touch on public.staff;
create trigger staff_touch before update on public.staff
    for each row execute function public.touch_updated_at();

drop trigger if exists tickets_touch on public.tickets;
create trigger tickets_touch before update on public.tickets
    for each row execute function public.touch_updated_at();


-- ---------------------------------------------------------------------------
-- Row Level Security -- same posture as the rest of the app: anon may read,
-- insert and update, but never delete. Rows are hidden, not erased.
-- ---------------------------------------------------------------------------
alter table public.staff   enable row level security;
alter table public.tickets enable row level security;

drop policy if exists staff_read   on public.staff;
drop policy if exists staff_insert on public.staff;
drop policy if exists staff_update on public.staff;

create policy staff_read   on public.staff for select to anon using (true);
create policy staff_insert on public.staff for insert to anon with check (true);
create policy staff_update on public.staff for update to anon using (true) with check (true);

drop policy if exists tickets_read   on public.tickets;
drop policy if exists tickets_insert on public.tickets;
drop policy if exists tickets_update on public.tickets;

create policy tickets_read   on public.tickets for select to anon using (true);
create policy tickets_insert on public.tickets for insert to anon with check (true);
create policy tickets_update on public.tickets for update to anon using (true) with check (true);


-- ---------------------------------------------------------------------------
-- Seed the roster from names already recorded against orders, so the
-- dropdowns are not empty on day one. Edit the list on the Tickets page.
-- ---------------------------------------------------------------------------
insert into public.staff (name, sort_order)
select distinct on (lower(trim(staff_member))) trim(staff_member), null::integer
  from public.orders
 where staff_member is not null
   and trim(staff_member) <> ''
   and length(trim(staff_member)) <= 40
 order by lower(trim(staff_member))
on conflict do nothing;

-- Keith reviews the queue, so make sure he is on it regardless.
insert into public.staff (name, sort_order)
select 'Keith', 0
 where not exists (select 1 from public.staff where lower(name) = 'keith' and active);

-- Check:
--   select name, active, sort_order from staff order by sort_order nulls last, name;
--   select count(*) from tickets where status = 'new';
