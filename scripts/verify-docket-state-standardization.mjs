import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BACKLOG_ACTIVE_DOCKET_STATES,
  CANONICAL_DOCKET_STATES,
  DOCKET_STATE_OPTIONS,
  docketStateApiName,
  docketStateLabel,
  isBacklogDocketState,
  normalizeDocketState,
} from "../src/utils/docketStates.js";
import {
  buildSearchFilterOptions,
  applySearchFilters,
} from "../src/utils/globalSearchFilter.js";
import {
  BACKLOG_ELIGIBLE_STATES,
  isBacklogEligible,
} from "../src/utils/backlogProjection.js";

assert.deepEqual(CANONICAL_DOCKET_STATES, [
  "concept",
  "design",
  "in-review",
  "artifact",
  "closed",
]);
assert.equal(DOCKET_STATE_OPTIONS.length, 5, "Exactly five docket states are defined");
assert.deepEqual(DOCKET_STATE_OPTIONS.map((state) => state.label), [
  "Concept",
  "Design",
  "In Review",
  "Artifact",
  "Closed",
]);

assert.equal(docketStateApiName("concept"), "Concept");
assert.equal(docketStateApiName("design"), "Design");
assert.equal(docketStateApiName("in-review"), "Review");
assert.equal(docketStateApiName("artifact"), "Artifact");
assert.equal(docketStateApiName("closed"), "Closed");
assert.equal(docketStateLabel("review"), "In Review");

[
  ["Concept", "concept"],
  ["DESIGN", "design"],
  ["Review", "in-review"],
  ["IN_REVIEW", "in-review"],
  ["IN REVIEW", "in-review"],
  ["review", "in-review"],
  ["REV", "in-review"],
  ["Artifact", "artifact"],
  ["Artifacts", "artifact"],
  ["ARTF", "artifact"],
  ["Closed", "closed"],
  ["CLO", "closed"],
].forEach(([input, expected]) => {
  assert.equal(normalizeDocketState(input), expected, `${input} normalizes to ${expected}`);
});

assert.deepEqual(BACKLOG_ACTIVE_DOCKET_STATES, [
  "concept",
  "design",
  "in-review",
  "artifact",
]);
assert.deepEqual(BACKLOG_ELIGIBLE_STATES, BACKLOG_ACTIVE_DOCKET_STATES);

[
  { docketState: "concept", type: "story" },
  { docketState: "design", type: "story" },
  { docketState: "Review", type: "story" },
  { docketState: "IN_REVIEW", type: "story" },
  { docketState: "Artifact", type: "story" },
].forEach((item) => {
  assert.equal(isBacklogEligible(item), true, `${item.docketState} is Backlog-eligible`);
  assert.equal(isBacklogDocketState(item.docketState), true);
});
assert.equal(isBacklogEligible({ docketState: "Closed", type: "story" }), false);

const items = CANONICAL_DOCKET_STATES.map((state) => ({
  id: `item-${state}`,
  type: "story",
  title: docketStateLabel(state),
  docketState: state,
  parentId: "epic-1",
}));
const options = buildSearchFilterOptions({ items });
assert.deepEqual(
  options.state.map((option) => option.value).sort(),
  CANONICAL_DOCKET_STATES.slice().sort(),
  "Search/filter exposes all five canonical states"
);
assert.equal(
  applySearchFilters({ items, filters: { state: "in-review" } }).matchedItems.map((item) => item.id)[0],
  "item-in-review",
  "Search/filter keeps In Review independent"
);
assert.equal(
  applySearchFilters({ items, filters: { state: "artifact" } }).matchedItems.map((item) => item.id)[0],
  "item-artifact",
  "Search/filter keeps Artifact independent"
);

const appSource = readFileSync("src/App.jsx", "utf8");
assert.match(appSource, /dktStateName: docketStateApiName\(payload\.docketState\)/);
assert.match(appSource, /sdkUpdates\.dktStateName = docketStateApiName\(canonicalState\)/);
assert.match(appSource, /stateName: docketStateApiName\(docketState\)/);
assert.doesNotMatch(appSource, /dktStateName: localUpdates\.docketState/);

const providerSource = readFileSync("src/services/elitical/provider/EliticalProvider.ts", "utf8");
assert.match(providerSource, /normalizeDocketState/);
assert.match(providerSource, /docketState,\n\s+status: docketState/);

console.log("Docket state standardization verification PASS");
