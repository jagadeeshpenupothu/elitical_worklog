import { memo, useState } from "react";
import { Handle, Position } from "reactflow";
import { ROOT_ID } from "../utils/worklogModel";

function stopCanvasEvent(event) {
  event.stopPropagation();
}

function hasStoryPoints(data) {
  return (
    data.type === "story" ||
    data.type === "epic" ||
    data.type === "story-root"
  );
}

function storyPointValue(data) {
  return data.type === "story"
    ? data.storyPoints || 0
    : data.calculatedStoryPoints || 0;
}

function formatTime(minutes) {
  const safeMinutes = Math.max(0, Math.round(Number(minutes) || 0));
  const officeDayMinutes = 8 * 60;

  if (safeMinutes <= officeDayMinutes) {
    return [
      String(Math.floor(safeMinutes / 60)).padStart(2, "0"),
      String(safeMinutes % 60).padStart(2, "0"),
    ].join(":");
  }

  const days = Math.floor(safeMinutes / officeDayMinutes);
  const remainder = safeMinutes % officeDayMinutes;

  return [
    String(days).padStart(2, "0"),
    String(Math.floor(remainder / 60)).padStart(2, "0"),
    String(remainder % 60).padStart(2, "0"),
  ].join(":");
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

function childTypes(data) {
  if (data.id === ROOT_ID) return ["epic"];
  if (data.type === "epic") return ["story", "task"];
  if (data.type === "story") return ["job"];
  return [];
}

function nodeIcon(data) {
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
  const [menuOpen, setMenuOpen] = useState(false);
  const availableChildTypes = childTypes(data);
  const showSp = hasStoryPoints(data);
  const timeValue = data.calculatedTimeMinutes || 0;

  function startChild(type, event) {
    stopCanvasEvent(event);
    setMenuOpen(false);
    data.onStartChild(type, data.id);
  }

  return (
    <div
      className={`jira-node ${data.type} docket-${data.docketState || "concept"} ${
        data.selected ? "selected" : ""
      }`}
      title={data.title}
    >
      <Handle type="target" position={Position.Top} />

      <div className="node-collapsed">
        {nodeIcon(data) || (
          <span className="node-type-icon node-type-icon-spacer" aria-hidden="true" />
        )}

        <div className="node-title">
          {data.title}
        </div>

        <div className="node-meta">
          {showSp && (
            <div className="node-meta-pill">
              {storyPointValue(data)} SP
            </div>
          )}
          <div className="node-meta-pill">
            {formatTime(timeValue)}
          </div>
          <div className="node-meta-pill node-updated">
            {formatShortDate(data.updatedAt || data.createdAt)}
          </div>
        </div>
      </div>

      {availableChildTypes.length > 0 && (
        <div className="node-child-action">
          {availableChildTypes.length === 1 ? (
            <button
              type="button"
              className="add-child-button nodrag nopan"
              onPointerDown={stopCanvasEvent}
              onClick={(event) =>
                startChild(availableChildTypes[0], event)
              }
              aria-label="Add child"
            >
              +
            </button>
          ) : (
            <>
              <button
                type="button"
                className="add-child-button nodrag nopan"
                onPointerDown={stopCanvasEvent}
                onClick={(event) => {
                  stopCanvasEvent(event);
                  setMenuOpen((open) => !open);
                }}
                aria-label="Add child"
              >
                +
              </button>
              {menuOpen && (
                <div
                  className="child-menu nodrag nopan"
                  onPointerDown={stopCanvasEvent}
                  onClick={stopCanvasEvent}
                >
                  <button
                    type="button"
                    onClick={(event) =>
                      startChild("story", event)
                    }
                  >
                    Add Story
                  </button>
                  <button
                    type="button"
                    onClick={(event) =>
                      startChild("task", event)
                    }
                  >
                    Add Task
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

export default memo(JiraNode);
