import assert from "node:assert/strict";
import fs from "node:fs/promises";

const appSource = await fs.readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
const modalStart = appSource.indexOf("function WorkItemModal");
const modalEnd = appSource.indexOf("function App()", modalStart);

assert.ok(modalStart >= 0, "WorkItemModal must exist");
assert.ok(modalEnd > modalStart, "Unable to isolate WorkItemModal source");

const modalSource = appSource.slice(modalStart, modalEnd);

assert.match(modalSource, /const \[draft, setDraft\] = useState\(initialDraft\)/);
assert.match(modalSource, /const editedDraftFieldsRef = useRef\(new Set\(\)\)/);
assert.match(modalSource, /const commitInFlightRef = useRef\(false\)/);
assert.match(modalSource, /function updateDraft\(field, value\)[\s\S]*setDraft/);
assert.match(modalSource, /function updateDraftFields\(fields\)[\s\S]*setDraft/);

assert.match(modalSource, /async function commitModalDraft/);
assert.match(modalSource, /editedDraftFieldsRef\.current\.size === 0/);
assert.match(modalSource, /onSaveItem\(activeItem\.id/);
assert.match(modalSource, /commitInFlightRef\.current = true/);
assert.match(modalSource, /commitInFlightRef\.current = false/);

assert.match(modalSource, /function discardAndClose/);
assert.match(modalSource, /editedDraftFieldsRef\.current\.clear\(\)/);
assert.match(modalSource, /onClose\(\)/);
assert.match(modalSource, /function handleBackdropMouseDown\(event\)/);
assert.match(modalSource, /event\.target !== event\.currentTarget/);
assert.match(modalSource, /commitModalDraft\(\{ closeAfterCommit: true \}\)/);

assert.match(modalSource, /if \(event\.key === "Escape"\) discardAndClose\(\)/);
assert.match(modalSource, /onClick=\{discardAndClose\}/);
assert.match(modalSource, /onClick=\{handleCancel\}/);
assert.match(modalSource, /onClick=\{handleSave\}/);
assert.doesNotMatch(modalSource, /onCommit=\{handleSave\}/);
assert.match(modalSource, /onCommit=\{finishInlineEdit\}/);
assert.match(modalSource, /onMouseDown=\{handleBackdropMouseDown\}/);
assert.match(modalSource, /onMouseDown=\{\(event\) => event\.stopPropagation\(\)\}/);

assert.equal(modalSource.includes("loadEliticalLookups"), false);
assert.equal(modalSource.includes("SyncService.run"), false);

console.log("Modal draft save semantics verification PASS");
