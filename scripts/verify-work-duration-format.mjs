import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  formatWorkDuration,
  workdayEquivalent,
  WORKDAY_MINUTES,
} from "../src/utils/durationFormat.js";

const app = readFileSync("src/App.jsx", "utf8");
const jiraNode = readFileSync("src/components/JiraNode.jsx", "utf8");
const planningView = readFileSync("src/views/PlanningView.jsx", "utf8");
const durationFormat = readFileSync("src/utils/durationFormat.js", "utf8");
const searchFilter = readFileSync("src/utils/globalSearchFilter.js", "utf8");

const cases = [
  [0, "00:00"],
  [15, "00:15"],
  [60, "01:00"],
  [67, "01:07"],
  [420, "07:00"],
  [479, "07:59"],
  [480, "08:00"],
  [495, "08:15"],
  [552, "09:12"],
  [792, "13:12"],
  [960, "16:00"],
  [990, "16:30"],
  [1500, "25:00"],
  [1530, "25:30"],
  [6015, "100:15"],
];

assert.equal(WORKDAY_MINUTES, 480, "one workday remains exactly 8 hours");
cases.forEach(([minutes, expected]) => {
  assert.equal(formatWorkDuration(minutes), expected, `${minutes} minutes`);
});
assert.equal(formatWorkDuration(480), "08:00", "8 hours displays as cumulative hours");
assert.equal(formatWorkDuration(552), "09:12", "9h 12m displays as cumulative hours");
assert.equal(formatWorkDuration(792), "13:12", "13h 12m displays as cumulative hours");
assert.equal(formatWorkDuration(960), "16:00", "16 hours displays as cumulative hours");
assert.equal(workdayEquivalent(480), 1, "480 minutes is still one workday for business calculations");
assert.equal(workdayEquivalent(960), 2, "960 minutes is still two workdays for business calculations");
assert.equal(workdayEquivalent(1200), 2.5, "1200 minutes is still two and a half workdays");

assert.match(durationFormat, /export function formatWorkDuration/);
assert.match(durationFormat, /export function workdayEquivalent/);
assert.match(durationFormat, /WORKDAY_MINUTES = 8 \* 60/);
assert.match(durationFormat, /const hours = Math\.floor\(safeMinutes \/ 60\)/);
assert.match(durationFormat, /const remainingMinutes = safeMinutes % 60/);
assert.match(durationFormat, /return safeMinutes \/ WORKDAY_MINUTES/);
assert.doesNotMatch(durationFormat, /days = Math\.floor\(safeMinutes \/ WORKDAY_MINUTES\)/);
assert.doesNotMatch(durationFormat, /safeMinutes % WORKDAY_MINUTES/);
assert.doesNotMatch(durationFormat, /\$\{days\}d/);
assert.doesNotMatch(durationFormat, /toISOString|Date\(/, "duration formatter must not use clock/calendar time");
assert.doesNotMatch(durationFormat, /seconds|:ss|SS/, "normal duration display does not include seconds");

assert.match(app, /import \{ formatWorkDuration \} from "\.\/utils\/durationFormat"/);
assert.doesNotMatch(app, /function formatWorkTime/, "App must not keep a separate work-duration formatter");
assert.match(jiraNode, /import \{ formatWorkDuration \} from "\.\.\/utils\/durationFormat"/);
assert.doesNotMatch(jiraNode, /function formatTime\(/, "JiraNode must not keep a separate duration formatter");
assert.match(planningView, /import \{ formatWorkDuration \} from "\.\.\/utils\/durationFormat"/);
assert.doesNotMatch(planningView, /toFixed\(1\)h Logged|toFixed\(1\)h logged|Total \$\{.*toFixed\(1\)h/s);

assert.match(app, /\["Logged", formatWorkDuration\(summary\.totalMinutes\)\]/, "Day View date root card uses formatter");
assert.match(app, /TimelineMetric label="Logged" value=\{formatWorkDuration\(day\.minutes\)\}/, "Day timeline day summaries use formatter");
assert.match(app, /className="timeline-collapsed-time"[\s\S]*formatWorkDuration\(day\.minutes\)/, "Day timeline collapsed cards use cumulative formatter");
assert.match(app, /TimelineMetric label="Logged" value=\{formatWorkDuration\(month\.minutes\)\}/, "Day timeline month summaries use formatter");
assert.match(app, /TimelineMetric label="Logged" value=\{formatWorkDuration\(year\.minutes\)\}/, "Day timeline year summaries use formatter");
assert.match(app, /TimelineMetric label="Logged" value=\{formatWorkDuration\(sprint\.minutes\)\}/, "Day timeline sprint summaries use formatter");
assert.match(jiraNode, /formatWorkDuration\(timeValue\)/, "graph node durations use formatter");
assert.match(app, /\{ label: "Logged", value: formatWorkDuration\(contextTimeMinutes\) \}/, "header context Logged metric uses formatter");
assert.match(app, /value: formatWorkDuration\(\s*importedWorklogs\.reduce/, "Worklog header Logged metric uses formatter");
assert.match(planningView, /formatWorkDuration\(stats\.loggedMinutes\)/, "Planning stats use formatter");
assert.match(planningView, /formatWorkDuration\(loggedMinutes\)/, "Planning cards use formatter");
assert.match(planningView, /formatWorkDuration\(entry\.timeMinutes\)/, "Worklog entries use formatter");

assert.match(searchFilter, /applySearchFilters/, "search/filter remains presentation-independent");
assert.doesNotMatch(searchFilter, /formatWorkDuration/, "filtering/search does not format or alter durations");
assert.match(app, /calculateStoryPoints\(graphWorkItems, \{ sprints: graphSprints, employeeScope: selectedEmployeeScope \}\)/);
assert.match(app, /buildDayTimelineModel\(\{[\s\S]*employeeScope: selectedEmployeeScope/, "employee-scoped totals remain calculated before display");
assert.match(app, /if \(day\.minutes >= 480\) return "status-complete"/, "weekday completion threshold remains 8 hours");
assert.match(app, /if \(day\.isWeekend\) return "status-weekend"/, "weekend visual priority remains independent of duration display");

console.log("Work duration display format verification PASS");
