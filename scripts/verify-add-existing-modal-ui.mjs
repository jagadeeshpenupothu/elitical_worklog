import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync("src/App.jsx", "utf8");
const css = readFileSync("src/App.css", "utf8");

function includes(source, pattern, message) {
  assert.match(source, pattern, message);
}

const modalBody =
  app.match(/function AddExistingChildModal[\s\S]*?\n}\n\nfunction InlineField/)?.[0] || "";

includes(app, /import \{ createPortal \} from "react-dom";/, "Add Existing modal can render outside app stacking contexts");
includes(modalBody, /return createPortal\(modalContent, document\.body\)/, "Add Existing modal renders through document.body portal");
includes(modalBody, /className="modal-backdrop add-existing-backdrop"/, "Add Existing uses dedicated overlay class");
includes(modalBody, /role="dialog"[\s\S]*aria-modal="true"/, "Add Existing is a real modal dialog");
includes(modalBody, /aria-labelledby="add-existing-title"/, "Modal heading is connected to dialog");
includes(modalBody, /<h2 id="add-existing-title">\{title\}<\/h2>/, "Add Existing heading remains in modal header");
includes(modalBody, /handleBackdropMouseDown[\s\S]*event\.target !== event\.currentTarget[\s\S]*onClose\(\)/, "Outside click closes without swallowing inside clicks");
includes(modalBody, /event\.key === "Escape"[\s\S]*onClose\(\)/, "Escape closes modal");
includes(modalBody, /onClick=\{\(\) => onSelect\(item\.id\)\}/, "Selection workflow still calls onSelect with item id");
includes(modalBody, /className="modal-body add-existing-body"[\s\S]*<label className="modal-field wide"[\s\S]*<div className="day-add-existing-list">/, "Search stays outside the scrollable results list");

includes(css, /--layer-header: 260;/, "Header layer exists");
includes(css, /--layer-timeline: 180;/, "Timeline layer exists");
includes(css, /--layer-popover: 340;/, "Popover layer exists");
includes(css, /--layer-modal: 520;/, "Modal layer is above header, timeline, and popovers");
includes(css, /\.add-existing-backdrop\s*\{[\s\S]*z-index: var\(--layer-modal/, "Add Existing overlay uses modal z-index");
includes(css, /\.add-existing-backdrop\s*\{[\s\S]*place-items: center/, "Add Existing modal is centered in the viewport");
includes(css, /\.day-add-existing-modal\s*\{[\s\S]*max-height: min\(680px, calc\(100vh - 48px\)\)/, "Modal has sensible viewport max-height");
includes(css, /\.add-existing-body\s*\{[\s\S]*grid-template-rows: auto minmax\(0, 1fr\)/, "Search/header area is fixed while list scrolls");
includes(css, /\.add-existing-body\s*\{[\s\S]*overflow: hidden/, "Whole modal body does not become the main scroller");
includes(css, /\.day-add-existing-list\s*\{[\s\S]*overflow: auto/, "Only results list scrolls");
includes(css, /\.day-add-existing-list\s*\{[\s\S]*min-height: 120px/, "Results list has bounded internal scroll area");

console.log("Add Existing modal UI verification PASS");
