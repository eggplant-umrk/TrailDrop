-- Pickup locations are unattended lockers, so items can be picked up 24 hours
-- a day. The per-item "business hours" (pickup_available_from/to, e.g.
-- 07:00-21:00) no longer restrict anything.
--
-- The Frontend no longer reads these columns and the reservation RPC never
-- checked them. The columns are kept (nullable, always null) only so that the
-- current Backend select lists and response models keep working without a
-- coordinated deploy; they can be dropped in a later cleanup.

update public.items
set pickup_available_from = null,
    pickup_available_to = null
where pickup_available_from is not null
   or pickup_available_to is not null;

comment on column public.items.pickup_available_from is
    'Deprecated: pickup is available 24h (unattended lockers). Always null; not used.';
comment on column public.items.pickup_available_to is
    'Deprecated: pickup is available 24h (unattended lockers). Always null; not used.';
