-- Jornada Clara: single-company internal time tracking foundation.
-- Apply with the Supabase CLI after linking the intended Supabase project.

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

create type public.app_role as enum ('employee', 'manager', 'admin_master');
create type public.punch_kind as enum ('work_start', 'lunch_start', 'lunch_end', 'work_end');
create type public.change_request_status as enum ('pending', 'approved', 'rejected');
create type public.absence_kind as enum ('vacation', 'medical_certificate');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete restrict,
  full_name text not null default '',
  role public.app_role not null default 'employee',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.company_settings (
  id boolean primary key default true check (id),
  company_name text not null default 'Jornada Clara',
  timezone text not null default 'America/Sao_Paulo',
  default_daily_minutes smallint not null default 528 check (default_daily_minutes > 0),
  default_work_days smallint[] not null default array[1,2,3,4,5]::smallint[],
  minimum_lunch_minutes smallint not null default 60 check (minimum_lunch_minutes >= 60),
  updated_at timestamptz not null default now()
);
insert into public.company_settings (id) values (true) on conflict (id) do nothing;

create table public.employee_schedules (
  employee_id uuid not null references public.profiles(id) on delete restrict,
  daily_minutes smallint not null check (daily_minutes > 0),
  work_days smallint[] not null,
  minimum_lunch_minutes smallint not null default 60 check (minimum_lunch_minutes >= 60),
  effective_from date not null default current_date,
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (employee_id, effective_from)
);

create table public.company_holidays (
  holiday_date date primary key,
  name text not null,
  source text not null default 'manual',
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.calendar_locks (
  id uuid primary key default gen_random_uuid(),
  month_start date not null check (extract(day from month_start) = 1),
  employee_id uuid references public.profiles(id) on delete restrict,
  is_closed boolean not null default true,
  changed_by uuid references public.profiles(id) on delete set null,
  changed_at timestamptz not null default now()
);
create unique index calendar_locks_global_month_idx on public.calendar_locks(month_start) where employee_id is null;
create unique index calendar_locks_employee_month_idx on public.calendar_locks(month_start, employee_id) where employee_id is not null;

create table public.attendance_punches (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.profiles(id) on delete restrict,
  work_date date not null,
  sequence_no smallint not null check (sequence_no between 1 and 4),
  kind public.punch_kind not null,
  punched_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default now(),
  unique (employee_id, work_date, sequence_no),
  unique (employee_id, work_date, kind)
);
create index attendance_punches_employee_date_idx on public.attendance_punches(employee_id, work_date desc);

create table public.change_requests (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.profiles(id) on delete restrict,
  punch_id uuid references public.attendance_punches(id) on delete restrict,
  work_date date not null,
  requested_kind public.punch_kind,
  requested_at timestamptz,
  reason text not null,
  status public.change_request_status not null default 'pending',
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz not null default now(),
  check (punch_id is not null or (requested_kind is not null and requested_at is not null))
);
create index change_requests_status_date_idx on public.change_requests(status, work_date);

create table public.absences (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.profiles(id) on delete restrict,
  kind public.absence_kind not null,
  starts_on date not null,
  ends_on date not null,
  note text,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  check (ends_on >= starts_on)
);
create index absences_employee_dates_idx on public.absences(employee_id, starts_on, ends_on);

create table public.monthly_closings (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.profiles(id) on delete restrict,
  month_start date not null check (extract(day from month_start) = 1),
  worked_minutes integer not null default 0,
  expected_minutes integer not null default 0,
  balance_minutes integer not null default 0,
  closed_by uuid references public.profiles(id) on delete set null,
  closed_at timestamptz not null default now(),
  unique (employee_id, month_start)
);

create function private.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
create trigger profiles_touch_updated_at before update on public.profiles
for each row execute function private.touch_updated_at();
create trigger company_settings_touch_updated_at before update on public.company_settings
for each row execute function private.touch_updated_at();
create trigger employee_schedules_touch_updated_at before update on public.employee_schedules
for each row execute function private.touch_updated_at();

create function private.create_profile_for_auth_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', ''))
  on conflict (id) do nothing;
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users
for each row execute function private.create_profile_for_auth_user();

create function private.current_role()
returns public.app_role language sql stable security definer set search_path = '' as $$
  select p.role from public.profiles p
  where p.id = (select auth.uid()) and p.is_active
$$;

create function private.can_view_employee(target_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles target
    where target.id = target_id and target.is_active
      and (
        target.id = (select auth.uid())
        or private.current_role() = 'admin_master'
        or (private.current_role() = 'manager' and target.role = 'employee')
      )
  )
$$;

create function private.is_admin_master()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(private.current_role() = 'admin_master', false)
$$;

create function private.is_manager_or_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(private.current_role() in ('manager', 'admin_master'), false)
$$;

create function private.register_attendance_punch()
returns public.attendance_punches language plpgsql security definer set search_path = '' as $$
declare
  actor_id uuid := auth.uid();
  local_now timestamp without time zone;
  local_date date;
  local_dow smallint;
  expected_kind public.punch_kind;
  next_sequence smallint;
  lunch_minimum integer;
  scheduled_days smallint[];
  last_punch public.attendance_punches;
  inserted_punch public.attendance_punches;
  current_month date;
begin
  if actor_id is null then raise exception 'Autenticação necessária.' using errcode = '42501'; end if;
  if not exists (select 1 from public.profiles p where p.id = actor_id and p.is_active) then
    raise exception 'Usuário inativo ou sem perfil.' using errcode = '42501';
  end if;

  select now() at time zone s.timezone into local_now
  from public.company_settings s where s.id = true;
  if local_now is null then raise exception 'Configuração da empresa ausente.'; end if;
  local_date := local_now::date;
  local_dow := extract(isodow from local_date)::smallint;
  current_month := date_trunc('month', local_date)::date;

  perform pg_advisory_xact_lock(hashtext(actor_id::text), hashtext(local_date::text));

  select coalesce(es.minimum_lunch_minutes, cs.minimum_lunch_minutes),
         coalesce(es.work_days, cs.default_work_days)
    into lunch_minimum, scheduled_days
  from public.company_settings cs
  left join public.employee_schedules es on es.employee_id = actor_id and es.effective_from <= local_date
  where cs.id = true
  order by es.effective_from desc nulls last
  limit 1;
  if not (local_dow = any(scheduled_days)) then
    raise exception 'Hoje não é um dia previsto na sua jornada.';
  end if;
  if exists (select 1 from public.company_holidays h where h.holiday_date = local_date) then
    raise exception 'Não é possível registrar ponto em feriado cadastrado.';
  end if;
  if exists (
    select 1 from public.calendar_locks l
    where l.month_start = current_month and l.is_closed
      and (l.employee_id is null or l.employee_id = actor_id)
  ) then
    raise exception 'O calendário está fechado para esta data.';
  end if;

  select count(*)::smallint into next_sequence
  from public.attendance_punches p where p.employee_id = actor_id and p.work_date = local_date;
  if next_sequence >= 4 then raise exception 'A jornada de hoje já foi encerrada.'; end if;
  next_sequence := next_sequence + 1;
  expected_kind := case next_sequence
    when 1 then 'work_start'::public.punch_kind
    when 2 then 'lunch_start'::public.punch_kind
    when 3 then 'lunch_end'::public.punch_kind
    else 'work_end'::public.punch_kind
  end;

  if next_sequence = 3 then
    select p.* into last_punch from public.attendance_punches p
    where p.employee_id = actor_id and p.work_date = local_date and p.sequence_no = 2;
    if last_punch.punched_at + make_interval(mins => lunch_minimum) > clock_timestamp() then
      raise exception 'O intervalo mínimo de almoço ainda não foi cumprido.';
    end if;
  end if;

  insert into public.attendance_punches (employee_id, work_date, sequence_no, kind)
  values (actor_id, local_date, next_sequence, expected_kind)
  returning * into inserted_punch;
  return inserted_punch;
end;
$$;

create function public.register_attendance_punch()
returns public.attendance_punches language sql security invoker set search_path = '' as $$
  select private.register_attendance_punch()
$$;

-- Security-definer helpers must only be executable through policies/functions.
revoke all on all functions in schema private from public, anon, authenticated;
grant execute on function private.current_role() to authenticated;
grant execute on function private.can_view_employee(uuid) to authenticated;
grant execute on function private.is_admin_master() to authenticated;
grant execute on function private.is_manager_or_admin() to authenticated;
grant execute on function private.register_attendance_punch() to authenticated;
revoke all on function public.register_attendance_punch() from public, anon;
grant execute on function public.register_attendance_punch() to authenticated;

alter table public.profiles enable row level security;
alter table public.company_settings enable row level security;
alter table public.employee_schedules enable row level security;
alter table public.company_holidays enable row level security;
alter table public.calendar_locks enable row level security;
alter table public.attendance_punches enable row level security;
alter table public.change_requests enable row level security;
alter table public.absences enable row level security;
alter table public.monthly_closings enable row level security;

create policy profiles_read_authorized on public.profiles for select to authenticated
using (private.can_view_employee(id));
create policy company_settings_read_active on public.company_settings for select to authenticated
using (private.current_role() is not null);
create policy schedules_read_authorized on public.employee_schedules for select to authenticated
using (private.can_view_employee(employee_id));
create policy holidays_read_active on public.company_holidays for select to authenticated
using (private.current_role() is not null);
create policy calendar_locks_read_authorized on public.calendar_locks for select to authenticated
using (private.current_role() = 'admin_master' or private.can_view_employee(coalesce(employee_id, auth.uid())));
create policy punches_read_authorized on public.attendance_punches for select to authenticated
using (private.can_view_employee(employee_id));
create policy change_requests_read_authorized on public.change_requests for select to authenticated
using (private.can_view_employee(employee_id));
create policy absences_read_authorized on public.absences for select to authenticated
using (private.can_view_employee(employee_id));
create policy monthly_closings_read_authorized on public.monthly_closings for select to authenticated
using (private.can_view_employee(employee_id));

revoke all on public.profiles, public.company_settings, public.employee_schedules,
  public.company_holidays, public.calendar_locks, public.attendance_punches,
  public.change_requests, public.absences, public.monthly_closings from anon, authenticated;
grant select on public.profiles, public.company_settings, public.employee_schedules,
  public.company_holidays, public.calendar_locks, public.attendance_punches,
  public.change_requests, public.absences, public.monthly_closings to authenticated;
-- No direct writes are granted yet. Punches are created only by the validated RPC;
-- approval, admin, absence and closing mutations will be added as audited RPCs.

comment on table public.attendance_punches is 'Immutable original time punches; corrections must go through change_requests and approval RPCs.';
comment on table public.monthly_closings is 'Monthly payroll handoff snapshot; uncarried balance is reset by the closing process.';
