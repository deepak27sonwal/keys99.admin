-- Applied to the project as migration "role_change_log" (2026-11-06). Kept here for reference.
--
-- Every insert / update / delete on public.user_roles (admin and super_admin), however it was
-- made: the Admins page (manage-admins), a signed-in admin through the API, the Supabase
-- dashboard, or direct SQL. Written only by the trigger; nobody can edit or clear it through
-- the API (no write grants or policies), super admins can read it.
create table public.role_change_log (
  id bigint generated always as identity primary key,
  changed_at timestamptz not null default now(),
  operation text not null check (operation in ('added', 'removed', 'changed')),
  role_row_id uuid,
  old_user_id uuid,
  old_email text,
  old_role text,
  new_user_id uuid,
  new_email text,
  new_role text,
  actor_id uuid,
  actor_email text,
  via text not null,
  db_role text,
  dashboard_session text,
  client_addr inet
);

create index role_change_log_changed_at_idx on public.role_change_log (changed_at desc);

alter table public.role_change_log enable row level security;
revoke all on public.role_change_log from anon, authenticated, service_role;
grant select on public.role_change_log to authenticated;
create policy "Super admins can read role changes" on public.role_change_log
  for select to authenticated using ((select private.is_super_admin()));

create or replace function private.log_role_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  headers jsonb := nullif(current_setting('request.headers', true), '')::jsonb;
  q text := coalesce(current_query(), '');
  jwt_role text := claims ->> 'role';
  actor uuid;
  source text := substring(q from '-- source: ([A-Za-z_-]+)');
  session text := substring(q from 'session:([0-9a-fA-F-]{36})');
  how text;
begin
  if jwt_role = 'service_role' then
    -- manage-admins sends the super admin who asked in this header.
    actor := nullif(headers ->> 'x-keys99-actor', '')::uuid;
    how := 'Admins page';
  elsif source = 'dashboard' then
    actor := nullif(claims ->> 'sub', '')::uuid;
    how := 'Supabase dashboard' || case when actor is not null then ' (acting as a user)' else '' end;
  elsif nullif(claims ->> 'sub', '') is not null then
    actor := (claims ->> 'sub')::uuid;
    how := 'Signed-in account (API)';
  else
    how := 'Direct database access';
  end if;

  insert into public.role_change_log (
    operation, role_row_id,
    old_user_id, old_email, old_role,
    new_user_id, new_email, new_role,
    actor_id, actor_email, via, db_role, dashboard_session, client_addr)
  values (
    case tg_op when 'INSERT' then 'added' when 'DELETE' then 'removed' else 'changed' end,
    coalesce(new.id, old.id),
    old.user_id, (select email from auth.users where id = old.user_id), old.role,
    new.user_id, (select email from auth.users where id = new.user_id), new.role,
    actor, (select email from auth.users where id = actor), how, current_user, session, inet_client_addr());
  return null;
end;
$$;

revoke all on function private.log_role_change() from public, anon, authenticated;

create trigger user_roles_log_changes
  after insert or update or delete on public.user_roles
  for each row execute function private.log_role_change();
