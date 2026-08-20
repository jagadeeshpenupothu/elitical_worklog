import {
  dateKeyFromValue,
  dateOrdinal,
} from "./dayViewProjection.js";
import {
  reportDateKey,
  reportRangeLabel,
} from "./reportModel.js";

const REPORT_DATE_PRESETS = new Set([
  "single",
  "this-week",
  "last-week",
  "this-month",
  "custom",
]);
const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function text(value) {
  return String(value ?? "").trim();
}

function validDateKey(value) {
  const key = reportDateKey(value);

  return dateOrdinal(key) === null ? "" : key;
}

function dateParts(dateKey) {
  const [year, month, day] = text(dateKey).split("-").map((part) => Number(part));

  if (![year, month, day].every(Number.isFinite)) return null;

  return { year, month, day };
}

function dateKeyFromOrdinal(ordinal) {
  return new Date(ordinal * 86400000).toISOString().slice(0, 10);
}

function addDays(dateKey, days) {
  const ordinal = dateOrdinal(dateKey);

  return ordinal === null ? "" : dateKeyFromOrdinal(ordinal + days);
}

function mondayForWeek(dateKey) {
  const ordinal = dateOrdinal(dateKey);

  if (ordinal === null) return "";

  const day = new Date(ordinal * 86400000).getUTCDay();
  const offset = day === 0 ? -6 : 1 - day;

  return dateKeyFromOrdinal(ordinal + offset);
}

function weekdayIndex(dateKey) {
  const ordinal = dateOrdinal(dateKey);

  return ordinal === null ? null : new Date(ordinal * 86400000).getUTCDay();
}

function monthLabel(dateKey) {
  const parts = dateParts(dateKey);

  if (!parts) return text(dateKey);

  return `${MONTH_LABELS[parts.month - 1] || ""} ${parts.year}`.trim();
}

function monthEndDateKey(dateKey) {
  const parts = dateParts(dateKey);

  if (!parts) return "";

  return new Date(Date.UTC(parts.year, parts.month, 0)).toISOString().slice(0, 10);
}

function range(preset, startDate, endDate, label = reportRangeLabel(startDate, endDate)) {
  return {
    preset,
    startDate,
    endDate,
    label,
  };
}

function errorRange(preset, error) {
  return {
    preset,
    startDate: "",
    endDate: "",
    label: "",
    error,
  };
}

export function resolveReportDateRange(options = {}, referenceDate = new Date()) {
  const preset = text(options.preset || "single");

  if (!REPORT_DATE_PRESETS.has(preset)) {
    return errorRange(preset, `Unsupported report date preset: ${preset || "(blank)"}.`);
  }

  if (preset === "single") {
    const date = validDateKey(options.date || options.startDate || referenceDate);

    return date
      ? range(preset, date, date)
      : errorRange(preset, "Single-date reports require a valid date.");
  }

  if (preset === "custom") {
    const startDate = validDateKey(options.startDate);
    const endDate = validDateKey(options.endDate);

    if (!startDate) return errorRange(preset, "Custom reports require a valid startDate.");
    if (!endDate) return errorRange(preset, "Custom reports require a valid endDate.");
    if (dateOrdinal(startDate) > dateOrdinal(endDate)) {
      return errorRange(preset, "Custom report startDate must be on or before endDate.");
    }

    return range(preset, startDate, endDate);
  }

  const referenceKey = validDateKey(referenceDate);

  if (!referenceKey) {
    return errorRange(preset, "Report date presets require a valid reference date.");
  }

  if (preset === "this-week") {
    // Business reports use the current work week: Monday through today,
    // capped at Friday when the reference date falls on a weekend.
    const startDate = mondayForWeek(referenceKey);
    const day = weekdayIndex(referenceKey);
    const endDate = day === 0 || day === 6 ? addDays(startDate, 4) : referenceKey;

    return range(preset, startDate, endDate);
  }

  if (preset === "last-week") {
    // Previous work week is always Monday through Friday.
    const thisMonday = mondayForWeek(referenceKey);
    const startDate = addDays(thisMonday, -7);
    const endDate = addDays(startDate, 4);

    return range(preset, startDate, endDate);
  }

  if (preset === "this-month") {
    const parts = dateParts(referenceKey);

    if (!parts) return errorRange(preset, "Month reports require a valid reference date.");

    const startDate = [
      parts.year,
      String(parts.month).padStart(2, "0"),
      "01",
    ].join("-");
    const endDate = monthEndDateKey(referenceKey);

    return range(preset, startDate, endDate, monthLabel(referenceKey));
  }

  return errorRange(preset, `Unsupported report date preset: ${preset}.`);
}

export function buildReportQuery(options = {}, referenceDate = new Date()) {
  const dateRange = resolveReportDateRange(options, referenceDate);

  return {
    startDate: dateRange.startDate,
    endDate: dateRange.endDate,
    employeeIds: Array.isArray(options.employeeIds) ? [...options.employeeIds] : [],
    teamId: options.teamId || null,
    preset: dateRange.preset,
    label: dateRange.label,
    ...(dateRange.error ? { error: dateRange.error } : {}),
  };
}

export { dateKeyFromValue as reportReferenceDateKey };
