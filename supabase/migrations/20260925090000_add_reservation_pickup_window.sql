-- Adds an optional pickup time window (start/end) to reservations, selected
-- by the customer in RouteTest.jsx before reserving (RouteTest computes a
-- 2-hour window around the route's pass-by time; see WINDOW_DURATION_MINUTES
-- in frontend/src/pages/RouteTest.jsx). Both columns are nullable and
-- independent of requested_at, which remains the existing single exact-time
-- field used only by experience-type items -- pickup_window_start/end can be
-- set for either item type (pickup or experience), or left null entirely for
-- reservations made without going through RouteTest. Existing reservations
-- are unaffected: both columns default to NULL and no existing column,
-- constraint, or RPC caller signature is removed.

alter table public.reservations
    add column if not exists pickup_window_start timestamptz,
    add column if not exists pickup_window_end timestamptz;

-- Same shape as items_pickup_window_consistent (infra/schema.sql): both
-- columns must be null together, or both set with start strictly before
-- end. This is defense in depth -- the Backend (models.py) validates the
-- same rule before ever calling this RPC -- for any caller that hits the
-- RPC directly.
do $$
begin
    if not exists (
        select 1
        from pg_constraint
        where conname = 'reservations_pickup_window_consistent'
          and conrelid = 'public.reservations'::regclass
    ) then
        alter table public.reservations
            add constraint reservations_pickup_window_consistent
            check (
                (pickup_window_start is null) = (pickup_window_end is null)
                and (pickup_window_start is null or pickup_window_start < pickup_window_end)
            );
    end if;
end
$$;

drop function if exists public.create_reservation_with_stock(uuid, varchar, timestamptz, varchar);

create function public.create_reservation_with_stock(
    p_item_id uuid,
    p_user_name varchar,
    p_requested_at timestamptz default null,
    p_payment_method varchar default null,
    p_pickup_window_start timestamptz default null,
    p_pickup_window_end timestamptz default null
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
    -- ことはない。pickup_window_start/endはpickup/experienceどちらの種別
    -- でも(RouteTest経由の予約であれば)そのまま保存する。start<endおよび
    -- 「片方のみ指定」の拒否はBackend(models.py)で検証済みだが、上の
    -- reservations_pickup_window_consistent制約でもDB側で二重に保護する。
    insert into public.reservations (
        item_id, user_name, requested_at, payment_method, payment_status,
        pickup_window_start, pickup_window_end
    )
    values (
        p_item_id,
        p_user_name,
        case when item_type = 'experience' then p_requested_at else null end,
        p_payment_method,
        'paid',
        p_pickup_window_start,
        p_pickup_window_end
    )
    returning * into created_reservation;

    return next created_reservation;
end;
$$;

revoke all on function public.create_reservation_with_stock(uuid, varchar, timestamptz, varchar, timestamptz, timestamptz)
from public, anon, authenticated;
grant execute on function public.create_reservation_with_stock(uuid, varchar, timestamptz, varchar, timestamptz, timestamptz)
to service_role;
