-- Adds a mock payment method + payment status to reservations, for the
-- "予約時の支払いモック" feature. No real payment gateway is involved: the
-- Backend validates payment_method itself and this RPC records the
-- reservation as immediately paid, atomically with stock decrement.
--
-- payment_status is intentionally a separate concern from
-- reservations.status (pending/completed/cancelled, unchanged): the latter
-- tracks pickup/handoff, this tracks the (mock) payment. They are not
-- coupled by any constraint here, and cancel_reservation_with_stock() is
-- left untouched -- cancelling a reservation does not change its
-- payment_status in this iteration (out of scope; see the PR description).
--
-- Backward compatibility: both columns are added to the existing table.
-- payment_method is nullable (existing reservations predate this feature
-- and have no known payment method -- NULL, not a guess). payment_status
-- defaults to 'pending' for existing rows for the same reason: their real
-- payment status is unknown, and 'pending' is the neutral default rather
-- than falsely claiming 'paid'. New reservations created through
-- create_reservation_with_stock() always get payment_status = 'paid',
-- since the mock payment step always "succeeds" synchronously.

alter table public.reservations
    add column if not exists payment_method varchar,
    add column if not exists payment_status varchar not null default 'pending';

do $$
begin
    if not exists (
        select 1
        from pg_constraint
        where conname = 'reservations_payment_method_check'
          and conrelid = 'public.reservations'::regclass
    ) then
        alter table public.reservations
            add constraint reservations_payment_method_check
            check (payment_method is null or payment_method in ('paypay', 'credit_card'));
    end if;

    if not exists (
        select 1
        from pg_constraint
        where conname = 'reservations_payment_status_check'
          and conrelid = 'public.reservations'::regclass
    ) then
        alter table public.reservations
            add constraint reservations_payment_status_check
            check (payment_status in ('pending', 'paid', 'cancelled'));
    end if;
end
$$;

drop function if exists public.create_reservation_with_stock(uuid, varchar, timestamptz);

create function public.create_reservation_with_stock(
    p_item_id uuid,
    p_user_name varchar,
    p_requested_at timestamptz default null,
    p_payment_method varchar default null
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
    -- Backendのcreate_reservation()が先にVALID_PAYMENT_METHODSで検証して
    -- いるため、通常この分岐に到達することはない。RPCを直接呼ぶ経路が
    -- 増えた場合に備えた保険(defense in depth)であり、requested_atの
    -- REQUESTED_AT_IN_PASTチェックと同じ考え方。
    if p_payment_method is null or p_payment_method not in ('paypay', 'credit_card') then
        raise exception 'INVALID_PAYMENT_METHOD' using errcode = '22023';
    end if;

    update public.items
    set stock = stock - 1
    where id = p_item_id
      and stock > 0
    returning type into item_type;

    if not found then
        if exists (select 1 from public.items where id = p_item_id) then
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

    -- モック決済: 外部ゲートウェイを呼ばず、在庫確保と同じトランザクション
    -- 内でpayment_status='paid'として即時確定する。ここに到達した時点で
    -- 上記のバリデーションは全て通っているため、'pending'のまま行が残る
    -- ことはない。
    insert into public.reservations (item_id, user_name, requested_at, payment_method, payment_status)
    values (
        p_item_id,
        p_user_name,
        case when item_type = 'experience' then p_requested_at else null end,
        p_payment_method,
        'paid'
    )
    returning * into created_reservation;

    return next created_reservation;
end;
$$;

revoke all on function public.create_reservation_with_stock(uuid, varchar, timestamptz, varchar)
from public, anon, authenticated;
grant execute on function public.create_reservation_with_stock(uuid, varchar, timestamptz, varchar)
to service_role;
