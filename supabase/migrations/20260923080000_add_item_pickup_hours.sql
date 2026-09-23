-- Adds a daily recurring pickup-availability window to items.
--
-- Both columns are nullable: null on either means "no pickup window recorded
-- for this item". The Backend/Frontend treat that as "not shown" for the
-- route-based time-window feature, not "always available" -- there is no
-- implicit default here.
--
-- Overnight windows (e.g. 22:00-02:00) and day-of-week variation are out of
-- scope; pickup_available_from must be strictly before pickup_available_to
-- when both are set.

alter table public.items
    add column if not exists pickup_available_from time,
    add column if not exists pickup_available_to time;

do $$
begin
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
end
$$;

-- Example pickup hours for the seeded pickup items, so the route-based time
-- window filter has something meaningful to include/exclude locally. The
-- experience item is intentionally left without a window.
update public.items
set pickup_available_from = '09:00',
    pickup_available_to = '18:00'
where id in (
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222'
);
