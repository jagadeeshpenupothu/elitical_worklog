import assert from "node:assert/strict";
import fs from "node:fs/promises";

const appSource = await fs.readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
const cssSource = await fs.readFile(new URL("../src/App.css", import.meta.url), "utf8");

const timelineModelBody =
  appSource.match(/function buildDayTimelineModel[\s\S]*?\n}\n\nfunction mergeByStableIdentity/)?.[0] ||
  "";
const timelineComponentBody =
  appSource.match(/function DayTimelineNavigation[\s\S]*?\n}\n\nfunction canonicalAddExistingUpdates/)?.[0] ||
  "";
const appReturnBody =
  appSource.match(/return \(\n    <div className=\{`app-container[\s\S]*?\n      <LogViewerModal/)?.[0] ||
  "";
const timelineCss =
  cssSource.match(/\.day-timeline-navigation \{[\s\S]*?\.timeline-sprint-cell \{[\s\S]*?\n\}/)?.[0] ||
  "";

assert.match(appSource, /function DayTimelineNavigation/);
assert.match(appSource, /function buildDayTimelineModel/);
assert.match(appSource, /employeeScope: selectedEmployeeScope/);
assert.match(appSource, /function dateForTimelineMonth/);
assert.match(appSource, /function dateForTimelineYear/);
assert.match(appSource, /function dateForTimelineSprint/);
assert.match(appSource, /function timelineShortDateLabel/);
assert.doesNotMatch(appSource, /TIMELINE_SPRINT_PALETTE/);
assert.doesNotMatch(appSource, /function timelineSprintColor/);
assert.doesNotMatch(appSource, /function timelineSprintStyle/);

const headerIndex = appReturnBody.indexOf("<GlobalViewHeader");
const timelineIndex = appReturnBody.indexOf("<DayTimelineNavigation");
const mainIndex = appReturnBody.indexOf('<main className="app-main-content">');
assert.ok(headerIndex >= 0, "GlobalViewHeader must render in the app shell");
assert.ok(timelineIndex > headerIndex, "Day timeline must render below GlobalViewHeader");
assert.ok(mainIndex > timelineIndex, "Main graph workspace must render below the Day timeline");
assert.match(appReturnBody, /viewMode === "day" && dayTimelineModel/);

assert.match(appSource, /const todayKey = useMemo\(\(\) => dateKeyFromValue\(new Date\(\)\), \[\]\)/);
assert.match(appSource, /const selectedDayDate = selectedContextOption\?\.id \|\| todayKey/);
assert.match(appSource, /const dayTimelineModel = useMemo/);
assert.match(appSource, /buildDayTimelineModel\(\{\s*workItems,\s*sprints: graphScopeOptions,\s*selectedDate: selectedDayDate,\s*todayKey,/);
assert.match(appReturnBody, /selectedDate=\{selectedDayDate\}/);
assert.match(appReturnBody, /onSelectDate=\{selectContextViewOption\}/);

assert.match(timelineComponentBody, /useState\("days"\)/);
assert.match(timelineComponentBody, /useState\(false\)/);
assert.match(timelineComponentBody, /useState\(false\)/);
assert.match(timelineComponentBody, /\["days", "Days"\]/);
assert.match(timelineComponentBody, /\["months", "Months"\]/);
assert.match(timelineComponentBody, /\["years", "Years"\]/);
assert.match(timelineComponentBody, /\["sprints", "Sprints"\]/);
assert.match(timelineComponentBody, /className="day-timeline-row"/);
assert.match(timelineComponentBody, /className="timeline-mode-dropdown"/);
assert.match(timelineComponentBody, /className="timeline-mode-trigger"/);
assert.match(timelineComponentBody, /aria-haspopup="listbox"/);
assert.match(timelineComponentBody, /className="timeline-mode-menu"/);
assert.match(timelineComponentBody, /setMode\(id\);[\s\S]*setModeMenuOpen\(false\)/);
assert.match(timelineComponentBody, /useDismissableLayer\(\{[\s\S]*open: modeMenuOpen/);
assert.match(timelineComponentBody, /onDismiss: \(\) => setModeMenuOpen\(false\)/);
assert.doesNotMatch(timelineComponentBody, /role="tablist"/);
assert.match(timelineComponentBody, /scrollIntoView/);
assert.match(timelineComponentBody, /onClick=\{\(\) => onSelectDate\(day\.dateKey\)\}/);
assert.match(timelineComponentBody, /onClick=\{\(\) => onSelectDate\(dateForTimelineMonth\(month, selectedDate\)\)\}/);
assert.match(timelineComponentBody, /onClick=\{\(\) => onSelectDate\(dateForTimelineYear\(year, selectedDate\)\)\}/);
assert.match(timelineComponentBody, /onClick=\{\(\) => onSelectDate\(dateForTimelineSprint\(sprint, selectedDate, todayKey\)\)\}/);
assert.match(timelineComponentBody, /className=\{`day-timeline-navigation \$\{expanded \? "expanded" : "collapsed"\}`\}/);
assert.match(timelineComponentBody, /className="global-icon-button day-timeline-toggle"/);
assert.match(timelineComponentBody, /setExpanded\(\(current\) => !current\)/);
assert.match(timelineComponentBody, /className="timeline-date-row"/);
assert.match(timelineComponentBody, /className="timeline-metric-row"/);
assert.match(timelineComponentBody, /className="timeline-collapsed-time"/);
assert.match(timelineComponentBody, /timelineShortDateLabel\(day\.dateKey\)/);
assert.match(timelineComponentBody, /formatWorkDuration\(day\.minutes\)/);
assert.match(timelineComponentBody, /if \(day\.isWeekend\) return "status-weekend"/);
assert.match(timelineComponentBody, /if \(day\.minutes >= 480\) return "status-complete"/);
assert.match(timelineComponentBody, /if \(day\.minutes > 0\) return "status-partial"/);
assert.match(timelineComponentBody, /return "status-missing"/);
assert.match(timelineComponentBody, /expanded \? \([\s\S]*<TimelineMetric label="Logged" value=\{formatWorkDuration\(day\.minutes\)\}/);
assert.match(timelineComponentBody, /expanded \? \([\s\S]*<TimelineMetric label="SP" value=\{day\.storyPoints\}/);
assert.match(timelineComponentBody, /expanded \? \([\s\S]*timelineDayLabel\(day\.dateKey\)/);
assert.match(timelineComponentBody, /const nextDay = dayItems\[index \+ 1\]/);
assert.doesNotMatch(timelineComponentBody, /sprint-range/);
assert.doesNotMatch(timelineComponentBody, /timelineSprintStyle/);
assert.match(timelineComponentBody, /day\.isWeekend \? "weekend" : ""/);
assert.match(timelineComponentBody, /dayStatusClass\(day\)/);
assert.doesNotMatch(timelineComponentBody, /disabled=\{day\.isWeekend/);
assert.doesNotMatch(timelineComponentBody, /orphan-sprint/);
assert.doesNotMatch(timelineComponentBody, /fetch\(/);
assert.doesNotMatch(timelineComponentBody, /syncPendingToElitical/);
assert.doesNotMatch(timelineComponentBody, /syncLiveEliticalData/);

assert.match(timelineModelBody, /isRealImportedWorklog\(entry\)/);
assert.match(timelineModelBody, /worklogMatchesEmployeeScope\(entry, employeeScope\)/);
assert.match(timelineModelBody, /worklogMinutes\(entry\)/);
assert.match(timelineModelBody, /storyOwnerForTimelineItem\(item, itemById\)/);
assert.match(timelineModelBody, /itemMatchesEmployeeScope\(story, employeeScope\)/);
assert.match(timelineModelBody, /storyIds: new Set\(\)/);
assert.match(timelineModelBody, /const yearsByKey = new Map\(\)/);
assert.match(timelineModelBody, /yearsByKey\.set\(yearKey/);
assert.match(timelineModelBody, /years: Array\.from\(yearsByKey\.values\(\)\)\.map\(finalizeAggregate\)/);
assert.match(appSource, /sprintContainsDate\(sprint, dateKey\)/);
assert.match(timelineModelBody, /ORPHAN_SPRINT_ID/);
assert.match(appSource, /ORPHAN_SPRINT_TITLE/);
assert.match(timelineModelBody, /ordinal <= Math\.max\(startOrdinal, todayOrdinal\)/);
assert.match(timelineModelBody, /isToday: dateKey === todayKey/);
assert.match(timelineModelBody, /isSelected: dateKey === selectedDate/);

assert.match(cssSource, /\.day-timeline-navigation/);
assert.match(cssSource, /\.day-timeline-navigation\.collapsed/);
assert.match(cssSource, /\.day-timeline-navigation\.expanded/);
assert.match(cssSource, /\.day-timeline-toggle/);
assert.match(timelineCss, /flex: 0 0 auto/);
assert.match(timelineCss, /\.day-timeline-navigation \{[\s\S]*overflow: visible/);
assert.match(timelineCss, /\.day-timeline-row \{[\s\S]*display: flex;[\s\S]*align-items: center/);
assert.match(timelineCss, /\.day-timeline-row \{[\s\S]*overflow: visible/);
assert.match(timelineCss, /\.timeline-mode-dropdown \{[\s\S]*flex: 0 0 auto/);
assert.match(timelineCss, /\.timeline-mode-trigger \{[\s\S]*width: 92px/);
assert.match(timelineCss, /\.timeline-mode-menu \{[\s\S]*animation: timeline-menu-in 120ms ease-out/);
assert.match(timelineCss, /\.timeline-mode-menu \{[\s\S]*z-index: var\(--layer-popover\)/);
assert.match(timelineCss, /\.day-timeline-scroller \{[\s\S]*overflow-x: auto/);
assert.match(timelineCss, /\.day-timeline-scroller \{[\s\S]*overflow-y: hidden/);
assert.match(timelineCss, /\.day-timeline-scroller \{[\s\S]*flex: 1 1 auto;[\s\S]*min-width: 0/);
assert.match(timelineCss, /\.day-timeline-scroller \{[\s\S]*scrollbar-width: none/);
assert.match(timelineCss, /\.day-timeline-scroller::-webkit-scrollbar \{[\s\S]*display: none/);
assert.match(timelineCss, /\.day-timeline-cell\.weekend/);
assert.match(timelineCss, /\.day-timeline-cell\.selected/);
assert.match(timelineCss, /\.day-timeline-cell\.today/);
assert.match(timelineCss, /\.timeline-day-cell\.status-complete \{[\s\S]*rgba\(34, 197, 94/);
assert.match(timelineCss, /\.timeline-day-cell\.status-partial \{[\s\S]*rgba\(245, 190, 70/);
assert.match(timelineCss, /\.timeline-day-cell\.status-missing \{[\s\S]*rgba\(239, 100, 97/);
assert.match(timelineCss, /\.timeline-day-cell\.status-weekend \{[\s\S]*rgba\(100, 116, 139/);
assert.match(timelineCss, /\.day-timeline-cell\.weekend \{[\s\S]*rgba\(18, 23, 32, 0\.72\)/);
assert.doesNotMatch(timelineCss, /timeline-sprint-outline|timeline-sprint-tint/);
assert.doesNotMatch(timelineCss, /sprint-range/);
assert.doesNotMatch(timelineCss, /linear-gradient\(var\(--timeline-sprint/);
assert.match(timelineCss, /\.timeline-year-cell/);
assert.match(timelineCss, /\.timeline-date-row,[\s\S]*\.timeline-metric-row \{[\s\S]*justify-content: space-between/);
assert.match(timelineCss, /\.day-timeline-navigation\.expanded \.timeline-day-cell \{[\s\S]*min-height: 58px/);
assert.match(timelineCss, /\.day-timeline-navigation\.collapsed \.day-timeline-cell \{[\s\S]*min-height: 38px/);
assert.match(timelineCss, /\.day-timeline-navigation\.collapsed \.day-timeline-cell \{[\s\S]*flex-basis: 70px/);
assert.match(timelineCss, /\.timeline-collapsed-time \{[\s\S]*text-align: center/);
assert.match(timelineCss, /\.day-timeline-navigation\.collapsed \.timeline-today-label \{[\s\S]*width: 5px/);
assert.doesNotMatch(timelineCss, /repeating-linear-gradient/);

assert.match(
  appSource,
  /const showGraphEmptyState =\s*viewMode !== "day" &&[\s\S]*graphWorkItems\.length === 0/,
  "zero-worklog Day View hierarchy remains rendered"
);

console.log("Day timeline navigation verification PASS");
