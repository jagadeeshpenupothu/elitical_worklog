const DEFAULT_REPORT_RENDER_OPTIONS = {
  teamName: "UX Designer Team",
  senderName: "Jagadeesh P",
  senderContact: "+91 9121154724",
  greeting: "Dear Sir,",
  periodName: "selected period",
};
const TSV_COLUMNS = [
  "Date",
  "Day",
  "Employee",
  "Employee ID",
  "Docket ID",
  "Docket Title",
  "Docket Type",
  "Sprint",
  "State",
  "Description",
  "Duration (Minutes)",
  "Start Time",
];

function text(value) {
  return String(value ?? "").trim();
}

function renderOptions(options = {}) {
  return {
    ...DEFAULT_REPORT_RENDER_OPTIONS,
    ...options,
  };
}

function rangeLabel(report = {}) {
  return text(report.range?.label) || [report.range?.startDate, report.range?.endDate]
    .map(text)
    .filter(Boolean)
    .join(" - ");
}

function memberName(member = {}) {
  return text(member.name) || text(member.employeeId) || "Unknown Employee";
}

function entryDescription(entry = {}) {
  return text(entry.description) || text(entry.docketTitle) || text(entry.docketId) || "Worklog entry";
}

function escapeHtml(value) {
  return text(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function signatureLine(options) {
  return [options.senderName, options.senderContact].map(text).filter(Boolean).join(" | ");
}

function emailPeriodPhrase(periodName) {
  const period = text(periodName) || "selected period";

  return /^(this|last)\b/i.test(period) ? period : `the ${period}`;
}

function sortedMembers(report = {}) {
  return [...(report.members || [])].sort((first, second) =>
    [
      memberName(first).toLowerCase(),
      text(first.employeeId).toLowerCase(),
    ].join("\u0000").localeCompare([
      memberName(second).toLowerCase(),
      text(second.employeeId).toLowerCase(),
    ].join("\u0000"))
  );
}

function sortedDays(member = {}) {
  return [...(member.days || [])].sort((first, second) =>
    text(first.dateKey).localeCompare(text(second.dateKey))
  );
}

function entrySortKey(entry = {}) {
  return [
    text(entry.startTime),
    text(entry.docketNumber || entry.docketId).toLowerCase(),
    text(entry.docketTitle).toLowerCase(),
    text(entry.worklogId).toLowerCase(),
  ].join("\u0000");
}

function sortedEntries(day = {}) {
  return [...(day.entries || [])].sort((first, second) =>
    entrySortKey(first).localeCompare(entrySortKey(second))
  );
}

function reportHasEntries(report = {}) {
  return (report.members || []).some((member) =>
    (member.days || []).some((day) => (day.entries || []).length > 0)
  );
}

function renderMemberEmail(member = {}) {
  const lines = [memberName(member)];
  const days = sortedDays(member).filter((day) => sortedEntries(day).length > 0);

  if (days.length === 0) return [];

  days.forEach((day, index) => {
    if (index > 0) lines.push("");
    lines.push(text(day.dayLabel) || text(day.dateKey));
    sortedEntries(day).forEach((entry) => {
      lines.push(`- ${entryDescription(entry)}`);
    });
  });

  return lines;
}

function htmlLine(value, { bold = false } = {}) {
  const content = bold ? `<strong>${escapeHtml(value)}</strong>` : escapeHtml(value);

  return `<div>${content}</div>`;
}

function htmlBlankLine() {
  return "<div><br></div>";
}

function renderMemberEmailHtml(member = {}) {
  const days = sortedDays(member).filter((day) => sortedEntries(day).length > 0);

  if (days.length === 0) return [];

  const lines = [htmlLine(memberName(member), { bold: true })];

  days.forEach((day, index) => {
    if (index > 0) lines.push(htmlBlankLine());
    lines.push(htmlLine(text(day.dayLabel) || text(day.dateKey), { bold: true }));
    sortedEntries(day).forEach((entry) => {
      lines.push(htmlLine(`- ${entryDescription(entry)}`));
    });
  });

  return lines;
}

function renderMemberPlainText(member = {}) {
  const lines = [memberName(member), ""];
  const days = sortedDays(member).filter((day) => sortedEntries(day).length > 0);

  if (days.length === 0) {
    lines.push("No worklog entries for the selected period.");
    return lines;
  }

  days.forEach((day, index) => {
    if (index > 0) lines.push("");
    lines.push(text(day.dayLabel) || text(day.dateKey), "");
    sortedEntries(day).forEach((entry) => {
      lines.push(`- ${entryDescription(entry)}`);
    });
  });

  return lines;
}

function compactLines(lines) {
  const next = [];

  lines.forEach((line) => {
    if (line || next[next.length - 1] !== "") next.push(line);
  });

  while (next[next.length - 1] === "") next.pop();

  return next.join("\n");
}

export function renderReportEmail(report = {}, options = {}) {
  const config = renderOptions(options);
  const label = rangeLabel(report);
  const subject = `${config.teamName} Work Update [${label}]`;
  const intro = `Please find below the ${config.teamName} work update for ${emailPeriodPhrase(config.periodName)} (${label}).`;
  const lines = [
    config.greeting,
    "",
    intro,
    "",
  ];
  const htmlLines = [
    htmlLine(config.greeting),
    htmlBlankLine(),
    htmlLine(intro),
    htmlBlankLine(),
  ];

  if (!reportHasEntries(report)) {
    lines.push("No worklog entries were recorded for the selected period.", "");
    htmlLines.push(htmlLine("No worklog entries were recorded for the selected period."));
  } else {
    let renderedMemberCount = 0;

    sortedMembers(report).forEach((member) => {
      const memberLines = renderMemberEmail(member);
      const memberHtmlLines = renderMemberEmailHtml(member);

      if (memberLines.length === 0) return;
      if (renderedMemberCount > 0) lines.push("");
      if (renderedMemberCount > 0) htmlLines.push(htmlBlankLine());
      lines.push(...memberLines, "");
      htmlLines.push(...memberHtmlLines);
      renderedMemberCount += 1;
    });
  }

  return {
    subject,
    body: compactLines(lines),
    html: htmlLines.join(""),
  };
}

export function renderReportText(report = {}, options = {}) {
  const config = renderOptions(options);
  const label = rangeLabel(report);
  const lines = [
    config.greeting,
    "",
    `Please find below the ${config.teamName} work update for the ${config.periodName} (${label}).`,
    "",
  ];

  if (!reportHasEntries(report)) {
    lines.push("No worklog entries were recorded for the selected period.", "");
  } else {
    sortedMembers(report).forEach((member, index) => {
      if (index > 0) lines.push("");
      lines.push(...renderMemberPlainText(member), "");
    });
  }

  lines.push("--", "", "Thanks & Regards");

  const signature = signatureLine(config);
  if (signature) lines.push("", signature);

  return compactLines(lines);
}

function tsvValue(value) {
  return text(value)
    .replace(/\t/g, " ")
    .replace(/\r\n/g, " ")
    .replace(/\n/g, " ")
    .replace(/\r/g, " ");
}

function tsvRows(report = {}) {
  const rows = [];

  sortedMembers(report).forEach((member) => {
    sortedDays(member).forEach((day) => {
      sortedEntries(day).forEach((entry) => {
        rows.push({
          member,
          day,
          entry,
        });
      });
    });
  });

  return rows.sort((first, second) =>
    [
      memberName(first.member).toLowerCase(),
      text(first.member.employeeId).toLowerCase(),
      text(first.day.dateKey),
      text(first.entry.startTime),
      text(first.entry.docketNumber || first.entry.docketId).toLowerCase(),
      text(first.entry.worklogId).toLowerCase(),
    ].join("\u0000").localeCompare([
      memberName(second.member).toLowerCase(),
      text(second.member.employeeId).toLowerCase(),
      text(second.day.dateKey),
      text(second.entry.startTime),
      text(second.entry.docketNumber || second.entry.docketId).toLowerCase(),
      text(second.entry.worklogId).toLowerCase(),
    ].join("\u0000"))
  );
}

export function renderReportTsv(report = {}) {
  const lines = [TSV_COLUMNS.join("\t")];

  tsvRows(report).forEach(({ member, day, entry }) => {
    lines.push([
      day.dateKey,
      day.dayLabel,
      memberName(member),
      member.employeeId,
      entry.docketNumber || entry.docketId,
      entry.docketTitle,
      entry.docketType,
      entry.sprintName || entry.sprintId,
      entry.state,
      entryDescription(entry),
      Number.isFinite(Number(entry.durationMinutes)) ? entry.durationMinutes : "",
      entry.startTime,
    ].map(tsvValue).join("\t"));
  });

  return lines.join("\n");
}
