import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync("src/App.jsx", "utf8");
const css = readFileSync("src/App.css", "utf8");

function includes(source, pattern, label) {
  assert.match(source, pattern, label);
}

const modalBackdropCss = css.match(/\.modal-backdrop \{[\s\S]*?\n\}/)?.[0] || "";
const modalCardCss = css.match(/\.modal-card \{[\s\S]*?\n\}/)?.[0] || "";
const addExistingBackdropCss = css.match(/\.add-existing-backdrop \{[\s\S]*?\n\}/)?.[0] || "";
const worklogSidePanelCss = css.match(/\.worklog-side-panel \{[\s\S]*?\n\}/)?.[0] || "";
const overlayOffsetBody =
  app.match(/function updateApplicationOverlayOffset[\s\S]*?\n\}/)?.[0] || "";

includes(css, /--app-overlay-top: 0px;/, "global overlay top token exists");
includes(
  overlayOffsetBody,
  /document\.querySelector\("\.app-main-content"\)/,
  "overlay offset is measured from the actual graph/content top"
);
includes(
  app,
  /new ResizeObserver\(scheduleUpdate\)/,
  "overlay offset updates when top chrome size changes"
);
includes(
  app,
  /\.top-toolbar[\s\S]*\.day-timeline-navigation[\s\S]*\.toolbar-secondary-actions[\s\S]*\.app-main-content/,
  "overlay measurement observes header, timeline, secondary actions, and workspace"
);
includes(
  modalBackdropCss,
  /inset: var\(--app-overlay-top, 0px\) 0 0 0;/,
  "drawer-style modal backdrops start below app chrome"
);
includes(
  modalBackdropCss,
  /z-index: var\(--layer-modal, 520\);/,
  "drawer-style modal backdrops render above header, timeline, popovers, and graph"
);
includes(
  modalBackdropCss,
  /pointer-events: auto;/,
  "drawer-style modal backdrops intercept graph clicks for outside-dismiss behavior"
);
includes(
  modalCardCss,
  /max-height: calc\(100vh - var\(--app-overlay-top, 0px\) - 28px\);/,
  "drawer-style modal cards fit inside the remaining viewport"
);
includes(
  addExistingBackdropCss,
  /inset: 0;/,
  "true Add Existing modal remains a full-viewport overlay"
);
includes(
  css,
  /\.add-existing-backdrop \.modal-card \{[\s\S]*max-height: min\(680px, calc\(100vh - 48px\)\);/,
  "centered Add Existing modal keeps its own viewport max-height"
);
includes(
  worklogSidePanelCss,
  /top: calc\(var\(--app-overlay-top, 56px\) \+ 14px\);/,
  "legacy worklog side panel uses the same app chrome offset"
);
includes(
  worklogSidePanelCss,
  /z-index: var\(--layer-modal, 520\);/,
  "legacy worklog side panel renders above app chrome and graph"
);

console.log("Global overlay layering verification PASS");
