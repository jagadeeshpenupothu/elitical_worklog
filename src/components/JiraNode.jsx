import { memo, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Handle, Position } from "reactflow";
import {
  childActionItemsForNode,
  childCreateTypesForNode,
} from "../utils/nodeCapabilities";
import { formatWorkDuration } from "../utils/durationFormat";
import {
  docketStateCssClass,
  docketStateLabel,
} from "../utils/docketStates";
import { docketNumberForItem } from "../utils/docketIdentity";

function stopCanvasEvent(event) {
  event.stopPropagation();
}

function hasStoryPoints(data) {
  return (
    data.type === "story" ||
    data.type === "epic" ||
    data.type === "main-root" ||
    data.type === "story-root"
  );
}

function storyPointValue(data) {
  return data.type === "story"
    ? data.storyPoints || 0
    : data.calculatedStoryPoints || 0;
}

function formatShortDate(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "--/--";
  }

  return [
    String(date.getDate()).padStart(2, "0"),
    String(date.getMonth() + 1).padStart(2, "0"),
  ].join("/");
}

function syncLabel(sync) {
  if (sync?.status === "pending-create") return "Pending Create";
  if (sync?.status === "pending-update") return "Pending Update";
  if (sync?.status === "sync-unconfirmed") return "Sync Unconfirmed";
  if (sync?.status === "sync-failed") return "Sync Failed";
  return "";
}

function childMenuPosition(anchor, width = 172) {
  if (!anchor) return { top: 0, left: 0 };

  const gap = 8;
  const height = 96;
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
  const belowTop = anchor.bottom + gap;
  const aboveTop = anchor.top - height - gap;
  const opensAbove = belowTop + height > viewportHeight && aboveTop > gap;
  const left = Math.min(
    Math.max(gap, anchor.left + anchor.width / 2 - width / 2),
    Math.max(gap, viewportWidth - width - gap)
  );

  return {
    top: Math.max(gap, opensAbove ? aboveTop : belowTop),
    left,
  };
}

function nodeIcon(data) {
  if (data.type === "completed-summary") {
    return (
      <span className="node-type-icon node-type-icon-summary" aria-hidden="true">
        <svg viewBox="0 0 24 24" focusable="false">
          <path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H10l2 2h6.5A2.5 2.5 0 0 1 21 8.5v9A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5v-11Z" />
        </svg>
      </span>
    );
  }

  if (data.nodeType === "sprint" || data.isSprintNode) {
    return (
      <span className="node-type-icon node-type-icon-sprint" aria-hidden="true">
        <svg viewBox="0 0 24 24" focusable="false">
          <path d="M6 4v16" />
          <path d="M7 5h10l-1.7 3L17 11H7" />
        </svg>
      </span>
    );
  }

  if (
    data.nodeType === "project" ||
    data.isProjectNode ||
    data.type === "main-root" ||
    data.type === "story-root"
  ) {
    return (
      <span className="node-type-icon node-type-icon-project" aria-hidden="true">
        <svg viewBox="0 0 24 24" focusable="false">
          <rect x="4" y="4" width="6" height="6" />
          <rect x="14" y="4" width="6" height="6" />
          <rect x="4" y="14" width="6" height="6" />
          <path d="M10 7h4" />
          <path d="M7 10v4" />
        </svg>
      </span>
    );
  }

  if (data.type === "epic") {
    return (
      <span className="node-type-icon node-type-icon-epic" aria-hidden="true">
        <svg viewBox="0 0 24 24" focusable="false">
          <path d="M13.8 2 4.8 13.1h6.1L9.8 22l9.4-12.1h-6.3L13.8 2Z" />
        </svg>
      </span>
    );
  }

  if (data.type === "story") {
    return (
      <span className="node-type-icon node-type-icon-story" aria-hidden="true">
        <svg viewBox="0 0 24 24" focusable="false">
          <path d="M6 4h12v16l-6-3.5L6 20V4Z" />
        </svg>
      </span>
    );
  }

  if (data.type === "job") {
    return (
      <span className="node-type-icon node-type-icon-job" aria-hidden="true">
        <svg viewBox="0 0 24 24" focusable="false">
          <path d="m4 7 2.6 2.6L11 5.2" />
          <path d="M14 7h6" />
          <path d="m4 16 2.6 2.6L11 14.2" />
          <path d="M14 16h6" />
        </svg>
      </span>
    );
  }

  if (data.type === "task") {
    return (
      <span className="node-type-icon node-type-icon-task" aria-hidden="true">
        <svg viewBox="0 0 24 24" focusable="false">
          <rect x="3" y="3" width="18" height="18" />
          <path d="m7 12 3 3 7-7" />
        </svg>
      </span>
    );
  }

  return null;
}

function JiraNode({ data }) {
  /*
   * JiraNode is the shared docket/node presentation surface for graph-based
   * views. Views decide which projected items to show and where to place them;
   * docket visuals and actions belong here so features stay consistent.
   */
  const availableChildTypes = childCreateTypesForNode(data);
  const docketNumber = docketNumberForItem(data);
  const childActionItems = Array.isArray(data.childActionItems) && data.childActionItems.length
    ? data.childActionItems
    : childActionItemsForNode(data);
  const hasChildActionMenu = childActionItems.length > 0;
  const showSp = hasStoryPoints(data);
  const timeValue = data.calculatedTimeMinutes || 0;
  const summaryControls = data.completedSummaryControls || [];
  const isDayRoot = Boolean(data.isDayRoot);
  const [childMenuOpen, setChildMenuOpen] = useState(false);
  const [floatingMenuPosition, setFloatingMenuPosition] = useState({ top: 0, left: 0 });
  const childActionRef = useRef(null);
  const childMenuRef = useRef(null);

  useEffect(() => {
    if (!childMenuOpen) return undefined;

    function handlePointerDown(event) {
      if (childActionRef.current?.contains(event.target)) return;
      if (childMenuRef.current?.contains(event.target)) return;

      setChildMenuOpen(false);
    }

    function handleKeyDown(event) {
      if (event.key === "Escape") setChildMenuOpen(false);
    }

    function handleViewportChange() {
      const button = childActionRef.current?.querySelector("button");

      if (!button) return;
      setFloatingMenuPosition(childMenuPosition(button.getBoundingClientRect()));
    }

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", handleViewportChange, true);
    window.addEventListener("resize", handleViewportChange);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", handleViewportChange, true);
      window.removeEventListener("resize", handleViewportChange);
    };
  }, [childMenuOpen]);

  function startChild(type, event) {
    stopCanvasEvent(event);
    if (type === "sprint") {
      data.onStartSprint?.();
      return;
    }
    data.onStartChild(type, data.childParentId || data.sourceId || data.id, {
      sprint: data.childSprint,
      sprintId: data.childSprintId,
      isOrphanSprint: data.isOrphanSprint || data.isOrphanSprintContext,
      worklogDate: data.childWorklogDate,
    });
  }

  function triggerChildAction(action, event) {
    stopCanvasEvent(event);
    setChildMenuOpen(false);

    if (action.kind === "create") {
      startChild(action.type, event);
      return;
    }

    data.onAddExistingChild?.({
      type: action.type,
      parentId: data.childParentId || data.sourceItemId || data.sourceDocketId || data.id,
      sourceItemId: data.sourceItemId || data.sourceDocketId || data.sourceId || data.id,
      sprintId: data.childSprintId,
      sprint: data.childSprint,
      isOrphanSprint: data.isOrphanSprint || data.isOrphanSprintContext,
    });
  }

  function toggleChildMenu(event) {
    stopCanvasEvent(event);
    setFloatingMenuPosition(childMenuPosition(event.currentTarget.getBoundingClientRect()));
    setChildMenuOpen((current) => !current);
  }

  function toggleSummary(summaryId, event) {
    stopCanvasEvent(event);
    data.onToggleCompletedSummary?.(summaryId);
  }

  return (
    <div
      className={`jira-node ${data.type} docket-${docketStateCssClass(data.docketState)} ${
        data.selected ? "selected" : ""
      } ${data.searchMatch ? "search-match" : ""} ${
        data.searchActive ? "search-active" : ""
      } ${
        data.isContextNode || data.isSprintContext ? "sprint-context" : ""
      } ${data.isGhost ? "ghost-reference" : ""} ${isDayRoot ? "day-root" : ""}`}
      title={data.title}
    >
      <Handle type="target" position={Position.Top} />

      {data.isGhost && (
        <div className="node-reference-badge">Reference</div>
      )}
      {syncLabel(data.sync) && (
        <div className={`node-sync-badge sync-${data.sync.status}`}>
          {syncLabel(data.sync)}
        </div>
      )}

      <div className="node-collapsed">
        {nodeIcon(data) || (
          <span className="node-type-icon node-type-icon-spacer" aria-hidden="true" />
        )}

        <div className="node-title-block">
          {docketNumber && ["epic", "story", "job", "task"].includes(data.type) && (
            <div className="node-docket-number">
              <span>{docketNumber}</span>
              <span>{docketStateLabel(data.docketState)}</span>
            </div>
          )}
          <div className="node-title">
            {data.title}
          </div>
        </div>

        <div className="node-meta">
          {isDayRoot ? (
            <>
              <div className="node-meta-pill node-state-badge">
                {data.dayWorklogCount || 0} Worklogs
              </div>
              <div className="node-meta-pill">
                {formatWorkDuration(timeValue)} Logged
              </div>
            </>
          ) : (
            <>
              {data.isCompletedSummary ? (
                <div className="node-meta-pill node-state-badge">
                  {data.hiddenCount || 0} Items
                </div>
              ) : (
                <div className="node-meta-pill node-state-badge">
                  {docketStateLabel(data.docketState)}
                </div>
              )}
              {showSp && !data.isCompletedSummary && (
                <div className="node-meta-pill">
                  {storyPointValue(data)} SP
                </div>
              )}
              <div className="node-meta-pill">
                {formatWorkDuration(timeValue)}
              </div>
              <div className="node-meta-pill node-updated">
                {formatShortDate(data.updatedAt || data.createdAt)}
              </div>
            </>
          )}
        </div>
      </div>

      {data.isCompletedSummary && (
        <div className="node-summary-action">
          <button
            type="button"
            className="summary-toggle-button nodrag nopan"
            onPointerDown={stopCanvasEvent}
            onClick={(event) => toggleSummary(data.id, event)}
          >
            Expand
          </button>
        </div>
      )}

      {!data.isCompletedSummary && summaryControls.length > 0 && (
        <div className="node-summary-controls">
          {summaryControls
            .filter((control) => control.expanded)
            .map((control) => (
              <button
                key={control.id}
                type="button"
                className="summary-toggle-button nodrag nopan"
                onPointerDown={stopCanvasEvent}
                onClick={(event) => toggleSummary(control.id, event)}
              >
                Collapse Completed
              </button>
            ))}
        </div>
      )}

      {!data.isCompletedSummary && data.expandedSummaryId && (
        <div className="node-summary-controls">
          <button
            type="button"
            className="summary-toggle-button nodrag nopan"
            onPointerDown={stopCanvasEvent}
            onClick={(event) => toggleSummary(data.expandedSummaryId, event)}
          >
            Collapse Completed
          </button>
        </div>
      )}

      {(hasChildActionMenu || availableChildTypes.length > 0) && (
        <div className="node-child-action" ref={childActionRef}>
          <button
            type="button"
            className="add-child-button nodrag nopan"
            onPointerDown={stopCanvasEvent}
            onClick={(event) => {
              stopCanvasEvent(event);
              if (hasChildActionMenu) {
                toggleChildMenu(event);
                return;
              }

              startChild(availableChildTypes[0], event);
            }}
            aria-label="Add child"
            aria-haspopup={hasChildActionMenu ? "menu" : undefined}
            aria-expanded={hasChildActionMenu ? childMenuOpen : undefined}
          >
            +
          </button>
          {hasChildActionMenu && childMenuOpen && typeof document !== "undefined"
            ? createPortal(
                <div
                  ref={childMenuRef}
                  className="node-child-menu floating-node-child-menu nodrag nopan"
                  style={{
                    top: `${floatingMenuPosition.top}px`,
                    left: `${floatingMenuPosition.left}px`,
                  }}
                  role="menu"
                >
                  {childActionItems.map((action) => (
                    <button
                      key={`${action.kind}:${action.type}:${action.label}`}
                      type="button"
                      onPointerDown={stopCanvasEvent}
                      onClick={(event) => triggerChildAction(action, event)}
                      role="menuitem"
                    >
                      {action.label}
                    </button>
                  ))}
                </div>,
                document.body
              )
            : null}
        </div>
      )}

      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

export default memo(JiraNode);
