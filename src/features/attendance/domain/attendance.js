export const DAILY_WORK_MINUTES = 8 * 60 + 48;
export const MIN_LUNCH_MINUTES = 60;
export const COMPANY_TIME_ZONE = 'America/Sao_Paulo';

export const PUNCH_SEQUENCE = [
  { kind: 'start', label: 'Entrada expediente' },
  { kind: 'lunchStart', label: 'Início almoço' },
  { kind: 'lunchEnd', label: 'Fim almoço' },
  { kind: 'end', label: 'Fim expediente' },
];

export function createDayRecord() {
  return { punches: [] };
}

export function nextPunch(record) {
  return PUNCH_SEQUENCE[record.punches.length] ?? null;
}

export function addPunch(record, now = new Date()) {
  const expected = nextPunch(record);
  if (!expected) throw new Error('A jornada de hoje já foi encerrada.');

  if (expected.kind === 'lunchEnd') {
    const lunchStart = new Date(record.punches[1].at);
    const lunchDuration = Math.floor((now.getTime() - lunchStart.getTime()) / 60_000);
    if (lunchDuration < MIN_LUNCH_MINUTES) {
      const remaining = MIN_LUNCH_MINUTES - Math.max(0, lunchDuration);
      throw new Error(`O almoço mínimo é de 1 hora. Aguarde mais ${remaining} min.`);
    }
  }

  const lastPunch = record.punches.at(-1);
  if (lastPunch && now.getTime() <= new Date(lastPunch.at).getTime()) {
    throw new Error('O horário da nova marcação precisa ser posterior à anterior.');
  }

  return {
    ...record,
    punches: [...record.punches, { kind: expected.kind, at: now.toISOString() }],
  };
}

function elapsedMinutes(start, end) {
  return Math.max(0, Math.floor((new Date(end).getTime() - new Date(start).getTime()) / 60_000));
}

export function workedMinutes(record, now = new Date()) {
  const punches = record.punches;
  if (punches.length === 0) return 0;

  const beforeLunch = punches.length >= 2
    ? elapsedMinutes(punches[0].at, punches[1].at)
    : elapsedMinutes(punches[0].at, now);

  if (punches.length < 3) return beforeLunch;

  const afterLunch = punches.length >= 4
    ? elapsedMinutes(punches[2].at, punches[3].at)
    : elapsedMinutes(punches[2].at, now);

  return beforeLunch + afterLunch;
}

export function lunchMinutes(record, now = new Date()) {
  if (record.punches.length < 2) return 0;
  const lunchStart = record.punches[1].at;
  const lunchEnd = record.punches[2]?.at ?? now;
  return elapsedMinutes(lunchStart, lunchEnd);
}

export function estimatedEnd(record, now = new Date()) {
  if (record.punches.length === 0 || record.punches.length === 4) return null;

  let expectedLunch = MIN_LUNCH_MINUTES;
  if (record.punches.length === 2) expectedLunch = Math.max(MIN_LUNCH_MINUTES, lunchMinutes(record, now));
  if (record.punches.length >= 3) expectedLunch = lunchMinutes(record, now);

  const start = new Date(record.punches[0].at).getTime();
  return new Date(start + (DAILY_WORK_MINUTES + expectedLunch) * 60_000);
}

export function localDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: COMPANY_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function formatClock(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: COMPANY_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

export function formatMinutes(totalMinutes) {
  const safe = Math.max(0, Math.floor(totalMinutes));
  const hours = Math.floor(safe / 60);
  const minutes = safe % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}
