import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync("src/App.jsx", "utf8");
const css = readFileSync("src/App.css", "utf8");
const filter = readFileSync("src/utils/globalSearchFilter.js", "utf8");

function includes(source, pattern, label) {
  assert.match(source, pattern, label);
}

function excludes(source, pattern, label) {
  assert.doesNotMatch(source, pattern, label);
}

includes(app, /function ViewSummaryStats/, "center stats component exists");
includes(app, /const primaryItems = visibleItems\.slice\(0, 3\)/, "critical stats remain visible");
includes(app, /className="summary-stats-more"/, "secondary stats have a compact More trigger");
includes(app, /className="summary-stats-popover"/, "complete stats render in a compact popover");
includes(css, /\.summary-stats-popover \{[\s\S]*position: absolute;[\s\S]*width: min\(260px/, "stats popover is compact and anchored");
includes(app, /<div className="inline-search-panel">/, "search input is always visible");
excludes(app, /\{open && \(\s*<div className="inline-search-panel">/, "search input does not collapse behind an icon");
includes(css, /\.toolbar-search-area \{[\s\S]*min-width: 260px;[\s\S]*max-width: 620px;/, "search has bounded header space");
includes(css, /\.top-toolbar \{[\s\S]*position: relative;[\s\S]*z-index: var\(--layer-header\);[\s\S]*overflow: visible;/, "header keeps graph from overlapping controls");
includes(css, /\.app-main-content \{[\s\S]*min-height: 0;[\s\S]*overflow: hidden;/, "main content cannot overlap the header");
includes(css, /\.global-search-filter-popover \{[\s\S]*top: calc\(100% \+ 8px\);[\s\S]*max-height: min\(68vh, 520px\);[\s\S]*overflow: auto;/, "filters open in a compact anchored popover");
includes(app, /const SEARCH_FILTER_SECTIONS = Object\.freeze\(\[[\s\S]*View Context[\s\S]*Work Item[\s\S]*People[\s\S]*Metrics/, "filters are organized into compact sections");
includes(app, /const VIEW_HEADER_FILTER_CONFIG = Object\.freeze\(\{[\s\S]*day: \{ inheritedKeys: \["date"\]/, "Day View date inheritance is configured centrally");
includes(app, /sprint: \{ inheritedKeys: \["sprint"\]/, "Sprint View sprint inheritance is configured centrally");
includes(app, /epic: \{ inheritedKeys: \["epic"\]/, "Epic View epic inheritance is configured centrally");
includes(app, /story: \{ inheritedKeys: \[\], contextChip: true \}/, "Story View internal context is preserved centrally");
includes(app, /job: \{ inheritedKeys: \[\], contextChip: true \}/, "Job View internal context is preserved centrally");
includes(app, /task: \{ inheritedKeys: \[\], contextChip: true \}/, "Task View internal context is preserved centrally");
includes(app, /filters\.sprint = selectedContextOption\.id/, "Sprint inheritance uses the selected sprint id, including Orphan Sprint");
includes(app, /filters\.date = dateKeyFromValue\(selectedDayDate\)/, "changing Day View date updates the inherited date");
includes(app, /filters\.epic =[\s\S]*selectedContextOption\.sourceItemId[\s\S]*selectedContextOption\.id/, "Epic inheritance resolves canonical source identity");
includes(app, /const effectiveSearchFilters = useMemo\([\s\S]*composeSearchFilters\(searchFilters, inheritedSearchFilters\)/, "user and inherited filters are composed together");
includes(app, /applySearchFilters\(\{[\s\S]*filters: effectiveSearchFilters/, "effective filters drive visible graph results");
includes(app, /activeFilterCount=\{activeExplicitFilterCount\}/, "filter button counts user filters only");
includes(app, /setSearchFilters\(\{ \.\.\.EMPTY_SEARCH_FILTERS \}\)/, "Clear Filters clears user filters only");
includes(app, /function filterChipsForHeader\(\{ inheritedFilters, userFilters, contextChips, optionsByKey \}\) \{[\s\S]*void inheritedFilters;[\s\S]*void contextChips;[\s\S]*const chips = \[\];/, "generated view-context chips are hidden from the header chip row");
excludes(app, /key: `inherited:\$\{key\}`/, "inherited filters are not rendered as visible chips");
includes(app, /className=\{`search-filter-row \$\{[\s\S]*inheritedValue \? "locked" : ""/, "inherited context remains locked in the filter popover");
includes(app, /View Context \/ Locked/, "filter popover still shows locked inherited view context");
includes(app, /onClick=\{\(\) => onClearFilter\(chip\.filterKey\)\}/, "user chips are individually removable");
includes(app, /aria-label="Clear search"/, "search has a separate clear control");
includes(app, /type=\{isDateFilter \? "date" : "search"\}/, "Date filter has a compact date picker");
includes(filter, /if \(key === "date"\) \{[\s\S]*acc\[key\] = dateKey\(value\)/, "typed date filters survive pruning");
includes(filter, /sprints\.forEach\(\(sprint\) => \{[\s\S]*addOption\(options, "sprint"/, "Sprint dropdown options come from scoped local sprints");
includes(filter, /addOption\(options, "epic"/, "Epic dropdown options come from local normalized data");
includes(filter, /addOption\(options, "assignee"/, "Assignee dropdown options come from local normalized data");
includes(filter, /addOption\(options, "state"/, "State dropdown options come from local normalized data");
includes(filter, /addOption\(options, "priority"/, "Priority dropdown options come from local normalized data");
includes(filter, /addOption\(options, "type"/, "Type dropdown options come from local normalized data");
includes(filter, /addOption\(options, "category"/, "Category dropdown options come from local normalized data");
includes(filter, /return \[\s*value\.getFullYear\(\),[\s\S]*String\(value\.getDate\(\)\)/, "Date comparison uses local date-only keys");
excludes(filter, /toISOString\(\)\.slice\(0, 10\)/, "Date comparison avoids UTC ISO date shifts");
includes(app, /selectedEmployeeScope = useMemo\([\s\S]*employeeScopeForId\(searchFilters\.assignee/, "employee-scoped metrics still use the explicit Assignee filter");
excludes(app, /employeeScopeForId\(effectiveSearchFilters\.assignee/, "inherited filter composition does not duplicate employee scope logic");
includes(app, /calculateStoryPoints\(graphWorkItems, \{ sprints: graphSprints, employeeScope: selectedEmployeeScope \}\)/, "graph stats preserve employee-scoped aggregation");
includes(app, /dayViewSummary\(\{[\s\S]*employeeScope: selectedEmployeeScope/, "Day stats preserve employee-scoped aggregation");
includes(app, /buildDayTimelineModel\(\{[\s\S]*employeeScope: selectedEmployeeScope/, "Day timeline preserves employee-scoped aggregation");

console.log("Global header filter UX verification PASS");
