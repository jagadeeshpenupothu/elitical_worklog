export const WORKDAY_MINUTES = 8 * 60;

function safeWholeMinutes(minutes) {
  return Math.max(0, Math.round(Number(minutes) || 0));
}

function clockDuration(minutes) {
  const safeMinutes = safeWholeMinutes(minutes);
  const hours = Math.floor(safeMinutes / 60);
  const remainingMinutes = safeMinutes % 60;

  return [
    String(hours).padStart(2, "0"),
    String(remainingMinutes).padStart(2, "0"),
  ].join(":");
}

export function formatWorkDuration(minutes) {
  const safeMinutes = safeWholeMinutes(minutes);

  return clockDuration(safeMinutes);
}

export function workdayEquivalent(minutes) {
  const safeMinutes = safeWholeMinutes(minutes);

  return safeMinutes / WORKDAY_MINUTES;
}
