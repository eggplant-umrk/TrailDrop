-- Run expire_stale_pending_reservations() every 10 minutes inside the
-- database with pg_cron (bundled with Supabase), so stale pending
-- reservations release their stock without an external scheduler. The
-- Backend on Render's free plan sleeps when idle, so a Backend-side timer
-- would not run reliably; pg_cron runs regardless.
--
-- The function itself is unchanged and safe to run repeatedly: each
-- reservation is moved pending -> cancelled under a row lock before its
-- stock is returned, so it can't be returned twice (see
-- 20260925100000_expire_stale_pending_reservations.sql).
--
-- cron.schedule() with an existing job name updates that job, so running
-- this again does not create duplicate jobs. On a Postgres without pg_cron
-- (not Supabase), the schedule is skipped with a warning and the README
-- runbook (POST /staff/reservations/expire-stale) still applies.
do $$
begin
    if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
        create extension if not exists pg_cron with schema pg_catalog;
        perform cron.schedule(
            'expire-stale-pending-reservations',
            '*/10 * * * *',
            'select public.expire_stale_pending_reservations()'
        );
    else
        raise warning 'pg_cron is not available; expire_stale_pending_reservations() is not scheduled';
    end if;
end;
$$;
