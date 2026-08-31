-- Fields the shop-floor day board reads, and the two pages that fill them in.
--
-- Run this in the Supabase SQL editor after add_staff_and_tickets.sql.
--
-- The board answers one question on a wall screen: what is happening today,
-- and what is coming. To do that it needs, for every line, who it is for, how
-- to reach them, what we are doing, when it is due, whether it is paid, and
-- who owns it. Appointments were missing the last two and orders were missing
-- a due date, so nothing else here changes behaviour -- it just makes those
-- six facts recordable.

-- ---------------------------------------------------------------------------
-- appointments
-- ---------------------------------------------------------------------------
alter table public.appointments
    add column if not exists staff_member text,
    add column if not exists paid         boolean not null default false;

comment on column public.appointments.staff_member is
    'A staff.name. Text, not a foreign key -- see add_staff_and_tickets.sql.';


-- ---------------------------------------------------------------------------
-- orders
--
-- Distinct from shop_order_date, which is when the shop placed the order with
-- a distributor. due_date is when the customer is expecting it -- a league
-- night, a tournament, a birthday. It is what sorts the board.
-- ---------------------------------------------------------------------------
alter table public.orders
    add column if not exists due_date date;

create index if not exists orders_due_idx on public.orders (due_date)
    where due_date is not null;

-- The board's "coming up" list is unfinished customer work with a date on it.
create index if not exists appointments_board_idx
    on public.appointments (appt_date, completed);

-- Check:
--   select count(*) from orders where due_date is not null;
--   select count(*) from appointments where staff_member is not null;
