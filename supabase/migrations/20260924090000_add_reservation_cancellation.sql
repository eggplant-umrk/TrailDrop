-- Adds a 'cancelled' reservation status plus an atomic
-- cancel-and-return-stock RPC.
--
-- Allowed transitions enforced by cancel_reservation_with_stock():
--   pending   -> cancelled  (allowed; returns 1 unit of stock)
--   completed -> cancelled  (rejected: RESERVATION_NOT_CANCELLABLE)
--   cancelled -> cancelled  (rejected: RESERVATION_NOT_CANCELLABLE)
--
-- The status check constraint on public.reservations was originally
-- declared inline (unnamed) inside the CREATE TABLE in
-- 20260920180000_initial_schema.sql, so Postgres assigned it the default
-- name "reservations_status_check". Drop and recreate it here to widen the
-- allowed values; this migration is safe to re-run.

alter table public.reservations
    drop constraint if exists reservations_status_check;

do $$
begin
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
end
$$;

-- Cancels a pending reservation and returns one unit of stock to its item,
-- as a single atomic operation.
--
-- Concurrency / double-cancel safety: the initial SELECT ... FOR UPDATE
-- takes a row lock on the target reservation. If two cancel requests for
-- the same reservation run concurrently, the second one blocks on that
-- lock until the first transaction commits (or rolls back); once
-- unblocked, it re-reads the now-committed status, sees it is no longer
-- 'pending', and raises RESERVATION_NOT_CANCELLABLE instead of returning
-- stock a second time. There is no window in which two concurrent calls
-- can both observe 'pending' and both increment stock.
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
    -- id and access_token are checked together (like GET /reservations/{id})
    -- so an invalid token cannot be used to probe whether an id exists.
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

    update public.reservations
    set status = 'cancelled'
    where id = p_reservation_id
      and access_token = p_access_token
      and status = 'pending'
    returning * into cancelled_reservation;

    if not found then
        -- Guards against the status changing between the lock above and
        -- this update; should not be reachable given the row lock, but
        -- fail closed (no stock change) rather than assume success.
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
