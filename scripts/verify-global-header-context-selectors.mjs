import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const app = readFileSync("src/App.jsx", "utf8");
const css = readFileSync("src/App.css", "utf8");

function includes(source, pattern, label) {
  assert.match(source, pattern, label);
}

includes(app, /function ContextGraphSelector\(/, "shared ContextGraphSelector remains the single context selector");
includes(app, /contextOptionsForView\(\{ viewMode, sprints: graphScopeOptions, workItems \}\)/, "context selector uses real normalized view data");
includes(app, /if \(viewMode === "sprint"\)[\s\S]*return sprints\.filter/, "Sprint View uses actual sprint options");
includes(app, /return workItems\.filter\(\(item\) => item\.type === viewMode\)/, "docket context views use actual work item options");
includes(app, /function normalizeContextSearch\(value\)/, "search normalization is shared");
includes(app, /contextOptionSearchText\(option, viewMode\)\.includes\(normalized\)/, "filtering starts from normalized query");
includes(app, /option\?\.title,[\s\S]*option\?\.name,[\s\S]*option\?\.num,[\s\S]*option\?\.code/, "search includes useful title/name/number/code fields");
includes(app, /onClick=\{openSelector\}[\s\S]*onFocus=\{openSelector\}/, "selector opens immediately on click or focus");
includes(app, /inputRef\.current\?\.focus\(\)/, "search input is focused when the dropdown opens");
includes(app, /if \(!normalized\) return options;/, "options display before typing");
includes(app, /setQuery\(event\.target\.value\);[\s\S]*openSelector\(\);/, "typing filters from the first character");
includes(app, /selectOption\(optionId\)[\s\S]*onChange\(optionId\);[\s\S]*closeSelector\(\{ focusTrigger: true \}\);/, "selection uses existing handler and closes/resets");
includes(app, /selectorRef\.current\?\.contains\(event\.target\)/, "outside click ignores internal dropdown clicks");
includes(app, /window\.addEventListener\("pointerdown", handlePointerDown\)/, "outside pointer listener is registered");
includes(app, /window\.removeEventListener\("pointerdown", handlePointerDown\)/, "outside pointer listener is cleaned up");
includes(app, /event\.key === "Escape"[\s\S]*closeSelector\(\{ focusTrigger: true \}\)/, "Escape closes and restores focus");
includes(app, /event\.key === "ArrowDown"[\s\S]*event\.key === "ArrowUp"[\s\S]*event\.key === "Enter"/, "keyboard navigation supports arrows and Enter");
includes(app, /No matching results/, "search empty state is specific");
includes(app, /No \$\{label\}s available/, "zero-option empty state is specific to the view label");
includes(css, /\.view-context-area \{[\s\S]*overflow: visible;/, "header context area does not clip dropdowns");
includes(css, /\.context-graph-menu \{[\s\S]*z-index: 80;[\s\S]*overflow: auto;[\s\S]*overscroll-behavior: contain;/, "dropdown overlays graph layers and scrolls internally");
console.log("Global header context selector verification PASS");
