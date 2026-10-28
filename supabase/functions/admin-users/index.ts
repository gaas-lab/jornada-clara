import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.117.2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function response(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return response(405, { error: 'Método não permitido.' });

  const authorization = request.headers.get('Authorization');
  if (!authorization?.startsWith('Bearer ')) return response(401, { error: 'Sessão necessária.' });

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return response(500, { error: 'A função não está configurada no Supabase.' });
  }

  const authClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: { user }, error: authError } = await authClient.auth.getUser();
  if (authError || !user) return response(401, { error: 'Sessão inválida ou expirada.' });

  const { data: actor, error: actorError } = await adminClient
    .from('profiles')
    .select('role, is_active')
    .eq('id', user.id)
    .maybeSingle();
  if (actorError) return response(500, { error: 'Não foi possível verificar as permissões.' });
  if (!actor?.is_active || actor.role !== 'admin_master') {
    return response(403, { error: 'Somente o Admin Master pode criar contas.' });
  }

  let input: {
    email?: string;
    password?: string;
    full_name?: string;
    role?: 'employee' | 'manager' | 'admin_master';
    manager_id?: string | null;
    daily_minutes?: number;
    work_days?: number[];
    minimum_lunch_minutes?: number;
    effective_from?: string;
  };
  try {
    input = await request.json();
  } catch {
    return response(400, { error: 'O corpo da solicitação precisa ser JSON válido.' });
  }

  const email = input.email?.trim().toLowerCase();
  const password = input.password ?? '';
  const fullName = input.full_name?.trim() ?? '';
  const role = input.role === 'manager' ? 'manager' : input.role === 'admin_master' ? 'admin_master' : 'employee';
  if (!email || !email.includes('@') || password.length < 10 || !fullName) {
    return response(400, { error: 'Informe nome, e-mail válido e senha com pelo menos 10 caracteres.' });
  }

  const dailyMinutes = Number(input.daily_minutes ?? 528);
  const workDays = input.work_days ?? [1, 2, 3, 4, 5];
  const lunchMinutes = Number(input.minimum_lunch_minutes ?? 60);
  if (!Number.isInteger(dailyMinutes) || dailyMinutes < 1 || dailyMinutes > 1440 ||
      !Array.isArray(workDays) || workDays.length === 0 || workDays.some((day) => !Number.isInteger(day) || day < 1 || day > 7) ||
      !Number.isInteger(lunchMinutes) || lunchMinutes < 60) {
    return response(400, { error: 'Jornada inválida.' });
  }

  if (input.manager_id) {
    const { data: manager, error: managerError } = await adminClient
      .from('profiles')
      .select('role,is_active')
      .eq('id', input.manager_id)
      .maybeSingle();
    if (managerError) return response(500, { error: 'Não foi possível validar o gestor responsável.' });
    if (!manager || !manager.is_active || manager.role !== 'manager') {
      return response(400, { error: 'O gestor selecionado não está ativo ou não tem perfil de Gestor.' });
    }
  }

  const { data: created, error: createError } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });
  if (createError || !created.user) return response(400, { error: createError?.message ?? 'Não foi possível criar a conta.' });

  const profileId = created.user.id;
  const { error: profileError } = await adminClient.from('profiles').upsert({
    id: profileId,
    email,
    full_name: fullName,
    role,
    manager_id: input.manager_id ?? null,
    is_active: true,
  });
  if (profileError) {
    await adminClient.from('employee_schedules').delete().eq('employee_id', profileId);
    await adminClient.from('profiles').delete().eq('id', profileId);
    await adminClient.auth.admin.deleteUser(profileId);
    return response(400, { error: profileError.message });
  }

  const { error: scheduleError } = await adminClient.from('employee_schedules').upsert({
    employee_id: profileId,
    daily_minutes: dailyMinutes,
    work_days: workDays,
    minimum_lunch_minutes: lunchMinutes,
    effective_from: input.effective_from ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date()),
    updated_by: user.id,
  });
  if (scheduleError) {
    await adminClient.from('employee_schedules').delete().eq('employee_id', profileId);
    await adminClient.from('profiles').delete().eq('id', profileId);
    await adminClient.auth.admin.deleteUser(profileId);
    return response(400, { error: scheduleError.message });
  }

  return response(201, {
    user: { id: profileId, email, full_name: fullName, role },
  });
});
