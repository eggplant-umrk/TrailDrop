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

create table if not exists public.reservations (
    id uuid primary key default gen_random_uuid(),
    item_id uuid not null references public.items(id),
    user_name varchar not null,
    qr_token uuid not null unique default gen_random_uuid(),
    access_token uuid not null unique default gen_random_uuid(),
    status varchar not null default 'pending' check (status in ('pending', 'completed')),
    requested_at timestamptz,
    reserved_at timestamptz default now()
);

alter table public.reservations
    add column if not exists requested_at timestamptz;

-- Apply the tightened constraints when this script runs against an existing project.
update public.reservations
set qr_token = gen_random_uuid()
where qr_token is null;

update public.reservations
set status = 'pending'
where status is null;

alter table public.reservations alter column qr_token set not null;
alter table public.reservations alter column status set not null;

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

create or replace function public.create_reservation_with_stock(
    p_item_id uuid,
    p_user_name varchar,
    p_requested_at timestamptz default null
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

    insert into public.reservations (item_id, user_name, requested_at)
    values (
        p_item_id,
        p_user_name,
        case when item_type = 'experience' then p_requested_at else null end
    )
    returning * into created_reservation;

    return next created_reservation;
end;
$$;

revoke all on function public.create_reservation_with_stock(uuid, varchar, timestamptz)
from public, anon, authenticated;
grant execute on function public.create_reservation_with_stock(uuid, varchar, timestamptz)
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
