-- Idempotency key for POST /reservations.
--
-- The Frontend generates one random UUID per reservation operation and
-- sends it with every attempt of that operation. If a request timed out
-- after the reservation was actually created, resending with the same key
-- returns the already-created reservation instead of taking a second unit
-- of stock.
--
-- The column is nullable: existing reservations, and requests from clients
-- that don't send a key, keep working exactly as before (a unique index
-- treats NULLs as distinct).
alter table public.reservations
    add column if not exists idempotency_key uuid;

create unique index if not exists reservations_idempotency_key_key
    on public.reservations (idempotency_key);

-- Adding a parameter changes the function signature, so drop the previous
-- one explicitly instead of leaving an overload behind. The new parameter
-- has a default, so callers that don't pass p_idempotency_key (a Backend
-- deployed before this migration) resolve to the new function unchanged.
drop function if exists public.create_reservation_with_stock(uuid, varchar, timestamptz, varchar, timestamptz, timestamptz);

-- Same contract as before, plus p_idempotency_key:
-- - A reservation with the same key already exists: return it as-is (no
--   stock change, no new row). Reusing a key for a different item is
--   rejected (IDEMPOTENCY_KEY_REUSED), since it can't be the same operation.
-- - Two concurrent requests with the same key: the loser's insert hits the
--   unique index, its stock decrement is rolled back with the inner block,
--   and it returns the winner's reservation.
create or replace function public.create_reservation_with_stock(
    p_item_id uuid,
    p_user_name varchar,
    p_requested_at timestamptz default null,
    p_payment_method varchar default null,
    p_pickup_window_start timestamptz default null,
    p_pickup_window_end timestamptz default null,
    p_idempotency_key uuid default null
)
returns setof public.reservations
language plpgsql
security invoker
set search_path = ''
as $$
declare
    created_reservation public.reservations;
    existing_reservation public.reservations;
    item_type varchar;
begin
    if p_payment_method is null or p_payment_method not in ('paypay', 'credit_card') then
        raise exception 'INVALID_PAYMENT_METHOD' using errcode = '22023';
    end if;

    if p_idempotency_key is not null then
        select * into existing_reservation
        from public.reservations
        where idempotency_key = p_idempotency_key;

        if found then
            if existing_reservation.item_id <> p_item_id then
                raise exception 'IDEMPOTENCY_KEY_REUSED' using errcode = '22023';
            end if;
            return next existing_reservation;
            return;
        end if;
    end if;

    begin
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
            pickup_window_start, pickup_window_end, idempotency_key
        )
        values (
            p_item_id,
            p_user_name,
            case when item_type = 'experience' then p_requested_at else null end,
            p_payment_method,
            'paid',
            p_pickup_window_start,
            p_pickup_window_end,
            p_idempotency_key
        )
        returning * into created_reservation;
    exception
        when unique_violation then
            if p_idempotency_key is null then
                raise;
            end if;
            select * into existing_reservation
            from public.reservations
            where idempotency_key = p_idempotency_key;
            if not found then
                raise;
            end if;
            if existing_reservation.item_id <> p_item_id then
                raise exception 'IDEMPOTENCY_KEY_REUSED' using errcode = '22023';
            end if;
            return next existing_reservation;
            return;
    end;

    return next created_reservation;
end;
$$;

revoke all on function public.create_reservation_with_stock(uuid, varchar, timestamptz, varchar, timestamptz, timestamptz, uuid)
from public, anon, authenticated;
grant execute on function public.create_reservation_with_stock(uuid, varchar, timestamptz, varchar, timestamptz, timestamptz, uuid)
to service_role;
