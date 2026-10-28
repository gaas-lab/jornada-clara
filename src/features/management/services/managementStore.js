import { supabase } from '../../../shared/lib/supabase.js';

function ensureSupabase() {
  if (!supabase) throw new Error('Supabase não está configurado.');
  return supabase;
}

async function unwrap(query) {
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

export function listProfiles() {
  return unwrap(ensureSupabase()
    .from('profiles')
    .select('id,email,full_name,role,is_active,manager_id')
    .order('full_name', { ascending: true }));
}

export function listPunches(employeeId, from, to) {
  return unwrap(ensureSupabase()
    .from('effective_attendance_punches')
    .select('id,employee_id,work_date,sequence_no,kind,punched_at,original_punched_at,was_corrected')
    .eq('employee_id', employeeId)
    .gte('work_date', from)
    .lte('work_date', to)
    .order('work_date', { ascending: false })
    .order('sequence_no', { ascending: true }));
}

export function listRequests(from, to) {
  return unwrap(ensureSupabase()
    .from('change_requests')
    .select('id,employee_id,punch_id,work_date,requested_kind,requested_at,action,reason,status,reviewed_by,reviewed_at,review_note,created_at')
    .gte('work_date', from)
    .lte('work_date', to)
    .order('created_at', { ascending: false }));
}

export function createChangeRequest(input) {
  return unwrap(ensureSupabase().rpc('create_change_request', {
    p_work_date: input.workDate,
    p_punch_id: input.punchId || null,
    p_requested_kind: input.kind || null,
    p_requested_at: input.at || null,
    p_action: input.action,
    p_reason: input.reason,
  }));
}

export function reviewChangeRequest(id, approve, note) {
  return unwrap(ensureSupabase().rpc('review_change_request', {
    p_request_id: id,
    p_approve: approve,
    p_note: note || null,
  }));
}

export function listSchedules(employeeId) {
  let query = ensureSupabase()
    .from('employee_schedules')
    .select('employee_id,daily_minutes,work_days,minimum_lunch_minutes,effective_from,updated_at')
    .order('effective_from', { ascending: false });
  if (employeeId) query = query.eq('employee_id', employeeId);
  return unwrap(query);
}

export function saveProfile(input) {
  return unwrap(ensureSupabase().rpc('admin_save_profile', {
    p_employee_id: input.id,
    p_full_name: input.fullName,
    p_role: input.role,
    p_manager_id: input.managerId || null,
    p_is_active: input.isActive,
    p_daily_minutes: input.dailyMinutes,
    p_work_days: input.workDays,
    p_minimum_lunch_minutes: input.minimumLunchMinutes,
    p_effective_from: input.effectiveFrom,
  }));
}

export function setCalendarLock(input) {
  return unwrap(ensureSupabase().rpc('admin_set_calendar_lock', {
    p_month_start: input.monthStart,
    p_employee_id: input.employeeId || null,
    p_is_closed: input.isClosed,
  }));
}

export function closeMonth(monthStart, employeeId = null) {
  return unwrap(ensureSupabase().rpc('admin_close_month', {
    p_month_start: monthStart,
    p_employee_id: employeeId || null,
  }));
}

export function listMonthlyClosings(monthStart) {
  return unwrap(ensureSupabase()
    .from('monthly_closings')
    .select('employee_id,month_start,worked_minutes,expected_minutes,balance_minutes,closed_at')
    .eq('month_start', monthStart)
    .order('employee_id'));
}

export function listCalendarLocks(from, to) {
  return unwrap(ensureSupabase()
    .from('calendar_locks')
    .select('id,month_start,employee_id,is_closed,changed_at')
    .gte('month_start', from)
    .lte('month_start', to)
    .order('month_start', { ascending: false }));
}

export function recordAbsence(input) {
  return unwrap(ensureSupabase().rpc('manager_record_absence', {
    p_employee_id: input.employeeId,
    p_kind: input.kind,
    p_starts_on: input.startsOn,
    p_ends_on: input.endsOn,
    p_note: input.note || null,
  }));
}

export function listAbsences(from, to) {
  return unwrap(ensureSupabase()
    .from('absences')
    .select('id,employee_id,kind,starts_on,ends_on,note,created_at')
    .lte('starts_on', to)
    .gte('ends_on', from)
    .order('starts_on', { ascending: false }));
}

export function listHolidays(from, to) {
  return unwrap(ensureSupabase()
    .from('company_holidays')
    .select('holiday_date,name,source')
    .gte('holiday_date', from)
    .lte('holiday_date', to)
    .order('holiday_date'));
}

export function setHoliday(input) {
  return unwrap(ensureSupabase().rpc('admin_set_holiday', {
    p_holiday_date: input.date,
    p_name: input.name || null,
    p_delete: Boolean(input.remove),
  }));
}

export async function createAuthUser(input) {
  const client = ensureSupabase();
  const { data, error } = await client.functions.invoke('admin-users', {
    body: {
      email: input.email,
      password: input.password,
      full_name: input.fullName,
      role: input.role,
      manager_id: input.managerId || null,
      daily_minutes: input.dailyMinutes,
      work_days: input.workDays,
      minimum_lunch_minutes: input.minimumLunchMinutes,
      effective_from: input.effectiveFrom,
    },
  });
  if (error) {
    let message = error.message;
    try {
      const detail = await error.context?.json();
      if (detail?.error) message = detail.error;
    } catch { /* The response body may already have been consumed. */ }
    throw new Error(message);
  }
  if (data?.error) throw new Error(data.error);
  return data.user;
}
