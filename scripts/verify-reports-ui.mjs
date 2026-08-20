import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const appSource = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const appCssSource = readFileSync(new URL("../src/App.css", import.meta.url), "utf8");
const reportDateRangeSource = readFileSync(
  new URL("../src/utils/reportDateRange.js", import.meta.url),
  "utf8"
);
const reportModelSource = readFileSync(
  new URL("../src/utils/reportModel.js", import.meta.url),
  "utf8"
);
const reportRenderersSource = readFileSync(
  new URL("../src/utils/reportRenderers.js", import.meta.url),
  "utf8"
);

function countMatches(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

assert.match(
  appSource,
  /\{\s*id:\s*"reports",\s*label:\s*"Reports"\s*\}/,
  "Reports navigation entry exists in APP_VIEWS"
);
assert.match(appSource, /viewMode === "reports"/, "Reports view routing exists");
assert.match(appSource, /<ReportsView\b/, "ReportsView is rendered from the main app");

assert.match(appSource, /from "\.\/utils\/reportDateRange"/, "Reports UI imports reportDateRange.js");
assert.match(appSource, /\bresolveReportDateRange\(/, "Reports UI resolves ranges through Phase 2 utilities");
assert.match(appSource, /\bbuildReportQuery\(/, "Reports UI builds report queries through Phase 2 utilities");

assert.match(appSource, /from "\.\/utils\/reportModel"/, "Reports UI imports reportModel.js");
assert.match(appSource, /\bgenerateReportModel\(/, "Reports UI uses the canonical report model");

assert.match(appSource, /from "\.\/utils\/reportRenderers"/, "Reports UI imports reportRenderers.js");
assert.match(appSource, /\brenderReportEmail\(/, "Reports UI uses the email renderer");
assert.match(appSource, /\brenderReportText\(/, "Reports UI uses the TXT renderer");
assert.match(appSource, /\brenderReportTsv\(/, "Reports UI uses the Google Sheets TSV renderer");

assert.match(appSource, /Single Date/, "Single Date preset is present");
assert.match(appSource, /This Week/, "This Week preset is present");
assert.match(appSource, /Last Week/, "Last Week preset is present");
assert.match(appSource, /This Month/, "This Month preset is present");
assert.match(appSource, /Custom Range/, "Custom Range preset is present");

assert.match(appSource, /All Team Members/, "All Team Members selection is present");
assert.match(appSource, /employeeDirectory/, "Reports UI consumes the employee directory");
assert.match(
  appSource,
  /UX_DESIGNER_REPORT_EMPLOYEE_IDS = new Set\(\[/,
  "Reports UI uses a stable employee-ID allow-list for the UX Designer team"
);
assert.match(
  appSource,
  /97a233c1-0999-4c56-9164-6e3ab2edde57/,
  "Jagadeesh stable employee ID is included in the Reports team"
);
assert.match(
  appSource,
  /13b71512-ccd5-4845-891e-3d279b18d168/,
  "Sashank stable employee ID is included in the Reports team"
);
assert.match(
  appSource,
  /UX_DESIGNER_REPORT_EMPLOYEE_IDS\.has\(employee\.employeeId\)/,
  "Reports employee checkboxes are restricted by stable employee ID"
);
assert.match(
  appSource,
  /allTeamMembers\s*\?\s*employeeOptions\.map\(\(employee\) => employee\.employeeId\)/,
  "All Team Members passes only the configured UX Designer employee IDs"
);
assert.match(appSource, /navigator\.clipboard\.writeText/, "Reports UI copies via clipboard");
assert.doesNotMatch(appSource, />\s*Copy Subject\s*</, "Old Copy Subject button text is removed");
assert.doesNotMatch(appSource, />\s*Copy Email\s*</, "Old Copy Email button text is removed");
assert.match(appSource, /function ReportsCopyIconButton/, "Reports Email uses compact copy icon buttons");
assert.match(appSource, /label="Copy subject"/, "Subject copy icon has an accessible label");
assert.match(appSource, /label="Copy email"/, "Body copy icon has an accessible label");
assert.match(appSource, /copiedTarget === "email-subject"/, "Subject icon has copied/check feedback state");
assert.match(appSource, /copiedTarget === "email-body"/, "Body icon has copied/check feedback state");
assert.match(
  appSource,
  /copyReportContent\(\s*"Subject",\s*generated\.email\.subject,\s*"",\s*"email-subject"\s*\)/,
  "Copy Subject copies only the generated subject"
);
assert.match(appSource, /Copy TXT/, "TXT copy action exists");
assert.match(appSource, /Copy for Google Sheets/, "Google Sheets copy action exists");
assert.match(
  appSource,
  /No worklog entries found for the selected period\./,
  "Reports UI shows the requested no-worklog empty state"
);
assert.match(
  appSource,
  /if \(outputTab === "email"\) return generated\.email\.body;/,
  "Copy Email payload uses only the generated email body"
);
assert.match(appSource, /new ClipboardItem/, "Copy Email can write rich clipboard content");
assert.match(appSource, /"text\/html": new Blob\(\[htmlValue\]/, "Copy Email writes an HTML clipboard representation");
assert.match(appSource, /"text\/plain": new Blob\(\[value\]/, "Copy Email writes a plain-text clipboard fallback");
assert.match(appCssSource, /\.reports-copy-icon-button/, "Reports copy icon button CSS exists");
assert.match(appCssSource, /\.reports-copy-icon-button\.copied/, "Reports copy icon has copied-state styling");
assert.doesNotMatch(
  appSource,
  /Subject: \$\{generated\.email\.subject\}/,
  "Copy Email payload does not prepend the subject"
);
assert.doesNotMatch(appSource, /reports-summary-grid/, "Generated Reports output does not render summary cards");
assert.doesNotMatch(appSource, /<span>Period<\/span>/, "Period summary card is removed");
assert.doesNotMatch(appSource, /<span>Employees<\/span>/, "Employees summary card is removed");
assert.doesNotMatch(appSource, /<span>Worklog Entries<\/span>/, "Worklog Entries summary card is removed");
assert.doesNotMatch(appSource, /<span>Total Logged Time<\/span>/, "Total Logged Time summary card is removed");
assert.doesNotMatch(appCssSource, /\.reports-summary-grid/, "Reports summary grid CSS is removed");
assert.match(
  appSource,
  /reports-output-panel reports-output-panel-email/,
  "Email output panel has a dedicated flexible layout hook"
);
assert.match(
  appSource,
  /reports-field reports-body-field/,
  "Email body field has a dedicated flexible layout hook"
);
assert.match(
  appSource,
  /dangerouslySetInnerHTML=\{\{ __html: generated\.email\.html \}\}/,
  "Email body preview renders the rich email output"
);
assert.doesNotMatch(
  appSource,
  /reports-output-panel reports-output-panel-email[\s\S]*<textarea[\s\S]*generated\.email\.body[\s\S]*<\/div>\s*\) : null}/,
  "Email body is not rendered in a textarea"
);
assert.match(appCssSource, /\.reports-view\s*\{[\s\S]*overflow: hidden;/, "Reports view constrains page scrolling");
assert.match(appCssSource, /\.reports-layout\s*\{[\s\S]*min-height: 0;/, "Reports layout consumes remaining height");
assert.match(appCssSource, /\.reports-layout\s*\{[\s\S]*align-items: start;/, "Reports layout does not stretch the left filter column");
assert.match(appCssSource, /\.reports-controls\s*\{[\s\S]*align-self: start;/, "Reports filter panel remains content-sized");
assert.match(appCssSource, /\.reports-output\s*\{[\s\S]*height: 100%;/, "Reports output fills its column");
assert.match(appCssSource, /\.reports-output\s*\{[\s\S]*align-self: stretch;/, "Reports output alone stretches vertically");
assert.match(appCssSource, /\.reports-body-field\s*\{[\s\S]*display: flex;/, "Email body field is a flex column");
assert.match(appCssSource, /\.reports-body-field\s*\{[\s\S]*flex-direction: column;/, "Email body field stacks label and preview");
assert.match(appCssSource, /\.reports-body-field\s*\{[\s\S]*flex: 1 1 auto;/, "Email body field flexes vertically");
assert.match(
  appCssSource,
  /\.reports-email-body-preview\s*\{[\s\S]*white-space: pre-wrap;/,
  "Email body preview preserves generated line breaks"
);
assert.match(
  appCssSource,
  /\.reports-email-body-preview\s*\{[\s\S]*overflow: auto;/,
  "Email body preview scrolls naturally inside the output panel"
);

assert.equal(
  countMatches(reportRenderersSource, /\bdateOrdinal\b/g),
  0,
  "Report renderers do not perform duplicate date-range filtering"
);
assert.equal(
  countMatches(reportRenderersSource, /\bdateKeyFromValue\b/g),
  0,
  "Report renderers do not parse worklog dates"
);
assert.equal(
  countMatches(reportRenderersSource, /\bworkItems\b/g),
  0,
  "Report renderers do not filter canonical work items"
);
assert.equal(
  countMatches(reportRenderersSource, /\bworklogsForDay\b/g),
  0,
  "Report renderers do not duplicate day/worklog filtering"
);
assert.match(reportDateRangeSource, /export function buildReportQuery/, "Phase 2 query builder remains exported");
assert.match(reportModelSource, /export function generateReportModel/, "Phase 1 report model remains exported");
assert.match(reportRenderersSource, /export function renderReportEmail/, "Email renderer remains exported");
assert.match(reportRenderersSource, /export function renderReportText/, "TXT renderer remains exported");
assert.match(reportRenderersSource, /export function renderReportTsv/, "TSV renderer remains exported");

console.log("Reports UI verification PASS");
