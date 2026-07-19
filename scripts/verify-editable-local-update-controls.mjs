import assert from "node:assert/strict";
import fs from "node:fs/promises";

const appSource = await fs.readFile(new URL("../src/App.jsx", import.meta.url), "utf8");

[
  "function buildLocalStateOptions",
  "function buildLocalAssigneeOptions",
  "function buildLocalSprintOptions",
  "function buildLocalEpicOptions",
  "function supportedUpdatePayloadForItem",
].forEach((needle) => {
  assert.ok(appSource.includes(needle), `Missing ${needle}`);
});

assert.equal(appSource.includes("loadEliticalLookups"), false, "UI must not restore live Elitical lookups");
assert.match(appSource, /stateId: item\.elitical\?\.stateId \|\| item\.dktStateId \|\| ""/);
assert.match(appSource, /dktStateId/);
assert.match(appSource, /dktStateName/);
assert.match(appSource, /assigneeId/);
assert.match(appSource, /sprintId/);
assert.match(appSource, /sprintName/);
assert.match(appSource, /epicId/);
assert.match(appSource, /isOrphanSprintId\(value\)/);
assert.match(appSource, /activeItem\?\.type === "story"[\s\S]*buildLocalEpicOptions/);
assert.match(appSource, /<ReadOnlyField label="Type" value=\{formatType\(selectedItemType\)\}/);
assert.match(appSource, /parentId: activeItem\.type === "story"/);
assert.equal(appSource.includes("SyncService.run()"), false);

console.log("Editable local update controls verification PASS");
