-- Pending reservations whose pickup_window_end has passed keep their stock
-- reserved forever unless someone explicitly cancels them. This adds an RPC
-- that a staff-authenticated Backend endpoint (POST /staff/reservations/
-- expire-stale) can call on demand to release stock back for such
-- reservations, since this repository has no cron/scheduler infrastructure
-- to run this automatically.
--
-- Grace period: a reservation is only expired once 30 minutes have passed
-- since its pickup_window_end (pickup_window_end + interval '30 minutes' <
-- now()), so a customer who arrives slightly late (traffic etc.) can still
-- pick up. Expiry reuses status = 'cancelled' (same as a customer cancel);
-- there is intentionally no separate "expired" status in the MVP.
--
-- Production must run this periodically (cron etc., e.g. every 10 minutes);
-- see "期限切れ予約の自動キャンセル" in the repository README for the
-- runbook. This repository itself contains no scheduler.
--
-- Only reservations that actually recorded a pickup_window_end are eligible:
-- reservations made without going through RouteTest (pickup_window_end is
-- null) have no basis for expiry and are left untouched, exactly like
-- cancel_reservation_with_stock leaves non-pending reservations untouched.
--
-- Safety: the inner SELECT ... FOR UPDATE locks the matching rows before the
-- outer UPDATE writes to them, the same row-locking concurrency-safety
-- pattern already used by cancel_reservation_with_stock's final UPDATE (a
-- reservation already cancelled or completed by a concurrent request
-- (customer cancel, staff QR verify) is either not selected in the first
-- place, or this transaction blocks on FOR UPDATE until the concurrent one
-- commits and then re-reads its now-changed status via the outer UPDATE's
-- own WHERE, so it is never double-processed and stock is never
-- double-returned).
--
-- PM review m-2: process at most batch_size rows per call instead of an
-- unbounded UPDATE, so a large backlog of stale reservations can't hold one
-- transaction (and its row locks) open indefinitely. This is a fixed
-- constant, not a parameter, to keep the endpoint's contract simple for the
-- MVP; the staff endpoint can just be called again to process the next
-- batch.
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
