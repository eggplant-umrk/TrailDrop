-- TrailDrop Supabase schema for the hackathon MVP.

create extension if not exists pgcrypto;

create table if not exists public.items (
    id uuid primary key default gen_random_uuid(),
    title varchar not null,
    type varchar not null check (type in ('pickup', 'experience')),
    price integer not null constraint items_price_nonnegative check (price >= 0),
    stock integer not null constraint items_stock_nonnegative check (stock >= 0),
    location_name varchar not null,
    created_at timestamptz default now()
);

-- Daily recurring pickup-availability window. Null on either column means
-- "no pickup window recorded" -- not "always available".
alter table public.items
    add column if not exists pickup_available_from time,
    add column if not exists pickup_available_to time;

create table if not exists public.reservations (
    id uuid primary key default gen_random_uuid(),
    item_id uuid not null references public.items(id),
    user_name varchar not null,
    qr_token uuid not null unique default gen_random_uuid(),
    access_token uuid not null unique default gen_random_uuid(),
    status varchar not null default 'pending' check (status in ('pending', 'completed', 'cancelled')),
    requested_at timestamptz,
    reserved_at timestamptz default now()
);

alter table public.reservations
    add column if not exists requested_at timestamptz;

-- Mock payment method/status (no real payment gateway). Nullable/'pending'
-- default so existing reservations that predate this feature aren't
-- misrepresented as having a known method or a real payment.
alter table public.reservations
    add column if not exists payment_method varchar,
    add column if not exists payment_status varchar not null default 'pending';

-- Optional pickup time window (start/end), selected by the customer in
-- RouteTest.jsx. Independent of requested_at (single exact time, experience
-- items only); nullable so existing reservations and non-RouteTest flows
-- are unaffected.
alter table public.reservations
    add column if not exists pickup_window_start timestamptz,
    add column if not exists pickup_window_end timestamptz;

-- Apply the tightened constraints when this script runs against an existing project.
update public.reservations
set qr_token = gen_random_uuid()
where qr_token is null;

update public.reservations
set status = 'pending'
where status is null;

alter table public.reservations alter column qr_token set not null;
alter table public.reservations alter column status set not null;

-- The status check constraint above only applies on a fresh create. Widen it
-- on existing projects too, to allow the 'cancelled' status. This was
-- originally declared inline (unnamed) inside the CREATE TABLE, so Postgres
-- assigned it the default name "reservations_status_check".
alter table public.reservations
    drop constraint if exists reservations_status_check;

do $$
begin
    if not exists (
        select 1
        from pg_constraint
        where conname = 'items_price_nonnegative'
          and conrelid = 'public.items'::regclass
    ) then
        alter table public.items
            add constraint items_price_nonnegative check (price >= 0);
    end if;

    if not exists (
        select 1
        from pg_constraint
        where conname = 'items_stock_nonnegative'
          and conrelid = 'public.items'::regclass
    ) then
        alter table public.items
            add constraint items_stock_nonnegative check (stock >= 0);
    end if;

    if not exists (
        select 1
        from pg_constraint
        where conname = 'items_pickup_window_consistent'
          and conrelid = 'public.items'::regclass
    ) then
        alter table public.items
            add constraint items_pickup_window_consistent
            check (
                (pickup_available_from is null) = (pickup_available_to is null)
                and (pickup_available_from is null or pickup_available_from < pickup_available_to)
            );
    end if;

    if not exists (
        select 1
        from pg_constraint
        where conname = 'reservations_status_check'
          and conrelid = 'public.reservations'::regclass
    ) then
        alter table public.reservations
            add constraint reservations_status_check
            check (status in ('pending', 'completed', 'cancelled'));
    end if;

    if not exists (
        select 1
        from pg_constraint
        where conname = 'reservations_payment_method_check'
          and conrelid = 'public.reservations'::regclass
    ) then
        alter table public.reservations
            add constraint reservations_payment_method_check
            check (payment_method is null or payment_method in ('paypay', 'credit_card'));
    end if;

    if not exists (
        select 1
        from pg_constraint
        where conname = 'reservations_payment_status_check'
          and conrelid = 'public.reservations'::regclass
    ) then
        alter table public.reservations
            add constraint reservations_payment_status_check
            check (payment_status in ('pending', 'paid', 'cancelled'));
    end if;

    -- Same shape as items_pickup_window_consistent above: both columns
    -- null together, or both set with start strictly before end.
    if not exists (
        select 1
        from pg_constraint
        where conname = 'reservations_pickup_window_consistent'
          and conrelid = 'public.reservations'::regclass
    ) then
        alter table public.reservations
            add constraint reservations_pickup_window_consistent
            check (
                (pickup_window_start is null) = (pickup_window_end is null)
                and (pickup_window_start is null or pickup_window_start < pickup_window_end)
            );
    end if;
end
$$;

alter table public.items enable row level security;
alter table public.reservations enable row level security;

drop policy if exists items_public_read on public.items;
create policy items_public_read
on public.items
for select
to anon, authenticated
using (true);

grant select on table public.items to anon, authenticated;
revoke insert, update, delete on table public.items from anon, authenticated;
revoke all on table public.reservations from anon, authenticated;
grant select, update on table public.items to service_role;
grant select, insert, update on table public.reservations to service_role;

drop function if exists public.create_reservation_with_stock(uuid, varchar);
drop function if exists public.create_reservation_with_stock(uuid, varchar, timestamptz);
drop function if exists public.create_reservation_with_stock(uuid, varchar, timestamptz, varchar);

-- payment_method is validated both here (defense in depth) and, primarily,
-- by the Backend's create_reservation() before this RPC is ever called.
-- payment_status is always 'paid' on a successful insert: there is no real
-- payment gateway, so the mock payment "succeeds" synchronously with stock
-- decrement, atomically, in this same transaction. pickup_window_start/end
-- are optional (RouteTest-selected pickup time range) and independent of
-- requested_at; both null unless the Frontend sent a RouteTest-selected
-- window.
create or replace function public.create_reservation_with_stock(
    p_item_id uuid,
    p_user_name varchar,
    p_requested_at timestamptz default null,
    p_payment_method varchar default null,
    p_pickup_window_start timestamptz default null,
    p_pickup_window_end timestamptz default null
)
returns setof public.reservations
language plpgsql
security invoker
set search_path = ''
as $$
declare
    created_reservation public.reservations;
    item_type varchar;
begin
    if p_payment_method is null or p_payment_method not in ('paypay', 'credit_card') then
        raise exception 'INVALID_PAYMENT_METHOD' using errcode = '22023';
    end if;

    update public.items
    set stock = stock - 1
    where id = p_item_id
      and stock > 0
    returning type into item_type;

    if not found then
        if exists (select 1 from public.items where id = p_item_id) then
            raise exception 'OUT_OF_STOCK' using errcode = 'P0001';
        end if;
        raise exception 'ITEM_NOT_FOUND' using errcode = 'P0002';
    end if;

    if item_type = 'experience' and p_requested_at is null then
        raise exception 'EXPERIENCE_DATE_REQUIRED' using errcode = '22023';
    end if;

    if p_requested_at is not null and p_requested_at <= now() then
        raise exception 'REQUESTED_AT_IN_PAST' using errcode = '22023';
    end if;

    insert into public.reservations (
        item_id, user_name, requested_at, payment_method, payment_status,
        pickup_window_start, pickup_window_end
    )
    values (
        p_item_id,
        p_user_name,
        case when item_type = 'experience' then p_requested_at else null end,
        p_payment_method,
        'paid',
        p_pickup_window_start,
        p_pickup_window_end
    )
    returning * into created_reservation;

    return next created_reservation;
end;
$$;

revoke all on function public.create_reservation_with_stock(uuid, varchar, timestamptz, varchar, timestamptz, timestamptz)
from public, anon, authenticated;
grant execute on function public.create_reservation_with_stock(uuid, varchar, timestamptz, varchar, timestamptz, timestamptz)
to service_role;

-- Cancels a pending reservation and returns one unit of stock to its item,
-- as a single atomic operation. Allowed transition is pending -> cancelled
-- only; completed/cancelled reservations raise RESERVATION_NOT_CANCELLABLE.
--
-- The initial SELECT ... FOR UPDATE locks the reservation row so that two
-- concurrent cancel calls for the same reservation cannot both observe
-- 'pending' and both return stock: the second call blocks until the first
-- commits, then sees the already-cancelled status and is rejected.
--
-- The same UPDATE also moves payment_status from 'paid' to 'cancelled'
-- (leaving 'pending' payment_status alone) -- one statement, one
-- transaction, so cancellation and the payment_status change can't happen
-- separately or only one of the two.
create or replace function public.cancel_reservation_with_stock(
    p_reservation_id uuid,
    p_access_token uuid
)
returns setof public.reservations
language plpgsql
security invoker
set search_path = ''
as $$
declare
    cancelled_reservation public.reservations;
    current_status varchar;
begin
    select status into current_status
    from public.reservations
    where id = p_reservation_id
      and access_token = p_access_token
    for update;

    if not found then
        raise exception 'RESERVATION_NOT_FOUND' using errcode = 'P0003';
    end if;

    if current_status <> 'pending' then
        raise exception 'RESERVATION_NOT_CANCELLABLE' using errcode = 'P0004';
    end if;

    -- payment_statusが'paid'(モック決済成功済み)なら'cancelled'にする。
    -- 'pending'(支払い機能追加以前の既存予約など)はそのまま変更しない。
    update public.reservations
    set status = 'cancelled',
        payment_status = case when payment_status = 'paid' then 'cancelled' else payment_status end
    where id = p_reservation_id
      and access_token = p_access_token
      and status = 'pending'
    returning * into cancelled_reservation;

    if not found then
        raise exception 'RESERVATION_NOT_CANCELLABLE' using errcode = 'P0004';
    end if;

    update public.items
    set stock = stock + 1
    where id = cancelled_reservation.item_id;

    return next cancelled_reservation;
end;
$$;

revoke all on function public.cancel_reservation_with_stock(uuid, uuid)
from public, anon, authenticated;
grant execute on function public.cancel_reservation_with_stock(uuid, uuid)
to service_role;

-- Pending reservations whose pickup_window_end has passed keep their stock
-- reserved forever unless someone explicitly cancels them. This repository
-- has no cron/scheduler infrastructure, so a staff-authenticated Backend
-- endpoint (POST /staff/reservations/expire-stale) calls this on demand;
-- production must run it periodically (cron etc., see the README runbook).
-- Grace period: expired only once pickup_window_end + 30 minutes < now().
-- Only reservations with a recorded pickup_window_end are eligible;
-- reservations made without RouteTest (pickup_window_end null) are left
-- untouched. Concurrency-safe for the same reason as
-- cancel_reservation_with_stock's final UPDATE: the inner SELECT ... FOR
-- UPDATE locks matching rows before the outer UPDATE writes to them, so a
-- row already cancelled/completed concurrently is never double-processed.
-- PM review m-2: capped at batch_size rows per call so a large backlog can't
-- hold one transaction open indefinitely; call the endpoint again for more.
create or replace function public.expire_stale_pending_reservations()
returns setof public.reservations
language plpgsql
security invoker
set search_path = ''
as $$
declare
    expired_reservation public.reservations;
    batch_size constant integer := 500;
    grace_period constant interval := interval '30 minutes';
begin
    for expired_reservation in
        update public.reservations
        set status = 'cancelled',
            payment_status = case when payment_status = 'paid' then 'cancelled' else payment_status end
        where status = 'pending'
          and id in (
            select id
            from public.reservations
            where status = 'pending'
              and pickup_window_end is not null
              and pickup_window_end + grace_period < now()
            order by pickup_window_end
            limit batch_size
            for update
        )
        returning *
    loop
        update public.items
        set stock = stock + 1
        where id = expired_reservation.item_id;

        return next expired_reservation;
    end loop;
end;
$$;

revoke all on function public.expire_stale_pending_reservations()
from public, anon, authenticated;
grant execute on function public.expire_stale_pending_reservations()
to service_role;

insert into public.items (id, title, type, price, stock, location_name)
values
    (
        '11111111-1111-4111-8111-111111111111',
        '間伐材の薪（未加工）',
        'pickup',
        800,
        12,
        '道の駅 ロック・ガーデンひちそう'
    ),
    (
        '22222222-2222-4222-8222-222222222222',
        'ジビエ鹿肉レトルトカレー',
        'pickup',
        950,
        20,
        '道の駅 ロック・ガーデンひちそう'
    ),
    (
        '33333333-3333-4333-8333-333333333333',
        'ハンターと行くジビエ解体ワークショップ',
        'experience',
        3500,
        8,
        '七宗町地域交流スペース'
    )
on conflict (id) do nothing;

-- Example pickup hours for the seeded pickup items. The experience item is
-- intentionally left without a window.
update public.items
set pickup_available_from = '09:00',
    pickup_available_to = '18:00'
where id in (
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222'
);
