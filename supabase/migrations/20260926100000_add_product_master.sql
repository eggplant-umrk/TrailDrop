-- Product-master metadata for the five TrailDrop demo products.
--
-- A shop is the product provider, while items.location_name remains the
-- pickup location. Keeping these concepts separate allows products from
-- several providers to be collected at the same TrailDrop pickup point.

create table if not exists public.shops (
    id uuid primary key default gen_random_uuid(),
    name varchar not null constraint shops_name_key unique,
    description text,
    website_url text,
    created_at timestamptz default now()
);

-- Keep this migration safe if a shops table was created manually before the
-- repository-managed migration is applied.
alter table public.shops
    add column if not exists description text,
    add column if not exists website_url text;

alter table public.items
    add column if not exists shop_id uuid,
    add column if not exists description text,
    add column if not exists category varchar,
    add column if not exists content_amount varchar,
    add column if not exists storage_method text,
    add column if not exists source_url text,
    add column if not exists price_note text,
    add column if not exists is_active boolean not null default true;

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
end
$$;

alter table public.shops enable row level security;

drop policy if exists items_public_read on public.items;
create policy items_public_read
on public.items
for select
to anon, authenticated
using (is_active = true);

drop policy if exists shops_public_read on public.shops;
create policy shops_public_read
on public.shops
for select
to anon, authenticated
using (true);

grant select on table public.shops to anon, authenticated;
revoke insert, update, delete on table public.shops from anon, authenticated;
grant select, insert, update on table public.shops to service_role;

-- Register providers first. Products resolve shop_id by this exact unique
-- name, so the product insert cannot be silently skipped because a provider
-- row was missing. ON CONFLICT also makes SQL Editor re-runs safe.
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
            '鮎の甘露煮の燻製 100gパック',
            540, 12,
            '鮎の甘露煮を燻製にした、七宗食品の川魚のお土産。',
            '川魚・燻製', '100g',
            '常温。直射日光・高温多湿を避け、冷暗所で保存。',
            'https://hida-seiryu.com/product/kunsei/kb0220010/',
            '七宗食品「こぶしの里」'
        ),
        (
            'a2222222-2222-4222-8222-222222222222'::uuid,
            '若鶏の皮肝けいちゃん 200g×2袋',
            900, 8,
            '岐阜県産若鶏の皮・砂肝・心臓などを米麹味噌で味付け。',
            'けいちゃん', '200g×2袋',
            '冷凍。受取までの保冷方法を確認。',
            'https://www.furusato-tax.jp/product/detail/21504/7117947',
            '炭火焼肉たつみや'
        ),
        (
            'a3333333-3333-4333-8333-333333333333'::uuid,
            '東濃ひのき薪 20kg×1箱 皮つき',
            2800, 2,
            '七宗町の森林資源を活用した、自然乾燥の東濃ヒノキ薪。',
            '森林・薪', '20kg×1箱',
            '常温。天然材料のため虫・カビに注意。',
            'https://www.furusato-tax.jp/product/detail/21504/7211223',
            '福薪'
        ),
        (
            'a4444444-4444-4444-8444-444444444444'::uuid,
            '出来立てくんたま（3個入×5袋）通常パック',
            1500, 10,
            '岐阜県産の鶏卵を鮎だしで味付けした、こぶしの里の燻製卵。',
            '燻製卵', '3個入×5袋',
            '要冷蔵。賞味期限は製造日を含め5日。',
            'https://hida-seiryu.com/product/kunsei/kb0220033/',
            '七宗食品「こぶしの里」'
        ),
        (
            'a5555555-5555-4555-8555-555555555555'::uuid,
            '菊泉本舗 特選 お茶せんべい 26枚入り',
            700, 12,
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
    candidate.id,
    candidate.title,
    'pickup',
    candidate.price,
    candidate.initial_stock,
    '道の駅 ロック・ガーデンひちそう',
    '07:00'::time,
    '21:00'::time,
    shops.id,
    candidate.description,
    candidate.category,
    candidate.content_amount,
    candidate.storage_method,
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

-- Deliberately do not overwrite stock in the conflict branch. The supplied
-- demo stock is used for the initial insert, while re-running this SQL after
-- reservations have been made must not restore already-consumed inventory.

-- Preserve rows referenced by existing reservations, but remove the three
-- original placeholder products from every active-product API path. UUIDs
-- are used so a later title correction cannot accidentally leave one active.
update public.items
set is_active = false
where id in (
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333'
);

-- Keep the established six-argument API exactly as-is. The UPDATE remains
-- the atomic stock claim; adding is_active here prevents a direct UUID call
-- from reserving a hidden product. Inactive and absent IDs intentionally
-- share ITEM_NOT_FOUND so product visibility is not disclosed.
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
