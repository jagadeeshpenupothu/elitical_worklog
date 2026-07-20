import assert from "node:assert/strict";
import fs from "node:fs/promises";

const appSource = await fs.readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
const cssSource = await fs.readFile(new URL("../src/App.css", import.meta.url), "utf8");

const globalHeaderBody = appSource.match(/function GlobalViewHeader[\s\S]*?\n}\n\nfunction formatLogTime/)?.[0] || "";
const globalActionsBody = appSource.match(/function GlobalActions[\s\S]*?\n}\n\nfunction GlobalViewHeader/)?.[0] || "";
const returnBody = appSource.match(/return \(\n    <div className=\{`app-container[\s\S]*?\n      <LogViewerModal/)?.[0] || "";
const appContainerCss = cssSource.match(/\.app-container \{[\s\S]*?\n\}/)?.[0] || "";
const appMainContentCss = cssSource.match(/\.app-main-content \{[\s\S]*?\n\}/)?.[0] || "";
const topToolbarCss = cssSource.match(/\.top-toolbar \{[\s\S]*?\n\}/)?.[0] || "";
const graphViewCss = cssSource.match(/\.graph-view \{[\s\S]*?\n\}/)?.[0] || "";
const canvasFullCss = cssSource.match(/\.canvas-full-mode \.app-main-content \{[\s\S]*?\n\}/)?.[0] || "";
const planningViewCss = cssSource.match(/\.planning-view \{[\s\S]*?\n\}/)?.[0] || "";
const dashboardViewCss = cssSource.match(/\.dashboard-view \{[\s\S]*?\n\}/)?.[0] || "";
const graphViewSource = await fs.readFile(new URL("../src/views/GraphView.jsx", import.meta.url), "utf8");

assert.match(appSource, /function GlobalViewHeader/);
assert.match(appSource, /function ViewSelector/);
assert.match(appSource, /function ViewContextArea/);
assert.match(appSource, /function ViewSummaryStats/);
assert.match(appSource, /className="summary-stats-more"/);
assert.match(appSource, /className="summary-stats-popover"/);
assert.match(appSource, /function GlobalActions/);
assert.match(appSource, /const headerContextByView = \{/);
assert.match(appSource, /main: \{ stats: treeStats \}/);
assert.match(appSource, /day: \{\s*control: \(/);
assert.match(appSource, /dashboard: \{ stats: dashboardStats \}/);

assert.match(returnBody, /!canvasFullMode[\s\S]*<GlobalViewHeader/);
assert.match(returnBody, /!canvasFullMode && viewMode === "day" && dayTimelineModel[\s\S]*<DayTimelineNavigation/);
assert.match(returnBody, /<main className="app-main-content">/);
assert.ok(
  returnBody.indexOf("<GlobalViewHeader") < returnBody.indexOf("<DayTimelineNavigation"),
  "Day timeline must be below the global header"
);
assert.ok(
  returnBody.indexOf("<DayTimelineNavigation") < returnBody.indexOf('<main className="app-main-content">'),
  "Graph workspace must be below the Day timeline"
);
assert.doesNotMatch(returnBody, /className="app-logo"/);
assert.doesNotMatch(returnBody, /Last synced \{formatRelativeSync/);
assert.doesNotMatch(returnBody, /className="sync-status-icon"/);
assert.doesNotMatch(returnBody, /<DayViewToolbar[\s\S]*?summary=\{daySummary\}[\s\S]*?\/>\s*\) : isContextView/);
assert.doesNotMatch(returnBody, /<ContextGraphSelector[\s\S]*?\) : null/);

assert.match(globalHeaderBody, /<ViewSelector/);
assert.match(globalHeaderBody, /<ViewContextArea/);
assert.match(globalHeaderBody, /className="toolbar-search-area"/);
assert.match(globalHeaderBody, /\{search\}/);
assert.match(globalHeaderBody, /\{globalActions\}/);

assert.doesNotMatch(globalActionsBody, /<InlineHeaderSearch/);
assert.match(appSource, /const globalSearch = \(/);
assert.match(appSource, /<InlineHeaderSearch/);
assert.match(appSource, /aria-label="Search current view"/);
assert.match(appSource, /const \[searchScope, setSearchScope\] = useState\("view"\)/);
assert.match(appSource, /scope=\{searchScope\}/);
assert.match(appSource, /onScopeChange=\{\(scope\) => \{/);
assert.match(appSource, /aria-label=\{scope === "global" \? "Search all dockets" : "Search current view"\}/);
assert.match(appSource, /title=\{scope === "global" \? "Search all dockets" : "Search current view"\}/);
assert.match(appSource, /\{option === "view" \? "View" : "Global"\}/);
assert.match(appSource, /title=\{option === "view" \? "Search current view" : "Search all dockets"\}/);
assert.match(globalActionsBody, /aria-label="Sync status"/);
assert.match(globalActionsBody, /title="Sync status"/);
assert.match(globalActionsBody, /aria-label="Sync to Elitical"/);
assert.match(globalActionsBody, /title="Sync to Elitical"/);
assert.match(globalActionsBody, /aria-label="Sync from Elitical"/);
assert.match(globalActionsBody, /title="Sync from Elitical"/);
assert.match(globalActionsBody, /aria-label="Profile"/);
assert.match(globalActionsBody, /title="Profile"/);
assert.match(globalActionsBody, /syncStatusIconType\(syncState, liveSyncState\)/);
assert.match(appSource, /if \(type === "sync-status"\)/);
assert.match(globalActionsBody, /ToolbarIcon type="cloud-upload"/);
assert.match(globalActionsBody, /ToolbarIcon type="cloud-download"/);
assert.match(globalActionsBody, /ToolbarIcon type="user"/);
assert.match(globalActionsBody, /sync-action-count/);
assert.doesNotMatch(globalActionsBody, />Search\s*</);
assert.doesNotMatch(globalActionsBody, />Ctrl K</);
assert.doesNotMatch(globalActionsBody, />i</);

assert.match(appSource, /\["Last Synced", syncStatusSummary\.syncedAt/);
assert.match(appSource, /\["Reconciliation Actionable", syncQueueSummary\.reconciliationActionableCount/);
assert.match(appSource, /\["Blocked", syncQueueSummary\.blockedCount/);
assert.match(appSource, /const \[canvasFullMode, setCanvasFullMode\] = useState\(false\)/);
assert.match(appSource, /className=\{`app-container \$\{canvasFullMode \? "canvas-full-mode" : ""\}`\}/);
assert.match(appSource, /!canvasFullMode &&[\s\S]*toolbar-secondary-actions/);
assert.match(appSource, /canvasFullMode=\{canvasFullMode\}/);
assert.match(appSource, /onCanvasFullModeChange=\{setCanvasFullMode\}/);
assert.match(graphViewSource, /canvasFullMode = false/);
assert.match(graphViewSource, /onCanvasFullModeChange/);
assert.match(graphViewSource, /onCanvasFullModeChange\?\.\(!canvasFullMode\)/);
assert.match(graphViewSource, /aria-pressed=\{canvasFullMode\}/);
assert.doesNotMatch(graphViewSource, /requestFullscreen|exitFullscreen|fullscreenElement/);

assert.match(cssSource, /\.view-context-area/);
assert.match(cssSource, /\.view-summary-stats/);
assert.match(cssSource, /\.summary-stats-popover \{[\s\S]*position: absolute/);
assert.match(cssSource, /\.toolbar-search-area/);
assert.match(cssSource, /\.inline-search-panel \{[\s\S]*position: relative/);
assert.match(appContainerCss, /display: flex;[\s\S]*flex-direction: column;[\s\S]*overflow: hidden;/);
assert.match(appMainContentCss, /flex: 1 1 auto;[\s\S]*min-height: 0;[\s\S]*overflow: hidden;/);
assert.match(canvasFullCss, /flex: 1 1 100%;[\s\S]*width: 100%;[\s\S]*height: 100%;/);
assert.match(topToolbarCss, /position: relative;[\s\S]*flex: 0 0 auto;/);
assert.doesNotMatch(topToolbarCss, /position: fixed;/);
assert.match(graphViewCss, /flex: 1 1 auto;[\s\S]*overflow: hidden;/);
assert.doesNotMatch(planningViewCss, /padding: 72px/);
assert.doesNotMatch(dashboardViewCss, /padding: 72px/);
assert.match(cssSource, /\.global-icon-button/);
assert.match(cssSource, /width: 34px/);
assert.match(cssSource, /height: 34px/);
assert.match(cssSource, /\.view-context-area \.context-graph-selector/);
assert.match(cssSource, /\.view-context-area \.day-view-toolbar/);
assert.doesNotMatch(cssSource, /\.profile-menu-button span\s*\{/);

console.log("Global view header architecture verification PASS");
