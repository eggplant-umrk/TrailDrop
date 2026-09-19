-- TrailDrop: Supabase (PostgreSQL) 初期スキーマ

create table if not exists pickup_points (
    id bigserial primary key,
    name text not null,
    location text not null,        -- 国道41号線沿いの拠点名など
    created_at timestamptz not null default now()
);

create table if not exists pickup_reservations (
    id bigserial primary key,
    resource_type text not null check (resource_type in ('firewood', 'gibier')),
    quantity integer not null check (quantity > 0),
    pickup_point_id bigint not null references pickup_points(id),
    scheduled_at timestamptz not null,
    user_name text not null,
    created_at timestamptz not null default now()
);

create table if not exists workshops (
    id bigserial primary key,
    name text not null,
    description text,
    capacity integer not null default 10,
    created_at timestamptz not null default now()
);

create table if not exists workshop_reservations (
    id bigserial primary key,
    workshop_id bigint not null references workshops(id),
    scheduled_at timestamptz not null,
    participants integer not null check (participants > 0),
    user_name text not null,
    created_at timestamptz not null default now()
);
