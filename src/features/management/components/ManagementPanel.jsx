import { useEffect, useMemo, useState } from 'react';
import { DAILY_WORK_MINUTES, COMPANY_TIME_ZONE, formatClock, formatMinutes, localDateKey } from '../../attendance/domain/attendance.js';
import { supabase } from '../../../shared/lib/supabase.js';
import {
  createAuthUser,
  createChangeRequest,
  listAbsences,
  listCalendarLocks,
  listHolidays,
  listMonthlyClosings,
  listPunches,
  listProfiles,
  listRequests,
  listSchedules,
  recordAbsence,
  reviewChangeRequest,
  saveProfile,
  closeMonth,
  setCalendarLock,
  setHoliday,
} from '../services/managementStore.js';

const ROLE_LABELS = { employee: 'Funcionário', manager: 'Gestor', admin_master: 'Admin Master' };
const PUNCH_LABELS = {
  work_start: 'Entrada expediente',
  lunch_start: 'Início almoço',
  lunch_end: 'Fim almoço',
  work_end: 'Fim expediente',
};
const WEEKDAYS = [1, 2, 3, 4, 5];
const NATIONAL_FIXED_HOLIDAYS = [
  ['01-01', 'Confraternização Universal'],
  ['04-21', 'Tiradentes'],
  ['05-01', 'Dia Mundial do Trabalho'],
  ['09-07', 'Independência do Brasil'],
  ['10-12', 'Nossa Senhora Aparecida'],
  ['11-02', 'Finados'],
  ['11-15', 'Proclamação da República'],
  ['11-20', 'Dia Nacional de Zumbi e da Consciência Negra'],
  ['12-25', 'Natal'],
];

function nationalHolidaysForYear(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const easterMonth = Math.floor((h + l - 7 * m + 114) / 31);
  const easterDay = ((h + l - 7 * m + 114) % 31) + 1;
  const goodFriday = new Date(Date.UTC(year, easterMonth - 1, easterDay - 2)).toISOString().slice(0, 10);
  return [[goodFriday, 'Paixão de Cristo (Sexta-feira Santa)'], ...NATIONAL_FIXED_HOLIDAYS.map(([monthDay, name]) => [`${year}-${monthDay}`, name])];
}

function monthValue(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: COMPANY_TIME_ZONE, year: 'numeric', month: '2-digit' }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}`;
}

function monthBounds(value) {
  const [year, month] = value.split('-').map(Number);
  const end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  return { start: `${value}-01`, end };
}

function summarizeMonth({ punches, holidays, absences, schedules, start, end }) {
  const holidaySet = new Set(holidays.map((item) => item.holiday_date));
  const absenceSet = new Set();
  for (const absence of absences) {
    for (let cursor = new Date(`${absence.starts_on}T00:00:00Z`), final = new Date(`${absence.ends_on}T00:00:00Z`); cursor <= final; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
      absenceSet.add(cursor.toISOString().slice(0, 10));
    }
  }
  const dayMarks = new Map();
  for (const punch of punches) {
    const marks = dayMarks.get(punch.work_date) ?? [];
    marks.push(punch);
    dayMarks.set(punch.work_date, marks);
  }
  const today = localDateKey();
  const reportEnd = end < today ? end : today;
  let expected = 0;
  let worked = 0;
  for (let cursor = new Date(`${start}T00:00:00Z`), final = new Date(`${reportEnd}T00:00:00Z`); cursor <= final; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const key = cursor.toISOString().slice(0, 10);
    const day = cursor.getUTCDay() || 7;
    const schedule = schedules.find((item) => item.effective_from <= key);
    const requiredDays = schedule?.work_days ?? WEEKDAYS;
    const requiredMinutes = schedule?.daily_minutes ?? DAILY_WORK_MINUTES;
    if (!requiredDays.includes(day) || holidaySet.has(key)) continue;
    if (absenceSet.has(key)) { expected += requiredMinutes; worked += requiredMinutes; continue; }
    const marks = (dayMarks.get(key) ?? []).slice().sort((a, b) => a.sequence_no - b.sequence_no);
    if (key === today && marks.length < 4) continue;
    expected += requiredMinutes;
    if (marks.length >= 2) worked += Math.max(0, (new Date(marks[1].punched_at) - new Date(marks[0].punched_at)) / 60_000);
    if (marks.length >= 4) worked += Math.max(0, (new Date(marks[3].punched_at) - new Date(marks[2].punched_at)) / 60_000);
  }
  return { expected: Math.floor(expected), worked: Math.floor(worked), balance: Math.floor(worked - expected) };
}

function signedMinutes(value) {
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${formatMinutes(Math.abs(value))}`;
}

function noticeFromError(error) {
  const message = error?.message || String(error || 'Ocorreu um erro inesperado.');
  if (/edge function.*not found|function .*not found|failed to send a request to the edge function/i.test(message)) {
    return 'A criação de usuários depende da Edge Function admin-users no Supabase. Publique a função no projeto Jornada Clara e tente novamente.';
  }
  if (/function .* not found|schema cache|could not find the function/i.test(message)) {
    return 'O banco ainda não recebeu a migração dos fluxos por perfil. Aplique 202610270002_role_workflows.sql no SQL Editor do Supabase e tente novamente.';
  }
  if (/effective_attendance_punches|manager_id|column .*email.* does not exist|relation .* does not exist/i.test(message)) {
    return 'O banco ainda não recebeu a migração dos fluxos por perfil. Aplique 202610270002_role_workflows.sql no SQL Editor do Supabase e tente novamente.';
  }
  return message;
}

function useAsyncData(loader, deps) {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    loader().then((rows) => {
      if (active) { setData(rows ?? []); setError(''); }
    }).catch((reason) => {
      if (active) setError(noticeFromError(reason));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  // loader is intentionally represented by its stable dependency list.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, reloadKey]);
  return { data, loading, error, reload: () => setReloadKey((value) => value + 1) };
}

function SectionHeading({ eyebrow, title, description }) {
  return <div className="management-heading"><p className="section-label">{eyebrow}</p><h2>{title}</h2>{description && <p>{description}</p>}</div>;
}

function ResultMessage({ message, error }) {
  if (!message && !error) return null;
  return <p className={`feedback feedback--${error ? 'error' : 'success'}`} role="status">{error || message}</p>;
}

function ActionButton({ children, ...props }) {
  return <button className="management-button" {...props}>{children}</button>;
}

function ProfilePicker({ profiles, value, onChange, includeAll = false, label = 'Pessoa' }) {
  return (
    <label className="management-field">{label}
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {includeAll && <option value="">Toda a empresa</option>}
        {!includeAll && <option value="">Selecione uma pessoa</option>}
        {profiles.map((person) => <option key={person.id} value={person.id}>{person.full_name || person.email || person.id} · {ROLE_LABELS[person.role] ?? person.role}</option>)}
      </select>
    </label>
  );
}

function MonthPicker({ value, onChange }) {
  return <label className="management-field">Mês<input type="month" value={value} onChange={(event) => onChange(event.target.value)} /></label>;
}

function useProfiles() {
  return useAsyncData(listProfiles, []);
}

function MyHistory({ profile }) {
  const [month, setMonth] = useState(monthValue());
  const [refresh, setRefresh] = useState(0);
  const [feedback, setFeedback] = useState('');
  const { start, end } = monthBounds(month);
  const punches = useAsyncData(() => listPunches(profile.id, start, end), [profile.id, start, end, refresh]);
  const holidays = useAsyncData(() => listHolidays(start, end), [start, end, refresh]);
  const absences = useAsyncData(() => listAbsences(start, end).then((rows) => rows.filter((row) => row.employee_id === profile.id)), [profile.id, start, end, refresh]);
  const scheduleQuery = useAsyncData(() => listSchedules(profile.id), [profile.id, refresh]);

  const summary = useMemo(() => summarizeMonth({ punches: punches.data, holidays: holidays.data, absences: absences.data, schedules: scheduleQuery.data, start, end }), [punches.data, holidays.data, absences.data, scheduleQuery.data, start, end]);

  const busy = punches.loading || holidays.loading || absences.loading || scheduleQuery.loading;
  function exportCsv() {
    const lines = [['Data', 'Tipo', 'Horário', 'Registro original']];
    for (const punch of punches.data) lines.push([punch.work_date, PUNCH_LABELS[punch.kind], formatClock(punch.punched_at), punch.was_corrected ? formatClock(punch.original_punched_at) : '']);
    const csv = lines.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(';')).join('\r\n');
    const url = URL.createObjectURL(new Blob(['\ufeff', csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `jornada-${month}.csv`; link.click(); URL.revokeObjectURL(url);
    setFeedback('Arquivo CSV gerado.');
  }

  return (
    <section className="management-section">
      <SectionHeading eyebrow="Consulta individual" title="Meu histórico" description="Consulte marcações e saldo do mês. Atestados e férias contam como jornada completa." />
      <div className="management-toolbar"><MonthPicker value={month} onChange={setMonth} /><div className="management-actions"><ActionButton type="button" onClick={exportCsv}>Exportar CSV</ActionButton><ActionButton type="button" onClick={() => window.print()}>Imprimir / PDF</ActionButton><ActionButton type="button" onClick={() => setRefresh((value) => value + 1)}>Atualizar</ActionButton></div></div>
      <ResultMessage message={feedback} />
      <div className="summary-cards"><div><span>Horas trabalhadas</span><strong>{busy ? '…' : formatMinutes(summary.worked)}</strong></div><div><span>Horas previstas</span><strong>{busy ? '…' : formatMinutes(summary.expected)}</strong></div><div><span>Saldo do mês</span><strong>{busy ? '…' : signedMinutes(summary.balance)}</strong></div></div>
      {punches.error && <ResultMessage error={punches.error} />}
      <div className="management-table-wrap"><table className="management-table"><thead><tr><th>Data</th><th>Marcação</th><th>Horário</th><th>Registro</th></tr></thead><tbody>
        {punches.data.map((punch) => <tr key={punch.id}><td>{new Intl.DateTimeFormat('pt-BR', { timeZone: COMPANY_TIME_ZONE, dateStyle: 'short' }).format(new Date(`${punch.work_date}T12:00:00-03:00`))}</td><td>{PUNCH_LABELS[punch.kind]}</td><td>{formatClock(punch.punched_at)}</td><td>{punch.was_corrected ? `Corrigido; original ${formatClock(punch.original_punched_at)}` : 'Original'}</td></tr>)}
        {!busy && !punches.data.length && <tr><td colSpan="4">Nenhuma marcação neste mês.</td></tr>}
      </tbody></table></div>
    </section>
  );
}

function MyProfile({ profile }) {
  const schedule = useAsyncData(() => listSchedules(profile.id), [profile.id]);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const currentSchedule = schedule.data.find((item) => item.effective_from <= localDateKey());
  const workDayLabels = (currentSchedule?.work_days ?? WEEKDAYS).map((day) => ['','Seg','Ter','Qua','Qui','Sex','Sáb','Dom'][day]).join(', ');
  async function changePassword(event) {
    event.preventDefault(); setError(''); setFeedback('');
    if (password.length < 10) { setError('Use pelo menos 10 caracteres.'); return; }
    if (password !== confirmPassword) { setError('As senhas não coincidem.'); return; }
    setBusy(true);
    const { error: updateError } = await supabase.auth.updateUser({ password });
    if (updateError) setError(updateError.message);
    else { setFeedback('Senha atualizada.'); setPassword(''); setConfirmPassword(''); }
    setBusy(false);
  }
  return <section className="management-section"><SectionHeading eyebrow="Minha conta" title="Meu perfil" description="Confira seus dados de acesso e jornada. A senha é gerenciada pelo Supabase Auth." /><div className="summary-cards"><div><span>Nome</span><strong>{profile.full_name || 'Sem nome cadastrado'}</strong></div><div><span>E-mail</span><strong>{profile.email || '—'}</strong></div><div><span>Perfil de acesso</span><strong>{ROLE_LABELS[profile.role] ?? profile.role}</strong></div></div><div className="calendar-lock-card"><strong>Minha jornada</strong><span>{currentSchedule ? `${formatMinutes(currentSchedule.daily_minutes)} por dia` : `${formatMinutes(DAILY_WORK_MINUTES)} por dia (padrão)`}</span><small>{currentSchedule ? `Dias: ${workDayLabels} · almoço mínimo ${currentSchedule.minimum_lunch_minutes} min · vigência ${currentSchedule.effective_from}` : 'Segunda a sexta · almoço mínimo de 60 min'}</small></div>{schedule.error && <ResultMessage error={schedule.error} />}<form className="management-form" onSubmit={changePassword}><h3>Alterar senha</h3><label className="management-field">Nova senha<input type="password" autoComplete="new-password" minLength="10" required value={password} onChange={(event) => setPassword(event.target.value)} /></label><label className="management-field">Confirme a nova senha<input type="password" autoComplete="new-password" minLength="10" required value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></label><div className="management-actions"><ActionButton type="submit" disabled={busy}>{busy ? 'Atualizando…' : 'Atualizar senha'}</ActionButton></div><ResultMessage message={feedback} error={error} /></form></section>;
}

function RequestsPanel({ profile }) {
  const [month, setMonth] = useState(monthValue());
  const [workDate, setWorkDate] = useState(localDateKey());
  const [kind, setKind] = useState('');
  const [punchId, setPunchId] = useState('');
  const [action, setAction] = useState('adjust');
  const [requestedAt, setRequestedAt] = useState('');
  const [reason, setReason] = useState('');
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const { start, end } = monthBounds(month);
  const requests = useAsyncData(() => listRequests(start, end), [start, end, refresh]);
  const punches = useAsyncData(() => listPunches(profile.id, workDate, workDate), [profile.id, workDate, refresh]);
  const ownRequests = requests.data.filter((request) => request.employee_id === profile.id);
  const selectedPunch = punches.data.find((punch) => punch.id === punchId);

  async function submit(event) {
    event.preventDefault(); setError(''); setFeedback('');
    try {
      await createChangeRequest({
        workDate,
        punchId: action === 'delete' || (action === 'adjust' && punchId) ? punchId : null,
        kind: selectedPunch?.kind ?? kind,
        at: action === 'delete' ? null : new Date(requestedAt).toISOString(),
        action,
        reason,
      });
      setFeedback('Solicitação enviada para análise.'); setReason(''); setPunchId(''); setKind(''); setRequestedAt('');
      setRefresh((value) => value + 1);
    } catch (reason) { setError(noticeFromError(reason)); }
  }

  return (
    <section className="management-section">
      <SectionHeading eyebrow="Ajustes com aprovação" title="Solicitações de ponto" description="As marcações originais não são apagadas. Ajustes e exclusões passam pela análise do gestor ou do Admin Master." />
      <form className="management-form" onSubmit={submit}>
        <h3>Nova solicitação</h3>
        <label className="management-field">Tipo<select value={action} onChange={(event) => { setAction(event.target.value); setPunchId(''); setKind(''); }}><option value="adjust">Ajustar ou incluir horário</option><option value="delete">Solicitar exclusão</option></select></label>
        <label className="management-field">Data<input type="date" required value={workDate} onChange={(event) => { setWorkDate(event.target.value); setPunchId(''); }} /></label>
        {action === 'delete' ? (
          <label className="management-field">Marcação<select required value={punchId} onChange={(event) => setPunchId(event.target.value)}><option value="">Selecione</option>{punches.data.map((punch) => <option key={punch.id} value={punch.id}>{PUNCH_LABELS[punch.kind]} · {formatClock(punch.punched_at)}</option>)}</select></label>
        ) : <>
          <label className="management-field">Marcação existente (deixe sem seleção para incluir uma marca faltante)<select value={punchId} onChange={(event) => { const value = event.target.value; setPunchId(value); setKind(punches.data.find((punch) => punch.id === value)?.kind ?? ''); }}><option value="">Incluir marca faltante</option>{punches.data.map((punch) => <option key={punch.id} value={punch.id}>{PUNCH_LABELS[punch.kind]} · {formatClock(punch.punched_at)}</option>)}</select></label>
          {!punchId && <label className="management-field">Tipo de marcação<select required value={kind} onChange={(event) => setKind(event.target.value)}><option value="">Selecione</option>{Object.entries(PUNCH_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}
          <label className="management-field">Horário solicitado<input type="datetime-local" required value={requestedAt} onChange={(event) => setRequestedAt(event.target.value)} /></label>
        </>}
        <label className="management-field management-field--wide">Justificativa<textarea required minLength="5" value={reason} onChange={(event) => setReason(event.target.value)} /></label>
        <div className="management-actions"><ActionButton type="submit">Enviar solicitação</ActionButton></div>
        <ResultMessage message={feedback} error={error} />
      </form>
      <div className="management-toolbar"><h3>Minhas solicitações</h3><MonthPicker value={month} onChange={setMonth} /></div>
      <RequestRows rows={ownRequests} profiles={[]} loading={requests.loading} />
      {requests.error && <ResultMessage error={requests.error} />}
    </section>
  );
}

function RequestRows({ rows, profiles, loading, onReview }) {
  const personById = new Map(profiles.map((profile) => [profile.id, profile]));
  return <div className="management-table-wrap"><table className="management-table"><thead><tr><th>Pessoa</th><th>Data</th><th>Pedido</th><th>Justificativa</th><th>Status</th><th>Decisão / ações</th></tr></thead><tbody>
    {rows.map((request) => <tr key={request.id}><td>{personById.get(request.employee_id)?.full_name || personById.get(request.employee_id)?.email || (profiles.length ? request.employee_id : 'Você')}</td><td>{request.work_date}</td><td>{request.action === 'delete' ? `Excluir ${PUNCH_LABELS[request.requested_kind] || 'marcação'}` : `${request.punch_id ? `Corrigir ${PUNCH_LABELS[request.requested_kind] || ''}` : `Incluir ${PUNCH_LABELS[request.requested_kind] || 'marcação'}`} ${request.requested_at ? `para ${formatClock(request.requested_at)}` : ''}`}</td><td>{request.reason}</td><td>{request.status === 'pending' ? 'Pendente' : request.status === 'approved' ? 'Aprovada' : 'Recusada'}</td><td>{request.status === 'pending' && onReview ? <span className="inline-actions"><button type="button" onClick={() => onReview(request, true)}>Aprovar</button><button type="button" onClick={() => onReview(request, false)}>Recusar</button></span> : request.review_note || (request.reviewed_at ? new Date(request.reviewed_at).toLocaleDateString('pt-BR') : '—')}</td></tr>)}
    {!loading && !rows.length && <tr><td colSpan="6">Nenhuma solicitação neste período.</td></tr>}
  </tbody></table></div>;
}

function TeamPanel({ profile, isAdmin }) {
  const people = useProfiles();
  const members = people.data.filter((person) => person.id !== profile.id && person.is_active);
  const [selectedId, setSelectedId] = useState('');
  const [month, setMonth] = useState(monthValue());
  const [absenceDate, setAbsenceDate] = useState(localDateKey());
  const [absenceEnd, setAbsenceEnd] = useState(localDateKey());
  const [absenceKind, setAbsenceKind] = useState('vacation');
  const [absenceNote, setAbsenceNote] = useState('');
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const { start, end } = monthBounds(month);
  const punches = useAsyncData(() => selectedId ? listPunches(selectedId, start, end) : Promise.resolve([]), [selectedId, start, end, refresh]);
  const absences = useAsyncData(() => listAbsences(start, end), [start, end, refresh]);
  const holidays = useAsyncData(() => listHolidays(start, end), [start, end, refresh]);
  const schedules = useAsyncData(() => selectedId ? listSchedules(selectedId) : Promise.resolve([]), [selectedId, refresh]);
  const employees = members;
  const names = new Map(people.data.map((person) => [person.id, person.full_name || person.email || person.id]));
  const personAbsences = absences.data.filter((absence) => absence.employee_id === selectedId);
  const summary = useMemo(() => summarizeMonth({ punches: punches.data, holidays: holidays.data, absences: personAbsences, schedules: schedules.data, start, end }), [punches.data, holidays.data, personAbsences, schedules.data, start, end]);
  const summaryLoading = punches.loading || holidays.loading || absences.loading || schedules.loading;

  async function saveAbsence(event) {
    event.preventDefault(); setError(''); setFeedback('');
    try { await recordAbsence({ employeeId: selectedId, kind: absenceKind, startsOn: absenceDate, endsOn: absenceEnd, note: absenceNote }); setFeedback('Ausência lançada. Os dias úteis cobertos contam como jornada completa.'); setAbsenceNote(''); setRefresh((value) => value + 1); }
    catch (reason) { setError(noticeFromError(reason)); }
  }

  return (
    <section className="management-section">
      <SectionHeading eyebrow={isAdmin ? 'Administração' : 'Equipe'} title={isAdmin ? 'Equipe e ocorrências' : 'Minha equipe'} description="Consulte marcações e saldos da sua equipe. Atestados e férias lançados aqui contam como jornada completa." />
      {people.error && <ResultMessage error={people.error} />}
      <div className="management-toolbar"><ProfilePicker profiles={employees} value={selectedId} onChange={setSelectedId} label="Pessoa da equipe" /><MonthPicker value={month} onChange={setMonth} /></div>
      {selectedId ? <>
        {(punches.error || holidays.error || absences.error || schedules.error) && <ResultMessage error={punches.error || holidays.error || absences.error || schedules.error} />}
        <div className="summary-cards"><div><span>Horas trabalhadas</span><strong>{summaryLoading ? '…' : formatMinutes(summary.worked)}</strong></div><div><span>Horas previstas</span><strong>{summaryLoading ? '…' : formatMinutes(summary.expected)}</strong></div><div><span>Saldo do mês</span><strong>{summaryLoading ? '…' : signedMinutes(summary.balance)}</strong></div></div>
        <div className="management-table-wrap"><table className="management-table"><thead><tr><th>Data</th><th>Marcação</th><th>Horário</th><th>Auditoria</th></tr></thead><tbody>
          {punches.data.map((punch) => <tr key={punch.id}><td>{punch.work_date}</td><td>{PUNCH_LABELS[punch.kind]}</td><td>{formatClock(punch.punched_at)}</td><td>{punch.was_corrected ? `Corrigido · original ${formatClock(punch.original_punched_at)}` : 'Original'}</td></tr>)}
          {!punches.loading && !punches.data.length && <tr><td colSpan="4">Sem marcações neste mês.</td></tr>}
        </tbody></table></div>
      </> : <p className="management-empty">Selecione um perfil ativo para consultar os dados.</p>}
      <div className="management-table-wrap"><table className="management-table"><thead><tr><th>Pessoa</th><th>Função</th><th>E-mail</th></tr></thead><tbody>
        {employees.map((person) => <tr key={person.id}><td>{person.full_name || 'Sem nome'}</td><td>{ROLE_LABELS[person.role]}</td><td>{person.email || '—'}</td></tr>)}
        {!people.loading && !employees.length && <tr><td colSpan="3">Nenhuma pessoa ativa abaixo do seu perfil.</td></tr>}
      </tbody></table></div>
      <form className="management-form" onSubmit={saveAbsence}>
        <h3>Lançar férias ou atestado</h3>
        <label className="management-field">Pessoa<select required value={selectedId} onChange={(event) => setSelectedId(event.target.value)}><option value="">Selecione</option>{employees.map((person) => <option key={person.id} value={person.id}>{person.full_name || person.email || person.id}</option>)}</select></label>
        <label className="management-field">Tipo<select value={absenceKind} onChange={(event) => setAbsenceKind(event.target.value)}><option value="vacation">Férias</option><option value="medical_certificate">Atestado</option></select></label>
        <label className="management-field">Início<input type="date" required value={absenceDate} onChange={(event) => setAbsenceDate(event.target.value)} /></label>
        <label className="management-field">Fim<input type="date" required min={absenceDate} value={absenceEnd} onChange={(event) => setAbsenceEnd(event.target.value)} /></label>
        <label className="management-field management-field--wide">Observação administrativa<textarea value={absenceNote} onChange={(event) => setAbsenceNote(event.target.value)} /><small>Não inclua diagnóstico ou detalhes médicos; registre apenas o necessário para a administração.</small></label>
        <div className="management-actions"><ActionButton type="submit" disabled={!selectedId}>Registrar ocorrência</ActionButton></div><ResultMessage message={feedback} error={error} />
      </form>
      <h3>Ocorrências do mês</h3>
      <div className="management-table-wrap"><table className="management-table"><thead><tr><th>Pessoa</th><th>Tipo</th><th>Período</th><th>Observação</th></tr></thead><tbody>
        {absences.data.map((absence) => <tr key={absence.id}><td>{names.get(absence.employee_id) || absence.employee_id}</td><td>{absence.kind === 'vacation' ? 'Férias' : 'Atestado'}</td><td>{absence.starts_on} – {absence.ends_on}</td><td>{absence.note || '—'}</td></tr>)}
        {!absences.loading && !absences.data.length && <tr><td colSpan="4">Nenhuma ocorrência no período.</td></tr>}
      </tbody></table></div>
    </section>
  );
}

function ApprovalsPanel({ profile, isAdmin }) {
  const people = useProfiles();
  const [month, setMonth] = useState(monthValue());
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const { start, end } = monthBounds(month);
  const requests = useAsyncData(() => listRequests(start, end), [start, end, refresh]);
  const visibleRows = requests.data.filter((request) => request.employee_id !== profile.id && request.status === 'pending' && (isAdmin || people.data.find((person) => person.id === request.employee_id)?.role === 'employee'));
  async function review(request, approve) {
    const note = window.prompt(approve ? 'Observação da aprovação (opcional):' : 'Informe o motivo da recusa:') ?? '';
    if (!approve && note.trim().length < 3) return;
    setError(''); setFeedback('');
    try { await reviewChangeRequest(request.id, approve, note); setFeedback(approve ? 'Solicitação aprovada.' : 'Solicitação recusada.'); setRefresh((value) => value + 1); }
    catch (reason) { setError(noticeFromError(reason)); }
  }
  return <section className="management-section"><SectionHeading eyebrow={isAdmin ? 'Admin Master' : 'Gestor'} title="Aprovações pendentes" description={isAdmin ? 'Inclui solicitações dos gestores e demais perfis.' : 'Solicitações dos perfis abaixo do seu na hierarquia.'} /><div className="management-toolbar"><MonthPicker value={month} onChange={setMonth} /></div><ResultMessage message={feedback} error={error || requests.error} />{people.error && <ResultMessage error={people.error} />}<RequestRows rows={visibleRows} profiles={people.data} loading={requests.loading} onReview={review} /></section>;
}

function AdminPeople({ profile }) {
  const people = useProfiles();
  const schedules = useAsyncData(listSchedules, [people.data.length]);
  const [selectedId, setSelectedId] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('employee');
  const [managerId, setManagerId] = useState('');
  const [dailyHours, setDailyHours] = useState('8.8');
  const [days, setDays] = useState(WEEKDAYS);
  const [effectiveFrom, setEffectiveFrom] = useState(localDateKey());
  const [isActive, setIsActive] = useState(true);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const managerOptions = people.data.filter((person) => ['manager', 'admin_master'].includes(person.role) && person.is_active && person.id !== selectedId);
  const selectedPerson = people.data.find((person) => person.id === selectedId);
  const selectedSchedule = schedules.data.find((item) => item.employee_id === selectedId);

  useEffect(() => {
    if (!selectedPerson) return;
    setFullName(selectedPerson.full_name || ''); setRole(selectedPerson.role); setManagerId(selectedPerson.manager_id || ''); setIsActive(selectedPerson.is_active);
    if (selectedSchedule) {
      setDailyHours(String(selectedSchedule.daily_minutes / 60)); setDays(selectedSchedule.work_days); setEffectiveFrom(selectedSchedule.effective_from);
    }
  }, [selectedId, selectedPerson?.full_name, selectedPerson?.role, selectedPerson?.manager_id, selectedPerson?.is_active, selectedSchedule?.daily_minutes, selectedSchedule?.minimum_lunch_minutes, selectedSchedule?.effective_from, selectedSchedule?.work_days]);

  async function createPerson(event) {
    event.preventDefault(); setBusy(true); setError(''); setFeedback('');
    try {
      const dailyMinutes = Math.round(Number(dailyHours) * 60);
      const created = await createAuthUser({ email, password, fullName, role, managerId, dailyMinutes, workDays: days, minimumLunchMinutes: 60, effectiveFrom });
      setFeedback(`Conta criada para ${created.email}.`); setPassword(''); setEmail(''); setFullName(''); setSelectedId(''); people.reload(); schedules.reload();
    } catch (reason) { setError(noticeFromError(reason)); }
    finally { setBusy(false); }
  }

  async function savePerson(event) {
    event.preventDefault(); if (!selectedId) return;
    if (selectedPerson?.role !== role && role === 'admin_master' && !window.confirm('Promover este perfil para Admin Master concede acesso administrativo completo. Deseja continuar?')) return;
    if (selectedPerson?.is_active && !isActive && !window.confirm('Desativar este perfil impedirá novos acessos, mas preservará os registros. Deseja continuar?')) return;
    setBusy(true); setError(''); setFeedback('');
    try {
      const dailyMinutes = Math.round(Number(dailyHours) * 60);
      await saveProfile({ id: selectedId, fullName, role, managerId, isActive, dailyMinutes, workDays: days, minimumLunchMinutes: 60, effectiveFrom });
      setFeedback('Perfil e jornada atualizados.'); people.reload(); schedules.reload();
    } catch (reason) { setError(noticeFromError(reason)); }
    finally { setBusy(false); }
  }

  function toggleWorkDay(day) {
    setDays((current) => current.includes(day) ? current.filter((item) => item !== day) : [...current, day].sort());
  }

  return <section className="management-section"><SectionHeading eyebrow="Acesso total" title="Pessoas e jornadas" description="Crie contas ou ajuste perfil, equipe e jornada. A desativação preserva os registros históricos." />
    {(people.error || schedules.error) && <ResultMessage error={people.error || schedules.error} />}
    <div className="management-table-wrap"><table className="management-table"><thead><tr><th>Nome</th><th>E-mail</th><th>Perfil</th><th>Gestor</th><th>Situação</th><th></th></tr></thead><tbody>{people.data.map((person) => <tr key={person.id}><td>{person.full_name || 'Sem nome'}</td><td>{person.email || '—'}</td><td>{ROLE_LABELS[person.role]}</td><td>{people.data.find((item) => item.id === person.manager_id)?.full_name || '—'}</td><td>{person.is_active ? 'Ativo' : 'Desativado'}</td><td><button type="button" onClick={() => setSelectedId(person.id)}>Editar</button></td></tr>)}</tbody></table></div>
    <form className="management-form" onSubmit={selectedId ? savePerson : createPerson}>
      <h3>{selectedId ? 'Editar perfil e jornada' : 'Criar conta de acesso'}</h3>
      <label className="management-field">Nome completo<input required value={fullName} onChange={(event) => setFullName(event.target.value)} /></label>
      {!selectedId && <label className="management-field">E-mail de acesso<input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>}
      {!selectedId && <label className="management-field">Senha temporária<input type="password" minLength="10" required value={password} onChange={(event) => setPassword(event.target.value)} /><small>Use uma senha temporária forte e oriente a pessoa a trocá-la após o primeiro acesso.</small></label>}
      <label className="management-field">Perfil<select value={role} onChange={(event) => setRole(event.target.value)}><option value="employee">Funcionário</option><option value="manager">Gestor</option><option value="admin_master">Admin Master</option></select></label>
      <label className="management-field">Gestor responsável<select value={managerId} onChange={(event) => setManagerId(event.target.value)}><option value="">Sem gestor direto</option>{managerOptions.map((person) => <option key={person.id} value={person.id}>{person.full_name || person.email}</option>)}</select></label>
      <label className="management-field">Jornada diária (horas decimais)<input type="number" min="0.02" max="24" step="0.01" required value={dailyHours} onChange={(event) => setDailyHours(event.target.value)} /><small>44h semanais em cinco dias = 8,8 horas por dia.</small></label>
      <label className="management-field">Vigência da jornada<input type="date" required value={effectiveFrom} onChange={(event) => setEffectiveFrom(event.target.value)} /></label>
      <fieldset className="management-field management-field--wide"><legend>Dias de trabalho</legend><div className="weekday-options">{[['Segunda',1],['Terça',2],['Quarta',3],['Quinta',4],['Sexta',5],['Sábado',6],['Domingo',7]].map(([label, day]) => <label key={day}><input type="checkbox" checked={days.includes(day)} onChange={() => toggleWorkDay(day)} />{label}</label>)}</div></fieldset>
      {selectedId && <label className="management-check management-field--wide"><input type="checkbox" checked={isActive} onChange={(event) => setIsActive(event.target.checked)} /> Perfil ativo</label>}
      <div className="management-actions"><ActionButton type="submit" disabled={busy || !days.length}>{busy ? 'Salvando…' : selectedId ? 'Salvar alterações' : 'Criar usuário'}</ActionButton>{selectedId && <ActionButton type="button" onClick={() => { setSelectedId(''); setFullName(''); setEmail(''); setPassword(''); setRole('employee'); setManagerId(''); setDays(WEEKDAYS); }}>Cancelar edição</ActionButton>}</div>
      <ResultMessage message={feedback} error={error} />
    </form>
  </section>;
}

function AdminCalendar() {
  const people = useProfiles();
  const [month, setMonth] = useState(monthValue());
  const [employeeId, setEmployeeId] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');
  const { start } = monthBounds(month);
  const canFinalizeMonth = month < monthValue();
  const locks = useAsyncData(() => listCalendarLocks(`${month}-01`, `${month}-01`), [month, refresh]);
  const closings = useAsyncData(() => listMonthlyClosings(start), [start, refresh]);
  const personLock = employeeId ? locks.data.find((item) => item.employee_id === employeeId) : null;
  const globalLock = locks.data.find((item) => item.employee_id === null);
  const selectedLock = employeeId ? (personLock ?? globalLock) : globalLock;
  const effectiveClosed = Boolean(globalLock?.is_closed || personLock?.is_closed);
  async function changeLock(isClosed) {
    setError(''); setFeedback('');
    if (!isClosed && employeeId && globalLock?.is_closed) {
      setError('O bloqueio global ainda está ativo. Reabra o período para toda a empresa primeiro.');
      return;
    }
    try { await setCalendarLock({ monthStart: start, employeeId, isClosed }); setFeedback(isClosed ? 'Período fechado para o escopo selecionado.' : 'Período reaberto para o escopo selecionado.'); setRefresh((value) => value + 1); }
    catch (reason) { setError(noticeFromError(reason)); }
  }
  async function finalizeMonth() {
    if (!window.confirm('Fechar o mês grava o saldo calculado para encaminhamento à folha. Confirmar fechamento?')) return;
    setError(''); setFeedback('');
    try {
      const count = await closeMonth(start, employeeId || null);
      setFeedback(`Fechamento mensal gravado para ${count} perfil(is), com saldo encaminhado para folha e zerado no próximo mês.`);
      setRefresh((value) => value + 1);
    } catch (reason) { setError(noticeFromError(reason)); }
  }
  return <section className="management-section"><SectionHeading eyebrow="Admin Master" title="Calendário e períodos" description="Bloqueie ou reabra marcações para a empresa inteira ou para uma pessoa. O fechamento mensal guarda o saldo encaminhado para folha." /><div className="management-toolbar"><MonthPicker value={month} onChange={setMonth} /><ProfilePicker profiles={people.data} value={employeeId} onChange={setEmployeeId} includeAll label="Escopo" /></div>{locks.error && <ResultMessage error={locks.error} />}{people.error && <ResultMessage error={people.error} />}<div className="calendar-lock-card"><strong>{effectiveClosed ? 'Fechado' : 'Aberto'}</strong><span>{employeeId ? 'Período individual' : 'Período da empresa'}</span><small>{selectedLock?.changed_at ? `Atualizado em ${new Date(selectedLock.changed_at).toLocaleString('pt-BR')}${employeeId && !personLock ? ' · bloqueio global herdado' : ''}` : 'Nenhum bloqueio registrado para este escopo.'}</small><div className="management-actions"><ActionButton type="button" onClick={() => changeLock(true)}>Bloquear marcações</ActionButton><ActionButton type="button" onClick={() => changeLock(false)} disabled={Boolean(employeeId && globalLock?.is_closed)}>Reabrir marcações</ActionButton><ActionButton type="button" onClick={finalizeMonth} disabled={!canFinalizeMonth}>Fechar mês e guardar saldo</ActionButton></div>{employeeId && globalLock?.is_closed && <small>Reabra o bloqueio global antes de reabrir uma pessoa específica.</small>}{!canFinalizeMonth && <small>O mês precisa terminar antes do fechamento e envio do saldo para folha.</small>}</div><ResultMessage message={feedback} error={error || closings.error} /><h3>Bloqueios cadastrados no mês</h3><div className="management-table-wrap"><table className="management-table"><thead><tr><th>Escopo</th><th>Situação</th><th>Alterado em</th></tr></thead><tbody>{locks.data.map((lock) => <tr key={lock.id}><td>{lock.employee_id ? people.data.find((person) => person.id === lock.employee_id)?.full_name || lock.employee_id : 'Toda a empresa'}</td><td>{lock.is_closed ? 'Fechado' : 'Aberto'}</td><td>{new Date(lock.changed_at).toLocaleString('pt-BR')}</td></tr>)}{!locks.loading && !locks.data.length && <tr><td colSpan="3">Nenhum bloqueio registrado neste mês.</td></tr>}</tbody></table></div><h3>Fechamentos gravados no mês</h3><div className="management-table-wrap"><table className="management-table"><thead><tr><th>Pessoa</th><th>Trabalhadas</th><th>Previstas</th><th>Saldo folha</th><th>Fechado em</th></tr></thead><tbody>{closings.data.filter((row) => !employeeId || row.employee_id === employeeId).map((row) => <tr key={row.employee_id}><td>{people.data.find((person) => person.id === row.employee_id)?.full_name || row.employee_id}</td><td>{formatMinutes(row.worked_minutes)}</td><td>{formatMinutes(row.expected_minutes)}</td><td>{signedMinutes(row.balance_minutes)}</td><td>{new Date(row.closed_at).toLocaleString('pt-BR')}</td></tr>)}{!closings.loading && !closings.data.length && <tr><td colSpan="5">Nenhum fechamento gravado.</td></tr>}</tbody></table></div></section>;
}

function AdminHolidays() {
  const [month, setMonth] = useState(monthValue());
  const [date, setDate] = useState('');
  const [name, setName] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');
  const { start } = monthBounds(month);
  const next = new Date(`${month}-01T00:00:00Z`); next.setUTCMonth(next.getUTCMonth() + 1); next.setUTCDate(0);
  const holidays = useAsyncData(() => listHolidays(start, next.toISOString().slice(0, 10)), [start, refresh]);
  async function save(event) { event.preventDefault(); setError(''); setFeedback(''); try { await setHoliday({ date, name }); setDate(''); setName(''); setFeedback('Feriado cadastrado para a empresa.'); setRefresh((value) => value + 1); } catch (reason) { setError(noticeFromError(reason)); } }
  async function remove(holiday) { setError(''); setFeedback(''); try { await setHoliday({ date: holiday.holiday_date, remove: true }); setFeedback('Feriado removido.'); setRefresh((value) => value + 1); } catch (reason) { setError(noticeFromError(reason)); } }
  async function importNationalYear() {
    setError(''); setFeedback('');
    try {
      const year = month.slice(0, 4);
      for (const [holidayDate, holidayName] of nationalHolidaysForYear(Number(year))) {
        await setHoliday({ date: holidayDate, name: holidayName });
      }
      setFeedback(`Feriados nacionais fixos de ${year} cadastrados.`); setRefresh((value) => value + 1);
    } catch (reason) { setError(noticeFromError(reason)); }
  }
  return <section className="management-section"><SectionHeading eyebrow="Admin Master" title="Feriados nacionais" description="Cadastre o calendário nacional usado para bloquear marcações e calcular a jornada prevista. O modelo inclui os feriados nacionais fixos e a Paixão de Cristo calculada para o ano selecionado." /><div className="management-toolbar"><MonthPicker value={month} onChange={setMonth} /><ActionButton type="button" onClick={importNationalYear}>Preencher feriados nacionais do ano</ActionButton></div><form className="management-form" onSubmit={save}><h3>Adicionar feriado</h3><label className="management-field">Data<input type="date" required value={date} onChange={(event) => setDate(event.target.value)} /></label><label className="management-field">Nome<input required minLength="3" value={name} onChange={(event) => setName(event.target.value)} placeholder="Ex.: Independência do Brasil" /></label><div className="management-actions"><ActionButton type="submit">Salvar feriado</ActionButton></div><ResultMessage message={feedback} error={error || holidays.error} /></form><div className="management-table-wrap"><table className="management-table"><thead><tr><th>Data</th><th>Feriado</th><th>Fonte</th><th></th></tr></thead><tbody>{holidays.data.map((holiday) => <tr key={holiday.holiday_date}><td>{holiday.holiday_date}</td><td>{holiday.name}</td><td>{holiday.source === 'admin' ? 'Cadastro da empresa' : holiday.source}</td><td><button type="button" onClick={() => remove(holiday)}>Remover</button></td></tr>)}{!holidays.loading && !holidays.data.length && <tr><td colSpan="4">Nenhum feriado cadastrado neste mês.</td></tr>}</tbody></table></div><p className="management-help">A lista segue o calendário anual do Governo Federal. Feriados estaduais e municipais ficam fora deste modelo e podem ser incluídos manualmente se a empresa decidir observá-los.</p></section>;
}

export default function ManagementPanel({ section, profile }) {
  const privileged = profile.role === 'manager' || profile.role === 'admin_master';
  const admin = profile.role === 'admin_master';
  if (section === 'historico') return <MyHistory profile={profile} />;
  if (section === 'perfil') return <MyProfile profile={profile} />;
  if (section === 'solicitacoes') return <RequestsPanel profile={profile} />;
  if (section === 'equipe' && privileged) return <TeamPanel profile={profile} isAdmin={admin} />;
  if (section === 'aprovacoes' && privileged) return <ApprovalsPanel profile={profile} isAdmin={admin} />;
  if (section === 'pessoas' && admin) return <AdminPeople profile={profile} />;
  if (section === 'calendario' && admin) return <AdminCalendar />;
  if (section === 'feriados' && admin) return <AdminHolidays />;
  return null;
}
