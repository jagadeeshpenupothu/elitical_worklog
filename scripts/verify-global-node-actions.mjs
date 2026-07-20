import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const app = readFileSync("src/App.jsx", "utf8");
const css = readFileSync("src/App.css", "utf8");
const node = readFileSync("src/components/JiraNode.jsx", "utf8");
const graph = readFileSync("src/views/GraphView.jsx", "utf8");
const capabilities = readFileSync("src/utils/nodeCapabilities.js", "utf8");
const addExistingCapabilitiesBody =
  capabilities.match(/export function childAddExistingTypesForCanonicalType[\s\S]*?\n}\n/)?.[0] || "";

function includes(source, pattern, label) {
  assert.match(source, pattern, label);
}

function excludes(source, pattern, label) {
  assert.doesNotMatch(source, pattern, label);
}

includes(node, /createPortal\(/, "node child action menu renders through a portal");
includes(node, /document\.body/, "portal target is document.body");
includes(node, /getBoundingClientRect\(\)/, "menu anchors to the plus button rect");
includes(node, /window\.innerWidth[\s\S]*window\.innerHeight/, "menu positioning uses viewport dimensions");
includes(node, /opensAbove/, "menu can open above when there is not enough space below");
includes(node, /Math\.min\([\s\S]*Math\.max\(/, "menu shifts horizontally to stay inside viewport");
includes(node, /childMenuRef\.current\?\.contains\(event\.target\)/, "portal menu remains clickable and ignored by outside close");
includes(node, /window\.addEventListener\("pointerdown", handlePointerDown\)/, "outside click closes node action menu");
includes(node, /event\.key === "Escape"/, "Escape closes node action menu");
includes(css, /\.node-child-menu \{[\s\S]*position: fixed;[\s\S]*z-index: 95;/, "portal menu renders above graph stacking contexts");
includes(css, /\.floating-node-child-menu/, "floating menu has shared styling");
includes(capabilities, /if \(type === "sprint"\) return \["epic"\]/, "Sprint can create Epic globally");
includes(capabilities, /if \(type === "epic"\) return \["story", "task"\]/, "Epic valid create children are Story and Task");
includes(capabilities, /if \(type === "story"\) return \["job"\]/, "Story can create Job");
includes(capabilities, /childAddExistingTypesForCanonicalType/, "Add Existing capabilities are centralized");
includes(capabilities, /if \(type === "sprint"\) return \["epic"\]/, "Sprint Add Existing Epic is supported");
includes(capabilities, /if \(type === "epic"\) return \["story"\]/, "Epic Add Existing Story is supported");
excludes(addExistingCapabilitiesBody, /type === "story"/, "Story Add Existing Job is not exposed without a safe canonical move path");
includes(capabilities, /label: `Add Existing \$\{type\.charAt\(0\)\.toUpperCase\(\)\}\$\{type\.slice\(1\)\}`/, "menu labels derive from child type");
includes(capabilities, /label: `Create New \$\{type\.charAt\(0\)\.toUpperCase\(\)\}\$\{type\.slice\(1\)\}`/, "create labels derive from child type");
includes(app, /capabilityActionItemsForNode\(node\)/, "App uses shared capability action builder");
excludes(app, /if \(viewMode !== "day"\) return \[\]/, "child actions are no longer Day View-only");
includes(app, /mode: viewMode === "day" \? "day" : "canonical"/, "Add Existing execution distinguishes Day projection and canonical contexts");
includes(app, /addDayProjectionSelection\(/, "Day View Add Existing still uses projection-only selection");
includes(app, /canonicalAddExistingUpdates/, "canonical Add Existing uses explicit update payload helper");
includes(app, /updateEliticalDocket\(canonicalDocketId, updates\)/, "canonical Add Existing reuses local-first update endpoint");
includes(app, /Add Existing is not supported for this relationship yet/, "unsupported canonical reparenting is not faked");
includes(app, /action\.kind !== "add-existing"[\s\S]*node\.isOrphanSprint/, "Orphan Sprint no-sprint Add Existing is not offered outside Day projection context");
includes(graph, /childActionItemsForNode\?\.\(sprint\)/, "Sprint nodes receive shared action capabilities in graph views");
includes(graph, /childActionItemsForNode\?\.\(item\)/, "Docket nodes receive shared action capabilities in graph views");
includes(graph, /canCreateChildForNode\(item\) \|\| childActionItems\.length > 0/, "future JiraNode graph views inherit capability rendering");

console.log("Global node action menu verification PASS");
