import assert from "node:assert/strict";
import fs from "node:fs/promises";

const appSource = await fs.readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
const graphSource = await fs.readFile(new URL("../src/views/GraphView.jsx", import.meta.url), "utf8");
const nodeSource = await fs.readFile(new URL("../src/components/JiraNode.jsx", import.meta.url), "utf8");

assert.match(graphSource, /function canonicalDocketNodeId/);
assert.match(graphSource, /"epic", "story", "task", "job"/);
assert.match(graphSource, /onOpenDetails\(canonicalId\)/);
assert.doesNotMatch(graphSource, /if \(isReferenceNode\(node\.data\)\) return;/);

const nodeClickBlock = graphSource.slice(
  graphSource.indexOf("const handleNodeClick"),
  graphSource.indexOf("const handlePaneClick")
);
assert.match(nodeClickBlock, /canonicalDocketNodeId\(node\)/);
assert.match(nodeClickBlock, /onOpenDetails\(canonicalId\)/);
assert.doesNotMatch(nodeClickBlock, /onSelect\(node\.data\?\.sourceId \|\| node\.id\)/);

assert.match(appSource, /function resolveCanonicalWorkItem/);
assert.match(appSource, /item\.sourceItemId, item\.sourceDocketId, item\.sourceId/);
assert.match(appSource, /\["epic", "story", "job", "task"\]\.includes\(selectedItem\.type\)/);
assert.doesNotMatch(appSource, /selectedItem\?\.type === "job"[\s\S]{0,80}setModal\(null\)/);

assert.match(nodeSource, /className="add-child-button nodrag nopan"/);
assert.match(nodeSource, /onPointerDown=\{stopCanvasEvent\}/);
assert.match(nodeSource, /startChild\(availableChildTypes\[0\], event\)/);

console.log("Graph node details interaction verification PASS");
