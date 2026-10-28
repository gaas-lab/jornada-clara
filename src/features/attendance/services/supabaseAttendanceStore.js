import { supabase } from '../../../shared/lib/supabase.js';

const DATABASE_KIND_TO_APP_KIND = {
  work_start: 'start',
  lunch_start: 'lunchStart',
  lunch_end: 'lunchEnd',
  work_end: 'end',
};

export async function readAttendanceDay(employeeId, workDate) {
  if (!supabase) throw new Error('Supabase não está configurado neste dispositivo.');

  let { data, error } = await supabase
    .from('effective_attendance_punches')
    .select('id,kind,punched_at,sequence_no')
    .eq('employee_id', employeeId)
    .eq('work_date', workDate)
    .order('sequence_no', { ascending: true });

  if (error && /effective_attendance_punches.*(does not exist|schema cache|could not find)|relation .* does not exist/i.test(error.message)) {
    const fallback = await supabase
      .from('attendance_punches')
      .select('id,kind,punched_at,sequence_no')
      .eq('employee_id', employeeId)
      .eq('work_date', workDate)
      .order('sequence_no', { ascending: true });
    data = fallback.data;
    error = fallback.error;
  }
  if (error) throw error;

  return {
    punches: (data ?? []).map((punch) => ({
      kind: DATABASE_KIND_TO_APP_KIND[punch.kind],
      at: punch.punched_at,
    })),
  };
}

export async function registerAttendancePunch() {
  if (!supabase) throw new Error('Supabase não está configurado neste dispositivo.');

  const { error } = await supabase.rpc('register_attendance_punch');
  if (error) throw error;
}
