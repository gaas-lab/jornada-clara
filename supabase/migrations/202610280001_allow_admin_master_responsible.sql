-- Allow an active Admin Master to be selected as the direct responsible profile.
create or replace function public.admin_update_profile(
  p_employee_id uuid,
  p_full_name text,
  p_role public.app_role,
  p_manager_id uuid,
  p_is_active boolean
)
returns public.profiles language plpgsql security definer set search_path = '' as $$
declare
  result public.profiles;
  creates_cycle boolean;
begin
  if private.current_role() <> 'admin_master' then
    raise exception 'Ação exclusiva do Admin Master.' using errcode = '42501';
  end if;
  if p_employee_id = auth.uid() and p_role <> 'admin_master' then
    raise exception 'Não é possível remover seu próprio acesso Admin Master.';
  end if;
  if p_employee_id = auth.uid() and not p_is_active then
    raise exception 'Não é possível desativar o próprio perfil.';
  end if;
  if p_manager_id is not null and not exists (
    select 1 from public.profiles m
    where m.id = p_manager_id and m.role in ('manager', 'admin_master') and m.is_active
  ) then
    raise exception 'Selecione um Gestor ou Admin Master ativo como responsável.';
  end if;
  if p_manager_id = p_employee_id then
    raise exception 'Uma pessoa não pode ser gestora de si mesma.';
  end if;
  if p_manager_id is not null then
    with recursive descendants(id) as (
      select id from public.profiles where manager_id = p_employee_id
      union all
      select p.id from public.profiles p join descendants d on p.manager_id = d.id
    )
    select exists(select 1 from descendants where id = p_manager_id) into creates_cycle;
    if creates_cycle then
      raise exception 'A hierarquia de gestores não pode formar ciclos.';
    end if;
  end if;
  update public.profiles
  set full_name = trim(coalesce(p_full_name, '')),
      role = p_role,
      manager_id = p_manager_id,
      is_active = p_is_active
  where id = p_employee_id
  returning * into result;
  if not found then raise exception 'Perfil não encontrado.'; end if;
  return result;
end;
$$;
