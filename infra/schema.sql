-- TrailDrop Supabase schema for the hackathon MVP.

create extension if not exists pgcrypto;

create table if not exists public.shops (
    id uuid primary key default gen_random_uuid(),
    name varchar not null constraint shops_name_key unique,
    description text,
    website_url text,
    created_at timestamptz default now()
);

alter table public.shops
    add column if not exists description text,
    add column if not exists website_url text;

create table if not exists public.items (
    id uuid primary key default gen_random_uuid(),
    title varchar not null,
    type varchar not null check (type in ('pickup', 'experience')),
    price integer not null constraint items_price_nonnegative check (price >= 0),
    stock integer not null constraint items_stock_nonnegative check (stock >= 0),
    location_name varchar not null,
    shop_id uuid references public.shops(id),
    description text,
    category varchar,
    content_amount varchar,
    storage_method text,
    source_url text,
    price_note text,
    is_active boolean not null default true,
    created_at timestamptz default now()
);

-- Daily recurring pickup-availability window. Null on either column means
-- "no pickup window recorded" -- not "always available".
alter table public.items
    add column if not exists pickup_available_from time,
    add column if not exists pickup_available_to time,
    add column if not exists shop_id uuid,
    add column if not exists description text,
    add column if not exists category varchar,
    add column if not exists content_amount varchar,
    add column if not exists storage_method text,
    add column if not exists source_url text,
    add column if not exists price_note text,
    add column if not exists is_active boolean not null default true;

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
        where conname = 'items_shop_id_fkey'
          and conrelid = 'public.items'::regclass
    ) then
        alter table public.items
            add constraint items_shop_id_fkey
            foreign key (shop_id) references public.shops(id);
    end if;

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

alter table public.shops enable row level security;
alter table public.items enable row level security;
alter table public.reservations enable row level security;

drop policy if exists shops_public_read on public.shops;
create policy shops_public_read
on public.shops
for select
to anon, authenticated
using (true);

drop policy if exists items_public_read on public.items;
create policy items_public_read
on public.items
for select
to anon, authenticated
using (is_active = true);

grant select on table public.items to anon, authenticated;
revoke insert, update, delete on table public.items from anon, authenticated;
grant select on table public.shops to anon, authenticated;
revoke insert, update, delete on table public.shops from anon, authenticated;
revoke all on table public.reservations from anon, authenticated;
grant select, insert, update on table public.shops to service_role;
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
      and is_active = true
      and stock > 0
    returning type into item_type;

    if not found then
        if exists (
            select 1 from public.items
            where id = p_item_id and is_active = true
        ) then
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

-- Pickup locations with coordinates for route-based pickup selection
-- (PICKUP_SELECTION_MODE=route). items stays linked by name
-- (items.location_name = pickup_locations.name). No seed rows: real
-- coordinates must be confirmed on site before inserting them. RLS with no
-- policies + no anon/authenticated privileges: service_role only.
create table if not exists public.pickup_locations (
    id uuid primary key default gen_random_uuid(),
    name varchar not null
        constraint pickup_locations_name_key unique,
    latitude double precision not null
        constraint pickup_locations_latitude_range check (latitude between -90 and 90),
    longitude double precision not null
        constraint pickup_locations_longitude_range check (longitude between -180 and 180),
    is_active boolean not null default true,
    created_at timestamptz default now()
);

alter table public.pickup_locations enable row level security;

revoke all on table public.pickup_locations from anon, authenticated;
grant select on table public.pickup_locations to service_role;

-- Product providers are separate from the pickup location recorded on items.
insert into public.shops (id, name)
values
    ('b1111111-1111-4111-8111-111111111111', '七宗食品「こぶしの里」'),
    ('b2222222-2222-4222-8222-222222222222', '炭火焼肉たつみや'),
    ('b3333333-3333-4333-8333-333333333333', '福薪'),
    ('b4444444-4444-4444-8444-444444444444', '株式会社菊泉本舗')
on conflict (name) do update
set name = excluded.name;

with candidate (
    id, title, price, initial_stock, description, category, content_amount,
    storage_method, source_url, shop_name
) as (
    values
        (
            'a1111111-1111-4111-8111-111111111111'::uuid,
            '鮎の甘露煮の燻製 100gパック', 540, 12,
            '鮎の甘露煮を燻製にした、七宗食品の川魚のお土産。',
            '川魚・燻製', '100g',
            '常温。直射日光・高温多湿を避け、冷暗所で保存。',
            'https://hida-seiryu.com/product/kunsei/kb0220010/',
            '七宗食品「こぶしの里」'
        ),
        (
            'a2222222-2222-4222-8222-222222222222'::uuid,
            '若鶏の皮肝けいちゃん 200g×2袋', 900, 8,
            '岐阜県産若鶏の皮・砂肝・心臓などを米麹味噌で味付け。',
            'けいちゃん', '200g×2袋',
            '冷凍。受取までの保冷方法を確認。',
            'https://www.furusato-tax.jp/product/detail/21504/7117947',
            '炭火焼肉たつみや'
        ),
        (
            'a3333333-3333-4333-8333-333333333333'::uuid,
            '東濃ひのき薪 20kg×1箱 皮つき', 2800, 2,
            '七宗町の森林資源を活用した、自然乾燥の東濃ヒノキ薪。',
            '森林・薪', '20kg×1箱',
            '常温。天然材料のため虫・カビに注意。',
            'https://www.furusato-tax.jp/product/detail/21504/7211223',
            '福薪'
        ),
        (
            'a4444444-4444-4444-8444-444444444444'::uuid,
            '出来立てくんたま（3個入×5袋）通常パック', 1500, 10,
            '岐阜県産の鶏卵を鮎だしで味付けした、こぶしの里の燻製卵。',
            '燻製卵', '3個入×5袋',
            '要冷蔵。賞味期限は製造日を含め5日。',
            'https://hida-seiryu.com/product/kunsei/kb0220033/',
            '七宗食品「こぶしの里」'
        ),
        (
            'a5555555-5555-4555-8555-555555555555'::uuid,
            '菊泉本舗 特選 お茶せんべい 26枚入り', 700, 12,
            '七宗町の菊泉本舗が扱う、お茶の風味を楽しめるせんべい。',
            '茶菓子', '26枚',
            '保存方法は現物表示を確認。',
            'https://furusato.saisoncard.co.jp/products/detail.php?product_id=328660',
            '株式会社菊泉本舗'
        )
)
insert into public.items (
    id, title, type, price, stock, location_name,
    pickup_available_from, pickup_available_to, shop_id, description,
    category, content_amount, storage_method, source_url, price_note, is_active
)
select
    candidate.id, candidate.title, 'pickup', candidate.price,
    candidate.initial_stock, '道の駅 ロック・ガーデンひちそう',
    null::time, null::time, shops.id, candidate.description,
    candidate.category, candidate.content_amount, candidate.storage_method,
    candidate.source_url,
    'デモ用設定価格。提供者の販売価格ではありません。',
    true
from candidate
join public.shops on shops.name = candidate.shop_name
on conflict (id) do update
set title = excluded.title,
    type = excluded.type,
    price = excluded.price,
    location_name = excluded.location_name,
    pickup_available_from = excluded.pickup_available_from,
    pickup_available_to = excluded.pickup_available_to,
    shop_id = excluded.shop_id,
    description = excluded.description,
    category = excluded.category,
    content_amount = excluded.content_amount,
    storage_method = excluded.storage_method,
    source_url = excluded.source_url,
    price_note = excluded.price_note,
    is_active = excluded.is_active;

-- stock is intentionally omitted from DO UPDATE: re-running the canonical
-- schema after reservations must not restore already-consumed inventory.

insert into public.items (id, title, type, price, stock, location_name, is_active)
values
    (
        '11111111-1111-4111-8111-111111111111',
        '間伐材の薪（未加工）',
        'pickup',
        800,
        12,
        '道の駅 ロック・ガーデンひちそう',
        false
    ),
    (
        '22222222-2222-4222-8222-222222222222',
        'ジビエ鹿肉レトルトカレー',
        'pickup',
        950,
        20,
        '道の駅 ロック・ガーデンひちそう',
        false
    ),
    (
        '33333333-3333-4333-8333-333333333333',
        'ハンターと行くジビエ解体ワークショップ',
        'experience',
        3500,
        8,
        '七宗町地域交流スペース',
        false
    )
on conflict (id) do update
set is_active = false;

-- Pickup locations are unattended lockers: pickup is available 24 hours a
-- day. pickup_available_from/to are deprecated and always null
-- (supabase/migrations/20260927090000_pickup_24h_lockers.sql).
update public.items
set pickup_available_from = null,
    pickup_available_to = null
where pickup_available_from is not null
   or pickup_available_to is not null;

comment on column public.items.pickup_available_from is
    'Deprecated: pickup is available 24h (unattended lockers). Always null; not used.';
comment on column public.items.pickup_available_to is
    'Deprecated: pickup is available 24h (unattended lockers). Always null; not used.';
