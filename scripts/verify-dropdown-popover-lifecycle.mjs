import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync("src/App.jsx", "utf8");
const css = readFileSync("src/App.css", "utf8");

function includes(source, pattern, label) {
  assert.match(source, pattern, label);
}

function excludes(source, pattern, label) {
  assert.doesNotMatch(source, pattern, label);
}

const hookBody =
  app.match(/function useDismissableLayer[\s\S]*?\n}\n\nfunction readBacklogGroupingPreference/)?.[0] ||
  "";
const viewSelectorBody =
  app.match(/function ViewSelector[\s\S]*?\n}\n\nfunction ViewSummaryStats/)?.[0] ||
  "";
const timelineBody =
  app.match(/function DayTimelineNavigation[\s\S]*?\n}\n\nfunction canonicalAddExistingUpdates/)?.[0] ||
  "";
const globalActionsBody =
  app.match(/function GlobalActions[\s\S]*?\n}\n\nfunction GlobalViewHeader/)?.[0] ||
  "";
const appReturnBody =
  app.match(/return \(\n    <div className=\{`app-container[\s\S]*?\n      <LogViewerModal/)?.[0] ||
  "";

includes(hookBody, /window\.addEventListener\("pointerdown", handlePointerDown\)/, "shared hook listens for outside pointerdown");
includes(hookBody, /window\.addEventListener\("keydown", handleKeyDown\)/, "shared hook listens for Escape");
includes(hookBody, /node\.contains\(target\)/, "shared hook preserves trigger/menu clicks");
includes(hookBody, /event\.composedPath/, "shared hook supports composed event paths");
includes(hookBody, /if \(event\.key !== "Escape"\) return/, "shared hook only handles Escape key dismiss");
includes(hookBody, /onDismiss\(\)/, "shared hook calls the caller's close handler");

includes(viewSelectorBody, /const selectorRef = useRef\(null\)/, "View dropdown has a containment ref");
includes(viewSelectorBody, /useDismissableLayer\(\{[\s\S]*open: viewMenuOpen[\s\S]*refs: \[selectorRef\][\s\S]*onDismiss: onClose/, "View dropdown closes on outside click and Escape");
includes(viewSelectorBody, /onClick=\{onToggle\}/, "View dropdown trigger toggles open/closed");
includes(viewSelectorBody, /onClick=\{\(\) => \{[\s\S]*onSelect\(view\.id\);[\s\S]*onClose\(\);/, "View dropdown option selects and closes");

includes(timelineBody, /const modeMenuRef = useRef\(null\)/, "Timeline mode dropdown has a containment ref");
includes(timelineBody, /useDismissableLayer\(\{[\s\S]*open: modeMenuOpen[\s\S]*refs: \[modeMenuRef\][\s\S]*onDismiss: \(\) => setModeMenuOpen\(false\)/, "Timeline mode dropdown closes on outside click and Escape");
includes(timelineBody, /onClick=\{\(\) => setModeMenuOpen\(\(current\) => !current\)\}/, "Timeline mode trigger toggles open/closed");
includes(timelineBody, /setMode\(id\);[\s\S]*setModeMenuOpen\(false\);/, "Timeline mode option selects and closes");
excludes(timelineBody, /syncPendingToElitical|syncLiveEliticalData|fetch\(/, "Timeline dropdown does not trigger sync or network behavior");

includes(globalActionsBody, /ref=\{syncStatusPopoverRef\}/, "Sync popover has a containment ref");
includes(app, /useDismissableLayer\(\{[\s\S]*open: syncStatusPopoverOpen[\s\S]*refs: \[syncStatusPopoverRef\][\s\S]*onDismiss: \(\) => setSyncStatusPopoverOpen\(false\)/, "Sync popover closes on outside click and Escape");
includes(app, /onToggleSyncStatus=\{\(\) => \{[\s\S]*setViewMenuOpen\(false\);[\s\S]*setSyncStatusPopoverOpen\(\(open\) => !open\);/, "Opening Sync closes conflicting View menu");
includes(appReturnBody, /onToggleViewMenu=\{\(\) => \{[\s\S]*setSyncStatusPopoverOpen\(false\);[\s\S]*setViewMenuOpen\(\(open\) => !open\);/, "Opening View closes conflicting Sync popover");
includes(appReturnBody, /onCloseViewMenu=\{\(\) => setViewMenuOpen\(false\)\}/, "View outside-close uses an explicit close handler");

includes(css, /--layer-timeline: 180;/, "timeline layer token exists");
includes(css, /--layer-header: 260;/, "header layer token exists");
includes(css, /--layer-popover: 340;/, "popover layer token exists");
includes(css, /\.top-toolbar \{[\s\S]*z-index: var\(--layer-header\);[\s\S]*overflow: visible;/, "header permits anchored dropdown overlays");
includes(css, /\.day-timeline-navigation \{[\s\S]*z-index: var\(--layer-timeline\);[\s\S]*overflow: visible;/, "timeline row no longer clips mode menu");
includes(css, /\.view-selector-menu \{[\s\S]*position: absolute;[\s\S]*z-index: var\(--layer-popover\);[\s\S]*max-width: min\(260px, calc\(100vw - 28px\)\);[\s\S]*max-height: min\(70vh, 420px\);[\s\S]*overflow: auto;/, "View menu overlays content and remains viewport-safe");
includes(css, /\.timeline-mode-menu \{[\s\S]*position: absolute;[\s\S]*z-index: var\(--layer-popover\);[\s\S]*max-width: calc\(100vw - 28px\);/, "Timeline mode menu overlays date cards");
includes(css, /\.sync-status-popover \{[\s\S]*position: absolute;[\s\S]*z-index: var\(--layer-popover\);[\s\S]*width: min\(300px, calc\(100vw - 28px\)\);[\s\S]*max-height: min\(72vh, 520px\);[\s\S]*overflow: auto;/, "Sync popover overlays surrounding rows and remains viewport-safe");

excludes(app, /requestFullscreen|exitFullscreen/, "dropdown lifecycle does not change app fullscreen behavior");
excludes(viewSelectorBody, /syncPendingToElitical|syncLiveEliticalData/, "View dropdown does not trigger sync");
excludes(timelineBody, /syncPendingToElitical|syncLiveEliticalData/, "Timeline dropdown does not trigger sync");
excludes(globalActionsBody, /syncPendingToElitical\(|syncLiveEliticalData\(/, "Sync status popover render does not execute sync");

console.log("Dropdown/popover lifecycle verification PASS");
