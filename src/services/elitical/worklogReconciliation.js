function firstText(...values) {
  const match = values.find(
    (value) => value !== undefined && value !== null && String(value).trim()
  );

  return match === undefined ? "" : String(match).trim();
}

function numericValue(value) {
  if (value === undefined || value === null || value === "") return 0;

  const number = Number(value);

  return Number.isFinite(number) ? number : 0;
}

function dateOnlyParts(value) {
  const match = String(value || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (!match) return null;

  const [, year, month, day] = match;

  return {
    year: Number(year),
    month: Number(month),
    day: Number(day),
  };
}

export function eliticalWorklogDateMillis(value) {
  if (value === undefined || value === null || value === "") return null;
  if (Number.isFinite(Number(value))) return Number(value);

  const text = String(value).trim();
  const dateOnly = dateOnlyParts(text);

  if (dateOnly) {
    return Date.UTC(dateOnly.year, dateOnly.month - 1, dateOnly.day);
  }

  const parsed = new Date(text);

  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}

export const millisFromWorklogDate = eliticalWorklogDateMillis;

function localDateKey(value) {
  const millis = eliticalWorklogDateMillis(value);

  if (!millis) return "";

  const date = new Date(millis);

  if (Number.isNaN(date.getTime())) return "";

  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function utcDateKey(value) {
  const millis = eliticalWorklogDateMillis(value);

  if (!millis) return "";

  const date = new Date(millis);

  if (Number.isNaN(date.getTime())) return "";

  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

export function worklogDurationMinutes(worklog = {}) {
  const totalMinutes = numericValue(
    worklog.timeMinutes ?? worklog.durationMinutes ?? worklog.loggedMinutes
  );

  if (totalMinutes) return totalMinutes;

  const hours = numericValue(worklog.hour ?? worklog.hours ?? worklog.loggedHours ?? worklog.duration);
  const minutes = numericValue(worklog.min ?? worklog.minutes);

  return Math.round(hours * 60 + minutes);
}

export function normalizedWorklogComment(worklog = {}) {
  return firstText(worklog.comment, worklog.description, worklog.note);
}

export function worklogDocketId(worklog = {}) {
  return firstText(worklog.docketId, worklog.docket?.id);
}

export function worklogDateKeys(value) {
  return {
    millis: eliticalWorklogDateMillis(value),
    local: localDateKey(value),
    utc: utcDateKey(value),
  };
}

function isUtcMidnightMillis(value) {
  const millis = eliticalWorklogDateMillis(value);

  if (!millis) return false;

  const date = new Date(millis);

  return (
    date.getUTCHours() === 0 &&
    date.getUTCMinutes() === 0 &&
    date.getUTCSeconds() === 0 &&
    date.getUTCMilliseconds() === 0
  );
}

export function worklogDatesSemanticallyMatch(candidateDate, expectedDate) {
  const candidate = worklogDateKeys(candidateDate);
  const expected = worklogDateKeys(expectedDate);

  if (!candidate.millis || !expected.millis) return false;
  if (Number(candidate.millis) === Number(expected.millis)) return true;
  if (candidate.local && candidate.local === expected.local) return true;

  // Elitical stores date-only worklog values as timezone-normalized timestamps.
  // The UTC calendar day remains stable for the observed native Worklog DTOs.
  return Boolean(candidate.utc && candidate.utc === expected.utc);
}

export function worklogUpdateDatesConfirm(candidateDate, expectedDate) {
  const candidate = worklogDateKeys(candidateDate);
  const expected = worklogDateKeys(expectedDate);

  if (!candidate.millis || !expected.millis) return false;
  if (Number(candidate.millis) === Number(expected.millis)) return true;

  return Boolean(
    isUtcMidnightMillis(expected.millis) &&
    candidate.utc &&
    candidate.utc === expected.utc
  );
}

export function worklogMatchesForReconciliation(candidate = {}, expected = {}) {
  const candidateDocketId = worklogDocketId(candidate);
  const expectedDocketId = worklogDocketId(expected);
  const candidateComment = normalizedWorklogComment(candidate);
  const expectedComment = normalizedWorklogComment(expected);
  const candidateDate = firstText(candidate.worklogDate, candidate.date, candidate.createdDate);
  const expectedDate = firstText(expected.worklogDate, expected.date, expected.createdDate);

  return (
    Boolean(candidateDocketId) &&
    candidateDocketId === expectedDocketId &&
    candidateComment === expectedComment &&
    worklogDurationMinutes(candidate) === worklogDurationMinutes(expected) &&
    worklogDatesSemanticallyMatch(candidateDate, expectedDate)
  );
}

export function selectUniqueWorklogReconciliationMatch(candidates = [], expected = {}) {
  const matches = candidates.filter((candidate) =>
    worklogMatchesForReconciliation(candidate, expected)
  );

  return matches.length === 1 ? matches[0] : null;
}
