-- Role-specific workflows for Jornada Clara.
-- Apply after 202610270001_initial_schema.sql.

alter table public.profiles
  add column if not exists email text,
  add column if not exists manager_id uuid references public.profiles(id) on delete set null;

update public.profiles p
set email = u.email
from auth.users u
where u.id = p.id and p.email is distinct from u.email;

alter table public.attendance_punches
  add column if not exists is_voided boolean not null default false,
  add column if not exists voided_by uuid references public.profiles(id) on delete set null,
  add column if not exists voided_at timestamptz,
  add column if not exists voided_by_request uuid;
alter table public.attendance_punches
  drop constraint if exists attendance_punches_employee_id_work_date_sequence_no_key,
  drop constraint if exists attendance_punches_employee_id_work_date_kind_key;
create unique index if not exists attendance_punches_active_sequence_idx
  on public.attendance_punches(employee_id, work_date, sequence_no) where is_voided = false;
create unique index if not exists attendance_punches_active_kind_idx
  on public.attendance_punches(employee_id, work_date, kind) where is_voided = false;

create or replace function private.sync_auth_profile()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, full_name, email)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', ''), new.email)
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert or update of email on auth.users
for each row execute function private.sync_auth_profile();

create or replace function private.can_view_employee(target_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  with recursive visible_ids(id) as (
    select (select auth.uid()) where (select auth.uid()) is not null
    union all
    select p.id
    from public.profiles p
    join visible_ids v on p.manager_id = v.id
    where p.is_active
  )
  select exists (
    select 1 from public.profiles p
    where p.id = target_id
      and (
        p.id = (select auth.uid())
        or private.current_role() = 'admin_master'
        or (private.current_role() = 'manager' and p.is_active and p.id in (select id from visible_ids))
      )
  )
$$;

create or replace function private.can_manage_employee(target_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  with recursive managed_ids(id) as (
    select p.id from public.profiles p where p.manager_id = (select auth.uid()) and p.is_active
    union all
    select p.id from public.profiles p join managed_ids m on p.manager_id = m.id where p.is_active
  )
  select coalesce(
    private.current_role() = 'admin_master'
    or (private.current_role() = 'manager' and target_id in (select id from managed_ids)),
    false
  )
$$;

create or replace function public.register_attendance_punch()
returns public.attendance_punches language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid(); local_date date;
begin
  select (now() at time zone s.timezone)::date into local_date
  from public.company_settings s where s.id = true;
  if exists (
    select 1 from public.absences a
    where a.employee_id = actor and a.starts_on <= local_date and a.ends_on >= local_date
  ) then raise exception 'Esta data está coberta por férias ou atestado.'; end if;
  return private.register_attendance_punch();
end;
$$;

grant execute on function private.can_view_employee(uuid) to authenticated;
grant execute on function private.can_manage_employee(uuid) to authenticated;
revoke all on function private.register_attendance_punch() from public, anon, authenticated;

create or replace function private.register_attendance_punch()
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
  last_punch record;
  inserted_punch public.attendance_punches;
  current_month date;
begin
  if actor_id is null then raise exception 'Autenticação necessária.' using errcode = '42501'; end if;
  if not exists (select 1 from public.profiles p where p.id = actor_id and p.is_active) then
    raise exception 'Usuário inativo ou sem perfil.' using errcode = '42501';
  end if;
  select now() at time zone s.timezone into local_now from public.company_settings s where s.id = true;
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
  where cs.id = true order by es.effective_from desc nulls last limit 1;
  if not (local_dow = any(scheduled_days)) then raise exception 'Hoje não é um dia previsto na sua jornada.'; end if;
  if exists (select 1 from public.company_holidays h where h.holiday_date = local_date) then
    raise exception 'Não é possível registrar ponto em feriado cadastrado.';
  end if;
  if exists (select 1 from public.absences a where a.employee_id = actor_id and a.starts_on <= local_date and a.ends_on >= local_date) then
    raise exception 'Esta data está coberta por férias ou atestado.';
  end if;
  if exists (select 1 from public.calendar_locks l where l.month_start = current_month and l.is_closed and (l.employee_id is null or l.employee_id = actor_id)) then
    raise exception 'O calendário está fechado para esta data.';
  end if;

  select min(n)::smallint into next_sequence
  from generate_series(1, 4) as positions(n)
  where not exists (
    select 1 from public.attendance_punches p
    where p.employee_id = actor_id and p.work_date = local_date and p.sequence_no = n and not p.is_voided
  );
  if next_sequence is null then raise exception 'A jornada de hoje já foi encerrada.'; end if;
  expected_kind := case next_sequence
    when 1 then 'work_start'::public.punch_kind
    when 2 then 'lunch_start'::public.punch_kind
    when 3 then 'lunch_end'::public.punch_kind
    else 'work_end'::public.punch_kind
  end;
  if next_sequence > 1 and exists (
    select 1 from public.attendance_punches p
    where p.employee_id = actor_id and p.work_date = local_date and p.sequence_no = next_sequence - 1 and p.is_voided
  ) then raise exception 'Solicite uma correção antes de continuar a sequência.'; end if;
  if exists (
    select 1 from public.attendance_punches p
    where p.employee_id = actor_id and p.work_date = local_date and p.sequence_no > next_sequence and not p.is_voided
  ) then raise exception 'Há marcações posteriores. Solicite a correção da sequência antes de continuar.'; end if;
  if next_sequence = 3 then
    select p.* into last_punch from public.effective_attendance_punches p
    where p.employee_id = actor_id and p.work_date = local_date and p.sequence_no = 2;
    if last_punch.punched_at + make_interval(mins => lunch_minimum) > clock_timestamp() then
      raise exception 'O intervalo mínimo de almoço ainda não foi cumprido.';
    end if;
  end if;
  insert into public.attendance_punches (employee_id, work_date, sequence_no, kind)
  values (actor_id, local_date, next_sequence, expected_kind) returning * into inserted_punch;
  return inserted_punch;
end;
$$;

create table public.attendance_punch_corrections (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique references public.change_requests(id) on delete restrict,
  punch_id uuid not null references public.attendance_punches(id) on delete restrict,
  employee_id uuid not null references public.profiles(id) on delete restrict,
  work_date date not null,
  corrected_at timestamptz,
  is_deleted boolean not null default false,
  applied_by uuid not null references public.profiles(id) on delete restrict,
  applied_at timestamptz not null default now(),
  check (not is_deleted or corrected_at is null)
);
create index attendance_corrections_employee_date_idx
  on public.attendance_punch_corrections(employee_id, work_date);
alter table public.attendance_punch_corrections enable row level security;
create policy attendance_corrections_read_authorized on public.attendance_punch_corrections
  for select to authenticated using (private.can_view_employee(employee_id));
revoke all on public.attendance_punch_corrections from anon, authenticated;
grant select on public.attendance_punch_corrections to authenticated;

alter table public.change_requests
  add column if not exists action text not null default 'adjust'
    check (action in ('adjust', 'delete'));
create index if not exists change_requests_one_pending_per_punch_idx
  on public.change_requests(punch_id) where status = 'pending' and punch_id is not null;
create unique index if not exists change_requests_one_pending_missing_mark_idx
  on public.change_requests(employee_id, work_date, requested_kind)
  where status = 'pending' and punch_id is null;

create or replace view public.effective_attendance_punches with (security_invoker = true) as
select p.id, p.employee_id, p.work_date, p.sequence_no, p.kind,
       coalesce(c.corrected_at, p.punched_at) as punched_at,
       p.punched_at as original_punched_at,
       (c.id is not null) as was_corrected
from public.attendance_punches p
left join lateral (
  select x.* from public.attendance_punch_corrections x
  where x.punch_id = p.id order by x.applied_at desc limit 1
) c on true
where not p.is_voided and coalesce(c.is_deleted, false) = false;
grant select on public.effective_attendance_punches to authenticated;

create or replace function public.create_change_request(
  p_work_date date,
  p_punch_id uuid,
  p_requested_kind public.punch_kind,
  p_requested_at timestamptz,
  p_action text,
  p_reason text
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  request_id uuid;
begin
  if actor is null then raise exception 'Autenticação necessária.' using errcode = '42501'; end if;
  if not exists (select 1 from public.profiles p where p.id = actor and p.is_active) then
    raise exception 'Perfil inativo ou indisponível.' using errcode = '42501';
  end if;
  if p_action not in ('adjust', 'delete') or length(trim(coalesce(p_reason, ''))) < 5 then
    raise exception 'Informe o tipo de solicitação e uma justificativa com pelo menos 5 caracteres.';
  end if;
  if p_action = 'adjust' and (p_requested_kind is null or p_requested_at is null) then
    raise exception 'Informe a marcação e o horário solicitado.';
  end if;
  if p_action = 'delete' and p_punch_id is null then
    raise exception 'Selecione a marcação que deseja excluir.';
  end if;
  if p_punch_id is not null and not exists (
    select 1 from public.attendance_punches p
    where p.id = p_punch_id and p.employee_id = actor and p.work_date = p_work_date and not p.is_voided
  ) then raise exception 'A marcação selecionada não pertence a este perfil.' using errcode = '42501'; end if;
  if p_punch_id is not null and exists (
    select 1 from public.change_requests r where r.punch_id = p_punch_id and r.status = 'pending'
  ) then raise exception 'Esta marcação já tem uma solicitação pendente.'; end if;
  if p_punch_id is null and p_action <> 'adjust' then raise exception 'Marcação inválida.'; end if;

  insert into public.change_requests
    (employee_id, punch_id, work_date, requested_kind, requested_at, action, reason)
  values (actor, p_punch_id, p_work_date, p_requested_kind, p_requested_at, p_action, trim(p_reason))
  returning id into request_id;
  return request_id;
end;
$$;

create or replace function public.review_change_request(
  p_request_id uuid,
  p_approve boolean,
  p_note text default null
)
returns public.change_requests language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  req public.change_requests;
  punch public.attendance_punches;
  previous_at timestamptz;
  next_at timestamptz;
begin
  if actor is null then raise exception 'Autenticação necessária.' using errcode = '42501'; end if;
  select * into req from public.change_requests where id = p_request_id for update;
  if not found then raise exception 'Solicitação não encontrada.'; end if;
  if req.status <> 'pending' then raise exception 'Esta solicitação já foi analisada.'; end if;
  if req.employee_id = actor then raise exception 'Você não pode analisar sua própria solicitação.' using errcode = '42501'; end if;
  if private.current_role() = 'manager' then
    if not private.can_manage_employee(req.employee_id) then
      raise exception 'Esta pessoa não está na sua equipe.' using errcode = '42501';
    end if;
    if exists (select 1 from public.profiles p where p.id = req.employee_id and p.role <> 'employee') then
      raise exception 'Solicitações de gestores são analisadas pelo Admin Master.' using errcode = '42501';
    end if;
  elsif private.current_role() <> 'admin_master' then
    raise exception 'Somente Gestores e Admin Master podem analisar solicitações.' using errcode = '42501';
  end if;

  if p_approve then
    if req.punch_id is null then
      if exists (select 1 from public.attendance_punches p where p.employee_id = req.employee_id and p.work_date = req.work_date and not p.is_voided and (p.sequence_no = case req.requested_kind when 'work_start' then 1 when 'lunch_start' then 2 when 'lunch_end' then 3 else 4 end or p.kind = req.requested_kind)) then
        raise exception 'Já existe uma marcação nesta posição da sequência.';
      end if;
      if (select count(*) from public.attendance_punches p where p.employee_id = req.employee_id and p.work_date = req.work_date and not p.is_voided and p.sequence_no < case req.requested_kind when 'work_start' then 1 when 'lunch_start' then 2 when 'lunch_end' then 3 else 4 end) <>
         (case req.requested_kind when 'work_start' then 0 when 'lunch_start' then 1 when 'lunch_end' then 2 else 3 end) then
        raise exception 'As marcações anteriores da sequência precisam existir antes desta inclusão.';
      end if;
      select p.punched_at into previous_at from public.effective_attendance_punches p
      where p.employee_id = req.employee_id and p.work_date = req.work_date and p.sequence_no = case req.requested_kind when 'work_start' then 1 when 'lunch_start' then 2 when 'lunch_end' then 3 else 4 end - 1;
      select p.punched_at into next_at from public.effective_attendance_punches p
      where p.employee_id = req.employee_id and p.work_date = req.work_date and p.sequence_no = case req.requested_kind when 'work_start' then 1 when 'lunch_start' then 2 when 'lunch_end' then 3 else 4 end + 1;
      if (previous_at is not null and previous_at >= req.requested_at) or
         (next_at is not null and next_at <= req.requested_at) then
        raise exception 'O horário solicitado quebra a ordem das marcações.';
      end if;
      if req.requested_kind = 'lunch_end' and previous_at is not null and req.requested_at < previous_at + interval '60 minutes' then
        raise exception 'O intervalo mínimo entre almoço e retorno é de 1 hora.';
      end if;
      if req.requested_kind = 'lunch_start' and next_at is not null and next_at < req.requested_at + interval '60 minutes' then
        raise exception 'O intervalo mínimo entre almoço e retorno é de 1 hora.';
      end if;
      insert into public.attendance_punches (employee_id, work_date, sequence_no, kind, punched_at)
      values (req.employee_id, req.work_date,
        case req.requested_kind when 'work_start' then 1 when 'lunch_start' then 2 when 'lunch_end' then 3 else 4 end,
        req.requested_kind, req.requested_at);
    elsif req.action = 'delete' then
      select * into punch from public.attendance_punches where id = req.punch_id for update;
      if punch.is_voided then raise exception 'A marcação já foi excluída por decisão aprovada.'; end if;
      insert into public.attendance_punch_corrections
        (request_id, punch_id, employee_id, work_date, is_deleted, applied_by)
      values (req.id, punch.id, punch.employee_id, punch.work_date, true, actor);
      update public.attendance_punches set is_voided = true, voided_by = actor, voided_at = now(), voided_by_request = req.id where id = punch.id;
    else
      select * into punch from public.attendance_punches where id = req.punch_id for update;
      if punch.is_voided then raise exception 'A marcação já foi excluída por decisão aprovada.'; end if;
      if req.requested_kind <> punch.kind then raise exception 'Nesta etapa, a correção mantém o tipo original da marcação.'; end if;
      select p.punched_at into previous_at
      from public.effective_attendance_punches p
      where p.employee_id = req.employee_id and p.work_date = req.work_date and p.sequence_no = punch.sequence_no - 1;
      select p.punched_at into next_at
      from public.effective_attendance_punches p
      where p.employee_id = req.employee_id and p.work_date = req.work_date and p.sequence_no = punch.sequence_no + 1;
      if (previous_at is not null and req.requested_at <= previous_at) or
         (next_at is not null and req.requested_at >= next_at) then
        raise exception 'O horário solicitado quebra a ordem das marcações.';
      end if;
      if punch.kind = 'lunch_end' and previous_at is not null and req.requested_at < previous_at + interval '60 minutes' then
        raise exception 'O intervalo mínimo entre almoço e retorno é de 1 hora.';
      end if;
      if punch.kind = 'lunch_start' and next_at is not null and next_at < req.requested_at + interval '60 minutes' then
        raise exception 'O intervalo mínimo entre almoço e retorno é de 1 hora.';
      end if;
      insert into public.attendance_punch_corrections
        (request_id, punch_id, employee_id, work_date, corrected_at, applied_by)
      values (req.id, punch.id, punch.employee_id, punch.work_date, req.requested_at, actor);
    end if;
  end if;

  update public.change_requests
  set status = case when p_approve then 'approved'::public.change_request_status else 'rejected'::public.change_request_status end,
      reviewed_by = actor, reviewed_at = now(), review_note = nullif(trim(coalesce(p_note, '')), '')
  where id = req.id returning * into req;
  return req;
end;
$$;

create or replace function public.admin_update_profile(
  p_employee_id uuid,
  p_full_name text,
  p_role public.app_role,
  p_manager_id uuid,
  p_is_active boolean
)
returns public.profiles language plpgsql security definer set search_path = '' as $$
declare result public.profiles; creates_cycle boolean;
begin
  if private.current_role() <> 'admin_master' then raise exception 'Ação exclusiva do Admin Master.' using errcode = '42501'; end if;
  if p_employee_id = auth.uid() and p_role <> 'admin_master' then raise exception 'Não é possível remover seu próprio acesso Admin Master.'; end if;
  if p_employee_id = auth.uid() and not p_is_active then raise exception 'Não é possível desativar o próprio perfil.'; end if;
  if p_role = 'manager' and p_manager_id is not null and not exists (
    select 1 from public.profiles m where m.id = p_manager_id and m.role = 'manager' and m.is_active
  ) then raise exception 'Selecione um gestor ativo para esta subequipe.'; end if;
  if p_role <> 'manager' and p_manager_id is not null and not exists (
    select 1 from public.profiles m where m.id = p_manager_id and m.role = 'manager' and m.is_active
  ) then raise exception 'Selecione um gestor ativo para esta pessoa.'; end if;
  if p_manager_id = p_employee_id then raise exception 'Uma pessoa não pode ser gestora de si mesma.'; end if;
  if p_manager_id is not null then
    with recursive descendants(id) as (
      select id from public.profiles where manager_id = p_employee_id
      union all select p.id from public.profiles p join descendants d on p.manager_id = d.id
    )
    select exists(select 1 from descendants where id = p_manager_id) into creates_cycle;
    if creates_cycle then raise exception 'A hierarquia de gestores não pode formar ciclos.'; end if;
  end if;
  update public.profiles
  set full_name = trim(coalesce(p_full_name, '')), role = p_role,
      manager_id = p_manager_id, is_active = p_is_active
  where id = p_employee_id returning * into result;
  if not found then raise exception 'Perfil não encontrado.'; end if;
  return result;
end;
$$;

create or replace function public.admin_set_schedule(
  p_employee_id uuid,
  p_daily_minutes smallint,
  p_work_days smallint[],
  p_minimum_lunch_minutes smallint,
  p_effective_from date
)
returns public.employee_schedules language plpgsql security definer set search_path = '' as $$
declare result public.employee_schedules;
begin
  if private.current_role() <> 'admin_master' then raise exception 'Ação exclusiva do Admin Master.' using errcode = '42501'; end if;
  if p_daily_minutes not between 1 and 1440 or p_minimum_lunch_minutes < 60 or
     coalesce(array_length(p_work_days, 1), 0) = 0 or
     exists(select 1 from unnest(p_work_days) as days(day) where day not between 1 and 7) then
    raise exception 'Jornada inválida.';
  end if;
  insert into public.employee_schedules(employee_id, daily_minutes, work_days, minimum_lunch_minutes, effective_from, updated_by)
  values(p_employee_id, p_daily_minutes, p_work_days, p_minimum_lunch_minutes, p_effective_from, auth.uid())
  on conflict(employee_id, effective_from) do update set daily_minutes = excluded.daily_minutes,
    work_days = excluded.work_days, minimum_lunch_minutes = excluded.minimum_lunch_minutes,
    updated_by = auth.uid(), updated_at = now()
  returning * into result;
  return result;
end;
$$;

create or replace function public.admin_save_profile(
  p_employee_id uuid,
  p_full_name text,
  p_role public.app_role,
  p_manager_id uuid,
  p_is_active boolean,
  p_daily_minutes smallint,
  p_work_days smallint[],
  p_minimum_lunch_minutes smallint,
  p_effective_from date
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare saved_profile public.profiles; saved_schedule public.employee_schedules;
begin
  saved_profile := public.admin_update_profile(p_employee_id, p_full_name, p_role, p_manager_id, p_is_active);
  saved_schedule := public.admin_set_schedule(p_employee_id, p_daily_minutes, p_work_days, p_minimum_lunch_minutes, p_effective_from);
  return jsonb_build_object('profile', to_jsonb(saved_profile), 'schedule', to_jsonb(saved_schedule));
end;
$$;

create or replace function public.admin_set_calendar_lock(
  p_month_start date,
  p_employee_id uuid,
  p_is_closed boolean
)
returns public.calendar_locks language plpgsql security definer set search_path = '' as $$
declare result public.calendar_locks;
begin
  if private.current_role() <> 'admin_master' then raise exception 'Ação exclusiva do Admin Master.' using errcode = '42501'; end if;
  if date_trunc('month', p_month_start)::date <> p_month_start then raise exception 'Use o primeiro dia do mês.'; end if;
  if p_employee_id is null then
    insert into public.calendar_locks(month_start, employee_id, is_closed, changed_by, changed_at)
    values(p_month_start, null, p_is_closed, auth.uid(), now())
    on conflict(month_start) where employee_id is null do update set is_closed = excluded.is_closed, changed_by = auth.uid(), changed_at = now()
    returning * into result;
  else
    insert into public.calendar_locks(month_start, employee_id, is_closed, changed_by, changed_at)
    values(p_month_start, p_employee_id, p_is_closed, auth.uid(), now())
    on conflict(month_start, employee_id) where employee_id is not null do update set is_closed = excluded.is_closed, changed_by = auth.uid(), changed_at = now()
    returning * into result;
  end if;
  return result;
end;
$$;

create or replace function public.manager_record_absence(
  p_employee_id uuid,
  p_kind public.absence_kind,
  p_starts_on date,
  p_ends_on date,
  p_note text default null
)
returns public.absences language plpgsql security definer set search_path = '' as $$
declare result public.absences;
begin
  if not private.can_manage_employee(p_employee_id) then raise exception 'Este perfil não está na sua equipe.' using errcode = '42501'; end if;
  if p_ends_on < p_starts_on then raise exception 'A data final não pode ser anterior à data inicial.'; end if;
  insert into public.absences(employee_id, kind, starts_on, ends_on, note, created_by)
  values(p_employee_id, p_kind, p_starts_on, p_ends_on, nullif(trim(coalesce(p_note, '')), ''), auth.uid())
  returning * into result;
  return result;
end;
$$;

create or replace function public.admin_set_holiday(p_holiday_date date, p_name text, p_delete boolean default false)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if private.current_role() <> 'admin_master' then raise exception 'Ação exclusiva do Admin Master.' using errcode = '42501'; end if;
  if p_delete then
    delete from public.company_holidays where holiday_date = p_holiday_date;
  else
    if length(trim(coalesce(p_name, ''))) < 3 then raise exception 'Informe o nome do feriado.'; end if;
    insert into public.company_holidays(holiday_date, name, source, created_by)
    values(p_holiday_date, trim(p_name), 'admin', auth.uid())
    on conflict(holiday_date) do update set name = excluded.name, source = excluded.source, created_by = auth.uid();
  end if;
end;
$$;

create or replace function public.admin_close_month(p_month_start date, p_employee_id uuid default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  person record;
  day_cursor date;
  month_end date;
  daily_target integer;
  work_days smallint[];
  expected_total integer;
  worked_total integer;
  day_worked integer;
  marks record;
  changed_count integer := 0;
begin
  if private.current_role() <> 'admin_master' then raise exception 'Ação exclusiva do Admin Master.' using errcode = '42501'; end if;
  if date_trunc('month', p_month_start)::date <> p_month_start then raise exception 'Use o primeiro dia do mês.'; end if;
  if p_month_start >= date_trunc('month', now() at time zone 'America/Sao_Paulo')::date then raise exception 'O mês só pode ser fechado depois do último dia.'; end if;
  month_end := (p_month_start + interval '1 month - 1 day')::date;

  for person in
    select p.id from public.profiles p
    where p_employee_id is null or p.id = p_employee_id
  loop
    expected_total := 0;
    worked_total := 0;
    for day_cursor in select d::date from generate_series(p_month_start::timestamp, month_end::timestamp, interval '1 day') d
    loop
      select coalesce(es.daily_minutes, cs.default_daily_minutes),
             coalesce(es.work_days, cs.default_work_days)
      into daily_target, work_days
      from public.company_settings cs
      left join lateral (
        select s.daily_minutes, s.work_days from public.employee_schedules s
        where s.employee_id = person.id and s.effective_from <= day_cursor
        order by s.effective_from desc limit 1
      ) es on true
      where cs.id = true;
      if extract(isodow from day_cursor)::smallint = any(work_days)
         and not exists(select 1 from public.company_holidays h where h.holiday_date = day_cursor) then
        expected_total := expected_total + daily_target;
        if exists(select 1 from public.absences a where a.employee_id = person.id and a.starts_on <= day_cursor and a.ends_on >= day_cursor) then
          worked_total := worked_total + daily_target;
        else
          select
            coalesce(max(case when p.sequence_no = 1 then p.punched_at end), null) as work_start,
            coalesce(max(case when p.sequence_no = 2 then p.punched_at end), null) as lunch_start,
            coalesce(max(case when p.sequence_no = 3 then p.punched_at end), null) as lunch_end,
            coalesce(max(case when p.sequence_no = 4 then p.punched_at end), null) as work_end
          into marks
          from public.effective_attendance_punches p
          where p.employee_id = person.id and p.work_date = day_cursor;
          day_worked := 0;
          if marks.work_start is not null and marks.lunch_start is not null then
            day_worked := day_worked + greatest(0, floor(extract(epoch from (marks.lunch_start - marks.work_start)) / 60)::integer);
          end if;
          if marks.lunch_end is not null and marks.work_end is not null then
            day_worked := day_worked + greatest(0, floor(extract(epoch from (marks.work_end - marks.lunch_end)) / 60)::integer);
          end if;
          worked_total := worked_total + day_worked;
        end if;
      end if;
    end loop;
    insert into public.monthly_closings(employee_id, month_start, worked_minutes, expected_minutes, balance_minutes, closed_by, closed_at)
    values(person.id, p_month_start, worked_total, expected_total, worked_total - expected_total, auth.uid(), now())
    on conflict(employee_id, month_start) do update set worked_minutes = excluded.worked_minutes,
      expected_minutes = excluded.expected_minutes, balance_minutes = excluded.balance_minutes,
      closed_by = auth.uid(), closed_at = now();
    changed_count := changed_count + 1;
  end loop;
  return changed_count;
end;
$$;

revoke all on function public.create_change_request(date, uuid, public.punch_kind, timestamptz, text, text) from public, anon;
revoke all on function public.review_change_request(uuid, boolean, text) from public, anon;
revoke all on function public.admin_update_profile(uuid, text, public.app_role, uuid, boolean) from public, anon;
revoke all on function public.admin_set_schedule(uuid, smallint, smallint[], smallint, date) from public, anon;
revoke all on function public.admin_save_profile(uuid, text, public.app_role, uuid, boolean, smallint, smallint[], smallint, date) from public, anon;
revoke all on function public.admin_set_calendar_lock(date, uuid, boolean) from public, anon;
revoke all on function public.manager_record_absence(uuid, public.absence_kind, date, date, text) from public, anon;
revoke all on function public.admin_set_holiday(date, text, boolean) from public, anon;
revoke all on function public.admin_close_month(date, uuid) from public, anon;
grant execute on function public.create_change_request(date, uuid, public.punch_kind, timestamptz, text, text) to authenticated;
grant execute on function public.review_change_request(uuid, boolean, text) to authenticated;
grant execute on function public.admin_update_profile(uuid, text, public.app_role, uuid, boolean) to authenticated;
grant execute on function public.admin_set_schedule(uuid, smallint, smallint[], smallint, date) to authenticated;
grant execute on function public.admin_save_profile(uuid, text, public.app_role, uuid, boolean, smallint, smallint[], smallint, date) to authenticated;
grant execute on function public.admin_set_calendar_lock(date, uuid, boolean) to authenticated;
grant execute on function public.manager_record_absence(uuid, public.absence_kind, date, date, text) to authenticated;
grant execute on function public.admin_set_holiday(date, text, boolean) to authenticated;
grant execute on function public.admin_close_month(date, uuid) to authenticated;

comment on table public.attendance_punch_corrections is 'Approved corrections/deletions are appended here; original punches remain intact.';
