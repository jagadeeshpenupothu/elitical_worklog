import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  docketNumberForItem,
  isExactDocketNumberQuery,
  normalizeDocketNumber,
} from "../src/utils/docketIdentity.js";

const app = readFileSync("src/App.jsx", "utf8");
const node = readFileSync("src/components/JiraNode.jsx", "utf8");
const planning = readFileSync("src/views/PlanningView.jsx", "utf8");
const graphView = readFileSync("src/views/GraphView.jsx", "utf8");
const css = readFileSync("src/App.css", "utf8");

assert.equal(docketNumberForItem({ elitical: { num: "DES-660" }, id: "uuid" }), "DES-660");
assert.equal(docketNumberForItem({ num: "des-660" }), "DES-660");
assert.equal(docketNumberForItem({ id: "6a01f0c1-fake" }), "");
assert.equal(docketNumberForItem({ id: "local-docket-123", sync: { status: "pending-create" } }), "");
assert.equal(normalizeDocketNumber("des-660"), "DES-660");
assert.equal(isExactDocketNumberQuery("DES-660"), true);
assert.equal(isExactDocketNumberQuery("des-660"), true);
assert.equal(isExactDocketNumberQuery("Cover Design"), false);

assert.match(node, /docketNumberForItem\(data\)/, "Shared graph node reads real docket number");
assert.match(node, /node-docket-number/, "Shared graph node renders docket number label");
assert.match(node, /\["epic", "story", "job", "task"\]\.includes\(data\.type\)/, "Docket label is limited to docket node types");
assert.match(planning, /docketNumberForItem\(item\)/, "Planning/worklog cards use same docket number helper");
assert.match(planning, /planning-card-docket-number/, "Planning/worklog cards render docket number label");

assert.match(app, /const \[searchScope, setSearchScope\] = useState\("view"\)/, "Search defaults to View scope");
assert.match(app, /\{option === "view" \? "View" : "Global"\}/, "Header exposes compact View/Global toggle");
assert.match(app, /searchScope === "global" \? workItems : baseGraphWorkItems/, "Global search candidates come from canonical dockets");
assert.match(app, /searchScope === "global" \? EMPTY_SEARCH_FILTERS : inheritedSearchFilters/, "Global scope drops automatic view-context filters");
assert.match(app, /exactDocketNumberMatch: true/, "Exact docket number matches are marked");
assert.match(app, /return \[\.\.\.exactDocketMatches, \.\.\.textMatches\]/, "Exact docket matches take precedence over text matches");
assert.match(app, /graphContainsCanonicalItem\(graphWorkItems, item\.id\)/, "Global navigation checks whether the current graph already renders the docket");
assert.match(app, /globalSearchViewForItem\(item\)/, "Global navigation chooses a legitimate context view");
assert.match(app, /setContextSelections\(\(current\) => \(\{[\s\S]*\[nextViewMode\]: item\.id/, "Global navigation sets the selected context to the canonical docket");
assert.match(app, /preserveSearchOnNextContextChangeRef\.current = true/, "Global navigation preserves search while changing context");

assert.match(graphView, /instance\.setViewport\([\s\S]*graphCenter\.x - nodeCenter\.x \* zoom/, "Search centering uses React Flow viewport APIs");
assert.doesNotMatch(graphView, /scrollIntoView/, "Graph search centering does not use DOM scrolling");
assert.match(css, /\.node-docket-number/, "Graph docket number label has styling");
assert.match(css, /\.inline-search-scope/, "Search scope toggle has styling");

console.log("Docket ID display and search scope verification PASS");
