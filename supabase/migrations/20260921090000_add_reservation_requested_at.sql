alter table public.reservations
    add column if not exists requested_at timestamptz;

drop function if exists public.create_reservation_with_stock(uuid, varchar);

create function public.create_reservation_with_stock(
    p_item_id uuid,
    p_user_name varchar,
    p_requested_at timestamptz default null
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

    insert into public.reservations (item_id, user_name, requested_at)
    values (
        p_item_id,
        p_user_name,
        case when item_type = 'experience' then p_requested_at else null end
    )
    returning * into created_reservation;

    return next created_reservation;
end;
$$;

revoke all on function public.create_reservation_with_stock(uuid, varchar, timestamptz)
from public, anon, authenticated;
grant execute on function public.create_reservation_with_stock(uuid, varchar, timestamptz)
to service_role;
