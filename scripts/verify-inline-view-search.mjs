import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const app = readFileSync("src/App.jsx", "utf8");
const css = readFileSync("src/App.css", "utf8");
const graphView = readFileSync("src/views/GraphView.jsx", "utf8");
const planningView = readFileSync("src/views/PlanningView.jsx", "utf8");
const searchFilter = readFileSync("src/utils/globalSearchFilter.js", "utf8");
const globalActionsBody =
  app.match(/function GlobalActions[\s\S]*?\n}\n\nfunction GlobalViewHeader/)?.[0] || "";
const inlineSearchBody =
  app.match(/function InlineHeaderSearch[\s\S]*?\n}\n\nfunction GlobalActions/)?.[0] || "";
const inlineSearchPanelCss = css.match(/\.inline-search-panel \{[\s\S]*?\n\}/)?.[0] || "";

function includes(source, pattern, label) {
  assert.match(source, pattern, label);
}

function excludes(source, pattern, label) {
  assert.doesNotMatch(source, pattern, label);
}

includes(app, /function InlineHeaderSearch\(/, "inline search component exists");
includes(app, /<InlineHeaderSearch[\s\S]*open=\{searchOpen\}/, "header renders inline search");
includes(app, /<div className="toolbar-search-area">\{search\}<\/div>/, "search has a dedicated header layout slot");
excludes(globalActionsBody, /searchOpen|<InlineHeaderSearch/, "GlobalActions does not own search layout");
excludes(app, /Search workspace/i, "old Search Workspace text is removed");
excludes(app, /className="search-overlay"/, "old centered overlay is not rendered");
excludes(css, /\.search-overlay|\.search-panel|\.search-results/, "old centered overlay styles are removed");
includes(inlineSearchBody, /<div className="inline-search-panel">/, "search panel is always rendered");
excludes(inlineSearchBody, /\{open && \(\s*<div className="inline-search-panel">/, "search no longer collapses to an icon");
excludes(inlineSearchBody, /className=\{`global-icon-button search-trigger/, "old icon-only search trigger is removed");
includes(css, /\.inline-search-control \{[\s\S]*width: min\(560px, 100%\);[\s\S]*flex: 1 1 420px;[\s\S]*min-width: 260px;/, "search input keeps a stable visible footprint");
includes(css, /\.toolbar-search-area \{[\s\S]*flex: 1 1 420px;[\s\S]*max-width: 620px;/, "search uses constrained flexible header space");
includes(inlineSearchPanelCss, /position: relative;[\s\S]*width: 100%;/, "search participates in layout instead of overlaying stats");
excludes(inlineSearchPanelCss, /position: absolute|right: 0;/, "search panel does not paint over neighboring header content");
includes(css, /\.global-search-filter-popover \{[\s\S]*position: absolute;[\s\S]*max-height: min\(68vh, 520px\);[\s\S]*overflow: auto;/, "filter popover is compact and anchored");
includes(app, /const SEARCH_FILTER_SECTIONS = Object\.freeze/, "filter popover sections are centralized");
includes(app, /const VIEW_HEADER_FILTER_CONFIG = Object\.freeze/, "view inherited filter config is centralized");
includes(app, /function viewHeaderFilterContext/, "view context to inherited filter mapping exists");
includes(app, /function composeSearchFilters/, "inherited and user filters compose centrally");
includes(app, /function filterChipsForHeader/, "active filter chips are derived centrally");
includes(app, /function SearchFilterChips/, "filter chips component exists");
includes(app, /function filterChipsForHeader\(\{ inheritedFilters, userFilters, contextChips, optionsByKey \}\) \{[\s\S]*void inheritedFilters;[\s\S]*void contextChips;[\s\S]*const chips = \[\];/, "generated view-context chips are hidden from the header chip row");
excludes(app, /key: `inherited:\$\{key\}`/, "inherited filters are not rendered as visible chips");
includes(app, /className=\{`search-filter-row \$\{[\s\S]*inheritedValue \? "locked" : ""/, "inherited context remains locked in the filter popover");
includes(app, /View Context \/ Locked/, "filter popover still explains inherited view context");
includes(app, /onClick=\{\(\) => onClearFilter\(chip\.filterKey\)\}/, "user chips can be cleared individually");
includes(app, /filters: effectiveSearchFilters/, "effective inherited plus user filters drive graph filtering");
includes(app, /activeFilterCount=\{activeExplicitFilterCount\}/, "filter button counts manual user filters only");
includes(app, /inheritedFilters=\{inheritedSearchFilters\}/, "filter UI receives inherited filters");
includes(app, /filterChips=\{searchFilterChips\}/, "header receives active filter chips");
includes(app, /availableFilterKeys=\{availableFilterKeys\}/, "available filters are scoped before rendering");
includes(app, /viewMode,[\s\S]*selectedContextOption,[\s\S]*selectedDayDate/, "view filter context receives current selected context/date");
includes(app, /if \(config\.inheritedKeys\.includes\("date"\)[\s\S]*filters\.date = dateKeyFromValue/, "Day View date is inherited");
includes(app, /if \(config\.inheritedKeys\.includes\("sprint"\)[\s\S]*filters\.sprint = selectedContextOption\.id/, "Sprint View sprint is inherited");
includes(app, /if \(config\.inheritedKeys\.includes\("epic"\)[\s\S]*filters\.epic =/, "Epic View epic is inherited");
includes(app, /story: \{ inheritedKeys: \[\], contextChip: true \}/, "Story View preserves internal context chip");
includes(app, /job: \{ inheritedKeys: \[\], contextChip: true \}/, "Job View preserves internal context chip");
includes(app, /task: \{ inheritedKeys: \[\], contextChip: true \}/, "Task View preserves internal context chip");
includes(app, /setSearchFilters\(\{ \.\.\.EMPTY_SEARCH_FILTERS \}\)/, "Clear Filters clears user filters only");
excludes(app, /clearExplicitSearchFilters[\s\S]{0,160}inheritedSearchFilters/, "Clear Filters does not clear inherited context");
includes(app, /aria-label="Clear search"/, "search has a dedicated clear button");
includes(app, /type=\{isDateFilter \? "date" : "search"\}/, "date filter uses a date picker");
includes(searchFilter, /return \[\s*value\.getFullYear\(\),[\s\S]*String\(value\.getDate\(\)\)/, "date filtering uses local date keys");
excludes(searchFilter, /toISOString\(\)\.slice\(0, 10\)/, "date filtering avoids UTC ISO date shifting");
includes(searchFilter, /sprints\.forEach\(\(sprint\) => \{[\s\S]*addOption\(options, "sprint"/, "sprint options come from real scoped sprints");
includes(searchFilter, /items\.forEach\(\(item\) => \{[\s\S]*addOption\(options, "epic"/, "epic options come from real scoped items");
includes(searchFilter, /addOption\(options, "assignee"/, "assignee options come from local docket/worklog data");
includes(searchFilter, /addOption\(options, "state"/, "state options come from local data");
includes(searchFilter, /addOption\(options, "priority"/, "priority options come from local data");
includes(searchFilter, /addOption\(options, "type"/, "type options come from local data");
includes(searchFilter, /addOption\(options, "category"/, "category options come from local data");
includes(searchFilter, /activeKeys\.every/, "multiple filters use AND logic");
includes(searchFilter, /visibleIds\.add\(parent\.id\)/, "filtering preserves ancestor context");
includes(app, /normalizeInlineSearch\(searchQuery\)/, "search starts from normalized query text");
includes(app, /item\.searchText\.includes\(normalizedQuery\)/, "search works from the first character");
includes(app, /event\.key === "Enter"[\s\S]*event\.shiftKey[\s\S]*onPrevious\(\)[\s\S]*onNext\(\)/, "Enter and Shift+Enter navigate results");
includes(app, /onChange=\{\(event\) => \{[\s\S]*onQueryChange\(event\.target\.value\)/, "search input reacts on every change");
includes(app, /window\.addEventListener\("pointerdown", handlePointerDown\)/, "filter popover outside-click listener exists");
includes(app, /event\.key !== "Escape"[\s\S]*setOpenKey\(""\)/, "Escape closes open filter dropdown first");
includes(app, /onToggle=\{setOpenKey\}/, "opening another dropdown closes the previous one");
includes(app, /onToggle\(""\);/, "dropdown closes after selecting an option");
includes(graphView, /searchMatchIds: externalSearchMatchIds = new Set\(\)/, "GraphView accepts scoped search match IDs");
includes(graphView, /function usableGraphCenter\(wrapper\)/, "GraphView centers within the usable graph viewport");
includes(graphView, /querySelector\("\.top-toolbar"\)/, "GraphView accounts for the global toolbar");
includes(graphView, /instance\.setViewport\(/, "GraphView pans to the active result");
excludes(graphView, /fitView\([\s\S]*activeSearch/, "GraphView does not fit the whole graph for a search result");
includes(planningView, /searchNodeRefs\.current\.get\(activeSearchId\)\?\.scrollIntoView/, "planning search results scroll into view");
includes(css, /\.jira-node\.search-active/, "graph active search style exists");
includes(css, /\.planning-card\.search-active/, "planning active search style exists");
excludes(app, /fetch\([^)]*search|syncPendingToElitical\([^)]*search|syncLiveEliticalData\([^)]*search/i, "search does not call network or sync APIs");

console.log("Inline current-view search verification PASS");
