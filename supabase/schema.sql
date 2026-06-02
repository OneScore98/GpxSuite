-- GPXSuite Auth/Admin schema per Supabase
-- Eseguire nel SQL editor di Supabase dopo aver creato il progetto.
--
-- Bootstrap admin:
-- 1. Crea il tuo utente in Authentication > Users.
-- 2. Copia il suo UUID e inserisci un profilo admin:
--    insert into public.gpxsuite_profiles (id, username, email, role)
--    values ('UUID_UTENTE_AUTH', 'admin', 'tua-email@example.com', 'admin');

create extension if not exists pgcrypto;
create extension if not exists citext;

create table if not exists public.gpxsuite_profiles (
    id uuid primary key references auth.users(id) on delete cascade,
    username citext not null unique,
    email text not null unique,
    display_name text,
    role text not null default 'user' check (role in ('user', 'admin')),
    status text not null default 'active' check (status in ('active', 'suspended')),
    device_lock_enabled boolean not null default true,
    max_devices integer not null default 1 check (max_devices between 1 and 20),
    created_by uuid references auth.users(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    last_login_at timestamptz,
    constraint gpxsuite_username_format check (username ~* '^[a-z0-9_.-]{3,32}$')
);

create table if not exists public.gpxsuite_user_devices (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    device_hash text not null,
    label text not null default 'Dispositivo',
    user_agent text,
    status text not null default 'pending' check (status in ('approved', 'pending', 'rejected', 'revoked')),
    first_seen_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    approved_at timestamptz,
    approved_by uuid references auth.users(id) on delete set null,
    rejected_at timestamptz,
    rejected_by uuid references auth.users(id) on delete set null,
    unique (user_id, device_hash)
);

create index if not exists gpxsuite_user_devices_user_status_idx
    on public.gpxsuite_user_devices (user_id, status);

create table if not exists public.gpxsuite_analytics_events (
    id bigint primary key generated always as identity,
    user_id uuid references auth.users(id) on delete set null,
    device_id uuid references public.gpxsuite_user_devices(id) on delete set null,
    event_name text not null,
    event_meta jsonb not null default '{}'::jsonb,
    user_agent text,
    created_at timestamptz not null default now()
);

create index if not exists gpxsuite_analytics_user_created_idx
    on public.gpxsuite_analytics_events (user_id, created_at desc);

create index if not exists gpxsuite_analytics_event_created_idx
    on public.gpxsuite_analytics_events (event_name, created_at desc);

alter table public.gpxsuite_profiles enable row level security;
alter table public.gpxsuite_user_devices enable row level security;
alter table public.gpxsuite_analytics_events enable row level security;

create or replace function public.gpxsuite_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (
        select 1
        from public.gpxsuite_profiles p
        where p.id = auth.uid()
          and p.role = 'admin'
          and p.status = 'active'
    );
$$;

drop policy if exists "gpxsuite_profiles_select_self_or_admin" on public.gpxsuite_profiles;
create policy "gpxsuite_profiles_select_self_or_admin"
on public.gpxsuite_profiles
for select
to authenticated
using (
    id = auth.uid()
    or public.gpxsuite_is_admin()
);

drop policy if exists "gpxsuite_devices_select_self_or_admin" on public.gpxsuite_user_devices;
create policy "gpxsuite_devices_select_self_or_admin"
on public.gpxsuite_user_devices
for select
to authenticated
using (
    user_id = auth.uid()
    or public.gpxsuite_is_admin()
);

drop policy if exists "gpxsuite_events_select_admin" on public.gpxsuite_analytics_events;
create policy "gpxsuite_events_select_admin"
on public.gpxsuite_analytics_events
for select
to authenticated
using (
    public.gpxsuite_is_admin()
);

create or replace function public.gpxsuite_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists gpxsuite_profiles_updated_at on public.gpxsuite_profiles;
create trigger gpxsuite_profiles_updated_at
before update on public.gpxsuite_profiles
for each row execute function public.gpxsuite_touch_updated_at();

create or replace function public.gpxsuite_resolve_login_identifier(p_identifier text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_email text;
    v_identifier text := lower(trim(coalesce(p_identifier, '')));
begin
    if v_identifier = '' then
        return null;
    end if;

    select p.email
    into v_email
    from public.gpxsuite_profiles p
    where p.status = 'active'
      and (lower(p.email) = v_identifier or lower(p.username::text) = v_identifier)
    limit 1;

    if v_email is null then
        return null;
    end if;

    return jsonb_build_object('email', v_email);
end;
$$;

create or replace function public.gpxsuite_private_log_event(
    p_user_id uuid,
    p_device_id uuid,
    p_event_name text,
    p_event_meta jsonb default '{}'::jsonb,
    p_user_agent text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    insert into public.gpxsuite_analytics_events (
        user_id,
        device_id,
        event_name,
        event_meta,
        user_agent
    )
    values (
        p_user_id,
        p_device_id,
        left(coalesce(p_event_name, 'evento'), 80),
        coalesce(p_event_meta, '{}'::jsonb),
        left(coalesce(p_user_agent, ''), 500)
    );
end;
$$;

create or replace function public.gpxsuite_complete_login(
    p_device_key text,
    p_device_label text default 'Dispositivo',
    p_user_agent text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
    v_user_id uuid := auth.uid();
    v_profile public.gpxsuite_profiles%rowtype;
    v_device_hash text;
    v_device public.gpxsuite_user_devices%rowtype;
    v_approved_count integer;
    v_allowed boolean := false;
    v_status text := 'pending';
begin
    if v_user_id is null then
        raise exception 'not authenticated';
    end if;

    select *
    into v_profile
    from public.gpxsuite_profiles
    where id = v_user_id;

    if not found then
        perform public.gpxsuite_private_log_event(v_user_id, null, 'login_denied', '{"reason":"profile_missing"}'::jsonb, p_user_agent);
        return jsonb_build_object('allowed', false, 'status', 'profile_missing');
    end if;

    if v_profile.status <> 'active' then
        perform public.gpxsuite_private_log_event(v_user_id, null, 'login_denied', '{"reason":"suspended"}'::jsonb, p_user_agent);
        return jsonb_build_object(
            'allowed', false,
            'status', 'suspended',
            'profile', jsonb_build_object('id', v_profile.id, 'username', v_profile.username, 'email', v_profile.email, 'role', v_profile.role)
        );
    end if;

    v_device_hash := encode(digest(coalesce(p_device_key, ''), 'sha256'), 'hex');
    if coalesce(p_device_key, '') = '' then
        perform public.gpxsuite_private_log_event(v_user_id, null, 'login_denied', '{"reason":"missing_device_key"}'::jsonb, p_user_agent);
        return jsonb_build_object('allowed', false, 'status', 'device_missing');
    end if;

    select *
    into v_device
    from public.gpxsuite_user_devices
    where user_id = v_user_id
      and device_hash = v_device_hash;

    if not found then
        select count(*)
        into v_approved_count
        from public.gpxsuite_user_devices
        where user_id = v_user_id
          and status = 'approved';

        insert into public.gpxsuite_user_devices (
            user_id,
            device_hash,
            label,
            user_agent,
            status,
            approved_at,
            approved_by
        )
        values (
            v_user_id,
            v_device_hash,
            left(coalesce(nullif(trim(p_device_label), ''), 'Dispositivo'), 120),
            left(coalesce(p_user_agent, ''), 500),
            case when v_approved_count = 0 then 'approved' else 'pending' end,
            case when v_approved_count = 0 then now() else null end,
            case when v_approved_count = 0 then v_user_id else null end
        )
        returning * into v_device;
    else
        update public.gpxsuite_user_devices
        set last_seen_at = now(),
            label = left(coalesce(nullif(trim(p_device_label), ''), label), 120),
            user_agent = left(coalesce(p_user_agent, user_agent, ''), 500)
        where id = v_device.id
        returning * into v_device;
    end if;

    if v_profile.device_lock_enabled = false then
        v_allowed := true;
        v_status := 'lock_disabled';
    elsif v_device.status = 'approved' then
        v_allowed := true;
        v_status := 'approved';
    else
        v_allowed := false;
        v_status := v_device.status;
    end if;

    if v_allowed then
        update public.gpxsuite_profiles
        set last_login_at = now()
        where id = v_user_id
        returning * into v_profile;
        perform public.gpxsuite_private_log_event(v_user_id, v_device.id, 'login_success', jsonb_build_object('deviceStatus', v_device.status), p_user_agent);
    else
        perform public.gpxsuite_private_log_event(v_user_id, v_device.id, 'login_denied', jsonb_build_object('deviceStatus', v_device.status), p_user_agent);
    end if;

    return jsonb_build_object(
        'allowed', v_allowed,
        'status', v_status,
        'profile', jsonb_build_object(
            'id', v_profile.id,
            'username', v_profile.username,
            'email', v_profile.email,
            'displayName', v_profile.display_name,
            'role', v_profile.role,
            'status', v_profile.status,
            'deviceLockEnabled', v_profile.device_lock_enabled,
            'maxDevices', v_profile.max_devices
        ),
        'device', jsonb_build_object(
            'id', v_device.id,
            'label', v_device.label,
            'status', v_device.status,
            'firstSeenAt', v_device.first_seen_at,
            'lastSeenAt', v_device.last_seen_at
        )
    );
end;
$$;

create or replace function public.gpxsuite_log_event(
    p_event_name text,
    p_event_meta jsonb default '{}'::jsonb,
    p_device_key text default null
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
    v_user_id uuid := auth.uid();
    v_device_id uuid;
    v_device_hash text;
begin
    if v_user_id is null then
        return;
    end if;

    if coalesce(p_device_key, '') <> '' then
        v_device_hash := encode(digest(p_device_key, 'sha256'), 'hex');
        select id
        into v_device_id
        from public.gpxsuite_user_devices
        where user_id = v_user_id
          and device_hash = v_device_hash
        limit 1;
    end if;

    perform public.gpxsuite_private_log_event(v_user_id, v_device_id, p_event_name, p_event_meta, null);
end;
$$;

create or replace function public.gpxsuite_admin_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
    if not public.gpxsuite_is_admin() then
        raise exception 'not authorized';
    end if;

    return jsonb_build_object(
        'users_total', (select count(*) from public.gpxsuite_profiles),
        'active_users', (select count(*) from public.gpxsuite_profiles where status = 'active'),
        'logins_24h', (
            select count(*) from public.gpxsuite_analytics_events
            where event_name = 'login_success' and created_at >= now() - interval '24 hours'
        ),
        'requests_24h', (
            select count(*) from public.gpxsuite_analytics_events
            where created_at >= now() - interval '24 hours'
        ),
        'pending_devices', (select count(*) from public.gpxsuite_user_devices where status = 'pending'),
        'devices_total', (select count(*) from public.gpxsuite_user_devices)
    );
end;
$$;

create or replace function public.gpxsuite_admin_list_users()
returns table (
    id uuid,
    username citext,
    email text,
    display_name text,
    role text,
    status text,
    device_lock_enabled boolean,
    max_devices integer,
    approved_devices bigint,
    pending_devices bigint,
    last_login_at timestamptz,
    created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
    if not public.gpxsuite_is_admin() then
        raise exception 'not authorized';
    end if;

    return query
    select
        p.id,
        p.username,
        p.email,
        p.display_name,
        p.role,
        p.status,
        p.device_lock_enabled,
        p.max_devices,
        count(d.id) filter (where d.status = 'approved') as approved_devices,
        count(d.id) filter (where d.status = 'pending') as pending_devices,
        p.last_login_at,
        p.created_at
    from public.gpxsuite_profiles p
    left join public.gpxsuite_user_devices d on d.user_id = p.id
    group by p.id
    order by p.created_at desc;
end;
$$;

create or replace function public.gpxsuite_admin_list_devices()
returns table (
    id uuid,
    user_id uuid,
    username citext,
    email text,
    label text,
    user_agent text,
    status text,
    first_seen_at timestamptz,
    last_seen_at timestamptz,
    approved_at timestamptz,
    max_devices integer,
    device_lock_enabled boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
    if not public.gpxsuite_is_admin() then
        raise exception 'not authorized';
    end if;

    return query
    select
        d.id,
        d.user_id,
        p.username,
        p.email,
        d.label,
        d.user_agent,
        d.status,
        d.first_seen_at,
        d.last_seen_at,
        d.approved_at,
        p.max_devices,
        p.device_lock_enabled
    from public.gpxsuite_user_devices d
    join public.gpxsuite_profiles p on p.id = d.user_id
    order by
        case d.status when 'pending' then 0 when 'approved' then 1 else 2 end,
        d.last_seen_at desc;
end;
$$;

create or replace function public.gpxsuite_admin_list_events(p_limit integer default 80)
returns table (
    id bigint,
    created_at timestamptz,
    event_name text,
    username citext,
    email text,
    event_meta jsonb
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
    if not public.gpxsuite_is_admin() then
        raise exception 'not authorized';
    end if;

    return query
    select
        e.id,
        e.created_at,
        e.event_name,
        p.username,
        p.email,
        e.event_meta
    from public.gpxsuite_analytics_events e
    left join public.gpxsuite_profiles p on p.id = e.user_id
    order by e.created_at desc
    limit greatest(1, least(coalesce(p_limit, 80), 300));
end;
$$;

create or replace function public.gpxsuite_admin_update_user(
    p_user_id uuid,
    p_role text,
    p_status text,
    p_max_devices integer,
    p_device_lock_enabled boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_admins integer;
    v_current_role text;
begin
    if not public.gpxsuite_is_admin() then
        raise exception 'not authorized';
    end if;

    if p_role not in ('user', 'admin') then
        raise exception 'invalid role';
    end if;
    if p_status not in ('active', 'suspended') then
        raise exception 'invalid status';
    end if;

    select role into v_current_role
    from public.gpxsuite_profiles
    where id = p_user_id;

    if v_current_role = 'admin' and p_role <> 'admin' then
        select count(*) into v_admins
        from public.gpxsuite_profiles
        where role = 'admin' and status = 'active';
        if v_admins <= 1 then
            raise exception 'cannot remove the last active admin';
        end if;
    end if;

    update public.gpxsuite_profiles
    set role = p_role,
        status = p_status,
        max_devices = greatest(1, least(coalesce(p_max_devices, 1), 20)),
        device_lock_enabled = coalesce(p_device_lock_enabled, true)
    where id = p_user_id;

    perform public.gpxsuite_private_log_event(auth.uid(), null, 'admin_user_update', jsonb_build_object('userId', p_user_id), null);
end;
$$;

create or replace function public.gpxsuite_admin_set_device_status(
    p_device_id uuid,
    p_status text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_device public.gpxsuite_user_devices%rowtype;
    v_profile public.gpxsuite_profiles%rowtype;
    v_approved_count integer;
begin
    if not public.gpxsuite_is_admin() then
        raise exception 'not authorized';
    end if;

    if p_status not in ('approved', 'pending', 'rejected', 'revoked') then
        raise exception 'invalid device status';
    end if;

    select * into v_device
    from public.gpxsuite_user_devices
    where id = p_device_id;
    if not found then
        raise exception 'device not found';
    end if;

    select * into v_profile
    from public.gpxsuite_profiles
    where id = v_device.user_id;

    if p_status = 'approved' and v_device.status <> 'approved' then
        select count(*) into v_approved_count
        from public.gpxsuite_user_devices
        where user_id = v_device.user_id
          and status = 'approved';
        if v_approved_count >= v_profile.max_devices then
            raise exception 'device limit reached';
        end if;
    end if;

    update public.gpxsuite_user_devices
    set status = p_status,
        approved_at = case when p_status = 'approved' then now() else approved_at end,
        approved_by = case when p_status = 'approved' then auth.uid() else approved_by end,
        rejected_at = case when p_status in ('rejected', 'revoked') then now() else rejected_at end,
        rejected_by = case when p_status in ('rejected', 'revoked') then auth.uid() else rejected_by end
    where id = p_device_id;

    perform public.gpxsuite_private_log_event(auth.uid(), p_device_id, 'admin_device_status', jsonb_build_object('status', p_status), null);
end;
$$;

grant execute on function public.gpxsuite_resolve_login_identifier(text) to anon, authenticated;
grant execute on function public.gpxsuite_complete_login(text, text, text) to authenticated;
grant execute on function public.gpxsuite_log_event(text, jsonb, text) to authenticated;
revoke all on function public.gpxsuite_private_log_event(uuid, uuid, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.gpxsuite_admin_summary() to authenticated;
grant execute on function public.gpxsuite_admin_list_users() to authenticated;
grant execute on function public.gpxsuite_admin_list_devices() to authenticated;
grant execute on function public.gpxsuite_admin_list_events(integer) to authenticated;
grant execute on function public.gpxsuite_admin_update_user(uuid, text, text, integer, boolean) to authenticated;
grant execute on function public.gpxsuite_admin_set_device_status(uuid, text) to authenticated;
