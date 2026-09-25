-- Pickup locations (lockers / 受取地点) with coordinates, used by the
-- Backend's route-based pickup selection (PICKUP_SELECTION_MODE=route in
-- backend/main.py): the Backend computes the user's actual route once and
-- picks the active locations within PICKUP_MAX_DISTANCE_METERS of it.
--
-- items is intentionally left unchanged: products stay linked to a pickup
-- location by name (items.location_name = pickup_locations.name), exactly
-- as RouteTest.jsx already filters items by the analysed pass_point.
--
-- No seed rows here on purpose: real coordinates must be confirmed on site
-- before they are inserted (e.g. 道の駅 ロック・ガーデンひちそう). Until then
-- the default PICKUP_SELECTION_MODE=fixed keeps the previous behaviour and
-- does not read this table at all.
--
-- Access: RLS is enabled with no policies, and anon/authenticated have no
-- privileges, so only the Backend's service_role can read the table (same
-- model as public.reservations).
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
