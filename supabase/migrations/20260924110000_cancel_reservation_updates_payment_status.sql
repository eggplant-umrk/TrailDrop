-- Extends cancel_reservation_with_stock() (added in
-- 20260924090000_add_reservation_cancellation.sql) so that cancelling a
-- reservation whose mock payment already succeeded (payment_status =
-- 'paid') also marks that payment 'cancelled', in the same UPDATE
-- statement that flips reservations.status to 'cancelled' -- no separate
-- call, no separate transaction, so cancellation and the payment_status
-- change either both happen or neither does.
--
-- A reservation whose payment_status is still 'pending' (e.g. rows created
-- before 20260924100000_add_reservation_payment.sql, which predate the
-- payment feature and default to 'pending') is left at 'pending': there is
-- no successful mock payment to cancel for it.
--
-- Everything else about the function -- the SELECT ... FOR UPDATE row lock
-- that makes double-cancel safe (see the original migration's comment),
-- the pending-only transition, the atomic stock return -- is unchanged.
-- The signature is unchanged too, so this is CREATE OR REPLACE, not a
-- drop+recreate; existing grants on the function are preserved.
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
