import assert from "node:assert/strict";

import {
  renderReportEmail,
  renderReportText,
  renderReportTsv,
} from "../src/utils/reportRenderers.js";

const report = {
  range: {
    startDate: "2026-08-11",
    endDate: "2026-08-14",
    label: "Tue, 11 Aug - Fri, 14 Aug 2026",
  },
  members: [
    {
      employeeId: "employee-empty",
      name: "Empty Member",
      days: [],
      totalMinutes: 0,
    },
    {
      employeeId: "employee-sashank",
      name: "Sashank",
      days: [
        {
          dateKey: "2026-08-11",
          dayLabel: "Tue (11 Aug)",
          entries: [
            {
              worklogId: "wl-sashank-2",
              employeeId: "employee-sashank",
              employeeName: "Sashank",
              docketId: "job-sashank-2",
              docketNumber: "DES-703",
              docketTitle: "Campaign export",
              docketType: "job",
              sprintName: "UX Designer -17",
              state: "design",
              description: "Generated export variants",
              durationMinutes: 45,
              startTime: "14:00",
            },
            {
              worklogId: "wl-sashank-1",
              employeeId: "employee-sashank",
              employeeName: "Sashank",
              docketId: "job-sashank-1",
              docketNumber: "DES-702",
              docketTitle: "Awareness poster",
              docketType: "job",
              sprintName: "UX Designer -17",
              state: "design",
              description: "Designed SaYukth Day 1 poster",
              durationMinutes: 120,
              startTime: "09:30",
            },
          ],
          totalMinutes: 165,
        },
      ],
      totalMinutes: 165,
    },
    {
      employeeId: "employee-jag",
      name: "Jagadeesh",
      days: [
        {
          dateKey: "2026-08-12",
          dayLabel: "Wed (12 Aug)",
          entries: [
            {
              worklogId: "wl-jag-3",
              employeeId: "employee-jag",
              employeeName: "Jagadeesh",
              docketId: "job-jag-3",
              docketNumber: "DES-704",
              docketTitle: "Spreadsheet-safe work",
              docketType: "job",
              sprintName: "UX Designer -17",
              state: "in-review",
              description: "Reviewed copy\nUpdated CTA\tspacing",
              durationMinutes: 30,
              startTime: "13:00",
            },
          ],
          totalMinutes: 30,
        },
        {
          dateKey: "2026-08-11",
          dayLabel: "Tue (11 Aug)",
          entries: [
            {
              worklogId: "wl-jag-2",
              employeeId: "employee-jag",
              employeeName: "Jagadeesh",
              docketId: "job-jag-2",
              docketNumber: "DES-701",
              docketTitle: "Technology social post",
              docketType: "job",
              sprintName: "UX Designer -17",
              state: "design",
              description: "Reviewed final poster",
              durationMinutes: 30,
              startTime: "14:00",
            },
            {
              worklogId: "wl-jag-1",
              employeeId: "employee-jag",
              employeeName: "Jagadeesh",
              docketId: "job-jag-1",
              docketNumber: "DES-700",
              docketTitle: "Technology social post",
              docketType: "job",
              sprintName: "UX Designer -17",
              state: "design",
              description: "Designed technology post",
              durationMinutes: 120,
              startTime: "10:00",
            },
          ],
          totalMinutes: 150,
        },
      ],
      totalMinutes: 180,
    },
  ],
  totals: {
    worklogCount: 5,
    durationMinutes: 345,
  },
};
const options = {
  teamName: "UX Designer Team",
  senderName: "Jagadeesh P",
  senderContact: "+91 9121154724",
  greeting: "Dear Sir,",
  periodName: "this week",
};

const email = renderReportEmail(report, options);
assert.equal(
  email.subject,
  "UX Designer Team Work Update [Tue, 11 Aug - Fri, 14 Aug 2026]",
  "email subject exists and uses bracketed date label"
);
assert.match(email.subject, /\[/, "email subject contains opening date bracket");
assert.match(email.subject, /\]$/, "email subject contains closing date bracket");
assert.doesNotMatch(
  email.subject,
  /Work Update - Tue, 11 Aug - Fri, 14 Aug 2026/,
  "email subject does not use old hyphen date range format"
);
assert.match(email.body, /Dear Sir,/);
assert.match(
  email.body,
  /Please find below the UX Designer Team work update for this week \(Tue, 11 Aug - Fri, 14 Aug 2026\)\./
);
assert.match(email.body, /^Jagadeesh$/m, "employee names render as plain headings");
assert.match(email.body, /^Sashank$/m, "employee names render as plain headings");
assert.doesNotMatch(email.body, /^Empty Member$/m, "empty employees are omitted from email output");
assert.match(email.body, /^Tue \(11 Aug\)$/m, "dates render as plain headings");
assert.match(email.body, /^Wed \(12 Aug\)$/m, "dates render as plain headings");
assert.match(email.body, /Jagadeesh\nTue \(11 Aug\)\n- Designed technology post/, "no blank line appears between employee, date, and first bullet");
assert.match(email.body, /Reviewed final poster\n\nWed \(12 Aug\)\n- Reviewed copy/, "one blank line appears between dates");
assert.match(email.body, /Reviewed copy\nUpdated CTA\tspacing\n\nSashank\nTue \(11 Aug\)/, "one blank line appears between employee sections");
assert.match(email.body, /- Designed technology post/);
assert.match(email.body, /- Designed SaYukth Day 1 poster/);
assert.doesNotMatch(email.body, /No worklog entries for the selected period\./);
assert.doesNotMatch(email.body, /###/, "email body has no Markdown headings");
assert.doesNotMatch(email.body, /\*\*/, "email body has no Markdown bold markers");
assert.doesNotMatch(email.body, /Subject:/, "email body does not include subject prefix");
assert.doesNotMatch(email.body, /<\/?[a-z][^>]*>/i, "plain email body does not expose HTML tags");
assert.doesNotMatch(email.body, /Published imaginary redesign/, "email does not fabricate descriptions");
assert.doesNotMatch(email.body, /DES-700 \| Technology social post \| 120/, "email bullets do not become database exports");
assert.doesNotMatch(email.body, /Thanks & Regards/, "email body does not include signature greeting");
assert.doesNotMatch(email.body, /Jagadeesh P \| \+91 9121154724/, "email body does not include sender signature");
assert.ok(
  email.body.endsWith("- Generated export variants"),
  "email body ends with the final worklog bullet"
);
assert.match(email.html, /<strong>Jagadeesh<\/strong>/, "employee names are bold in rich email output");
assert.match(email.html, /<strong>Sashank<\/strong>/, "employee names are bold in rich email output");
assert.match(email.html, /<strong>Tue \(11 Aug\)<\/strong>/, "date headings are bold in rich email output");
assert.match(email.html, /<strong>Wed \(12 Aug\)<\/strong>/, "date headings are bold in rich email output");
assert.doesNotMatch(email.html, /<strong>- Designed technology post<\/strong>/, "worklog bullets remain normal weight in rich email output");
assert.doesNotMatch(email.html, /Thanks & Regards/, "rich email output does not include signature greeting");
assert.doesNotMatch(email.html, /Jagadeesh P \| \+91 9121154724/, "rich email output does not include sender signature");

const textOutput = renderReportText(report, options);
assert.match(textOutput, /Please find below the UX Designer Team work update/);
assert.match(textOutput, /Jagadeesh/);
assert.match(textOutput, /Sashank/);
assert.match(textOutput, /Designed technology post/);
assert.match(textOutput, /Designed SaYukth Day 1 poster/);
assert.doesNotMatch(textOutput, /\*\*/, "plain text output has no Markdown bold syntax");

const tsv = renderReportTsv(report, options);
const rows = tsv.split("\n");
assert.equal(
  rows[0],
  "Date\tDay\tEmployee\tEmployee ID\tDocket ID\tDocket Title\tDocket Type\tSprint\tState\tDescription\tDuration (Minutes)\tStart Time",
  "TSV header is exact"
);
assert.equal(rows.length, 6, "TSV has one header plus one row per worklog");
assert.ok(rows.every((row) => row.split("\t").length === 12), "TSV rows keep a stable column count");
assert.match(rows[1], /^2026-08-11\tTue \(11 Aug\)\tJagadeesh/, "TSV sorts by employee/date/start time");
assert.match(rows[2], /^2026-08-11\tTue \(11 Aug\)\tJagadeesh/);
assert.match(rows[3], /^2026-08-12\tWed \(12 Aug\)\tJagadeesh/);
assert.match(rows[4], /^2026-08-11\tTue \(11 Aug\)\tSashank/);
assert.match(rows[5], /^2026-08-11\tTue \(11 Aug\)\tSashank/);
assert.match(tsv, /Reviewed copy Updated CTA spacing/, "TSV sanitizes embedded newline and tab characters");
assert.doesNotMatch(tsv, /Reviewed copy\nUpdated CTA\tspacing/, "TSV does not allow embedded row or cell breaks");
assert.match(tsv, /DES-700/);
assert.match(tsv, /UX Designer -17/);
assert.match(tsv, /\t120\t10:00/);

const emptyReport = {
  range: {
    startDate: "2026-08-14",
    endDate: "2026-08-14",
    label: "Fri, 14 Aug 2026",
  },
  members: [],
  totals: {
    worklogCount: 0,
    durationMinutes: 0,
  },
};
const emptyEmail = renderReportEmail(emptyReport, options);
const emptyText = renderReportText(emptyReport, options);
const emptyTsv = renderReportTsv(emptyReport, options);

assert.match(emptyEmail.body, /No worklog entries were recorded for the selected period\./);
assert.doesNotMatch(emptyEmail.body, /Thanks & Regards/);
assert.doesNotMatch(emptyEmail.body, /Jagadeesh P \| \+91 9121154724/);
assert.ok(
  emptyEmail.body.endsWith("No worklog entries were recorded for the selected period."),
  "empty email ends after the empty-report message"
);
assert.match(emptyText, /No worklog entries were recorded for the selected period\./);
assert.equal(emptyTsv.split("\n").length, 1, "empty TSV still returns a header row");

console.log("Report renderer verification PASS");
