const STORAGE_KEY = 'jornada-clara-attendance-v1';

export function readAttendance() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function writeAttendance(attendance) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(attendance));
}
