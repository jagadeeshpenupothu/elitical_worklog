import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { getLayoutedElements } from "../src/utils/dagreLayout.js";
import { ROOT_ID } from "../src/utils/worklogModel.js";
import { buildProjectedHierarchy } from "../src/utils/hierarchyProjection.js";

const graphView = readFileSync("src/views/GraphView.jsx", "utf8");
const app = readFileSync("src/App.jsx", "utf8");

function includes(source, pattern, label) {
  assert.match(source, pattern, label);
}

function excludes(source, pattern, label) {
  assert.doesNotMatch(source, pattern, label);
}

const dataPassBody =
  graphView.match(/useLayoutEffect\(\(\) => \{\n    setNodes\(\(currentNodes\) => \{[\s\S]*?\n  \}, \[/)?.[0] ||
  "";
const layoutPassBody =
  graphView.match(/useLayoutEffect\(\(\) => \{\n    if \(\n      layoutNonce[\s\S]*?\n  \}, \[/)?.[0] ||
  "";
const fitViewBody =
  graphView.match(/const handleFitView = useCallback[\s\S]*?\n  \}, \[\]\);/)?.[0] ||
  "";
const createItemBody =
  app.match(/const createItem = useCallback\(async \(payload\) => \{[\s\S]*?\n  \}, \[/)?.[0] ||
  "";

includes(
  dataPassBody,
  /if \(appliedLayoutKeyRef\.current !== layoutStructureKey\) \{[\s\S]*return currentNodes;/,
  "structural graph changes skip the raw pre-layout node update"
);
includes(
  layoutPassBody,
  /const viewportBeforeLayout =[\s\S]*reactFlowRef\.current\?\.getViewport\?\.\(\)/,
  "structural layout captures the current React Flow viewport"
);
includes(
  layoutPassBody,
  /reactFlowRef\.current\?\.setViewport\?\.\(viewportBeforeLayout,[\s\S]*duration: 0/,
  "structural layout restores viewport without visible pan/zoom animation"
);
includes(
  layoutPassBody,
  /window\.cancelAnimationFrame\(restoreViewportFrame\)/,
  "scheduled viewport restore is cleaned up if superseded"
);
includes(
  layoutPassBody,
  /!activeSearchId && initialViewCenteredRef\.current/,
  "viewport restore does not block search-result navigation or initial centering"
);
excludes(
  layoutPassBody,
  /fitView\(/,
  "structural graph layout does not call fitView"
);
includes(
  fitViewBody,
  /reactFlowRef\.current\?\.fitView\(/,
  "fitView remains available only from the explicit Fit control"
);
includes(
  createItemBody,
  /applyNormalizedGraphPayload\(result,[\s\S]*preserveView: true/,
  "local create preserves the current graph view"
);
includes(
  createItemBody,
  /if \(viewMode === "day" && createdId\) \{[\s\S]*addRetainedCreationContext/,
  "Day View retained local creation context is still applied during create"
);
excludes(
  createItemBody,
  /fitView|setViewport|setViewRootId/,
  "local create does not directly fit, pan, zoom, or reset the graph root"
);

const rootNode = {
  id: ROOT_ID,
  type: "jiraNode",
  position: { x: 120, y: 64 },
  data: { type: "story-root" },
  width: 240,
  height: 58,
};
const epicNode = {
  id: "epic-1",
  type: "jiraNode",
  position: { x: 120, y: 234 },
  data: { type: "epic" },
  width: 240,
  height: 58,
};
const storyNode = {
  id: "local-story-1",
  type: "jiraNode",
  position: { x: 0, y: 64 },
  data: { type: "story" },
  width: 240,
  height: 58,
};
const layout = getLayoutedElements(
  [rootNode, epicNode, storyNode],
  [
    { id: `${ROOT_ID}-epic-1`, source: ROOT_ID, target: "epic-1" },
    { id: "epic-1-local-story-1", source: "epic-1", target: "local-story-1" },
  ],
  ROOT_ID
);
const storyLayoutNode = layout.nodes.find((node) => node.id === "local-story-1");

assert.notDeepEqual(
  storyLayoutNode.position,
  storyNode.position,
  "newly created node receives its final hierarchy layout instead of remaining at a default position"
);
assert.equal(
  layout.nodes.filter((node) => node.id === "local-story-1").length,
  1,
  "newly created node remains a single canonical graph node"
);

const projected = buildProjectedHierarchy({
  items: [
    {
      id: "local-story-1",
      type: "story",
      title: "Local Story",
      parentId: "epic-1",
      sprintId: "sprint-1",
    },
  ],
  allItems: [
    {
      id: "epic-1",
      type: "epic",
      title: "Epic",
      parentId: ROOT_ID,
      sprintId: "sprint-1",
    },
    {
      id: "local-story-1",
      type: "story",
      title: "Local Story",
      parentId: "epic-1",
      sprintId: "sprint-1",
    },
  ],
  scopes: [{ id: "sprint-1", title: "Sprint 1" }],
}).items;

assert.equal(
  projected.filter((item) => item.id === "local-story-1").length,
  1,
  "retained/projected create path does not duplicate the canonical node"
);

console.log("Graph create viewport stability verification PASS");
