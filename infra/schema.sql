-- TrailDrop Supabase schema for the hackathon MVP.

create extension if not exists pgcrypto;

create table if not exists items (
    id uuid primary key default gen_random_uuid(),
    title varchar not null,
    type varchar not null check (type in ('pickup', 'experience')),
    price integer not null,
    stock integer not null,
    location_name varchar not null,
    created_at timestamptz default now()
);

create table if not exists reservations (
    id uuid primary key default gen_random_uuid(),
    item_id uuid not null references items(id),
    user_name varchar not null,
    qr_token uuid unique default gen_random_uuid(),
    status varchar default 'pending' check (status in ('pending', 'completed')),
    reserved_at timestamptz default now()
);

insert into items (id, title, type, price, stock, location_name)
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
