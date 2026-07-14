import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import GraphView from "./views/GraphView";
import yamlText from "./data/jira.yaml?raw";
import {
  CATEGORIES,
  DOCKET_STATES,
  PRIORITIES,
  ROOT_ID,
  buildWorklogSnapshot,
  calculateStoryPoints,
  createWorkItem,
  deleteWorkItem,
  generateWorkItemId,
  generateSprintId,
  normalizeSeedData,
  normalizeWorklogSnapshot,
  stableSnapshotString,
  updateWorkItem,
} from "./utils/worklogModel";
import { loadLegacyStoryViewState } from "./utils/storage";
import {
  loadCache,
  saveCache,
} from "./utils/cache";
import {
  loadWorklogSnapshot,
  saveWorklogSnapshot,
} from "./services/worklogApi";
import "./App.css";

const MAIN_ROOT_ID = "mainRoot";

function formatType(type) {
  if (type === "main-root") return "Main";
  if (type === "story-root") return "Sprint";
  return `${type.charAt(0).toUpperCase()}${type.slice(1)}`;
}

function makeCreateDraft(type, sprint, docketState) {
  const now = new Date().toISOString();

  return {
    title: "",
    description: "",
    worklogDescription: "",
    worklogDate: formatDateInput(now),
    category: "feature",
    priority: "info",
    sprint,
    docketState,
    storyPoints: 0,
    time: "00:00",
    type,
  };
}

function makeEditDraft(item, fallbackSprint) {
  const primaryWorklog = Array.isArray(item.worklogs)
    ? item.worklogs[0]
    : null;

  return {
    title: item.title || "",
    description: item.description || "",
    worklogDescription: primaryWorklog?.description || item.description || "",
    worklogDate: formatDateInput(
      primaryWorklog?.date || item.updatedAt || item.createdAt
    ),
    category: item.category || "feature",
    priority: item.priority || "info",
    sprint: item.sprint || fallbackSprint,
    docketState: item.docketState || "concept",
    storyPoints: item.storyPoints || 0,
    time: formatTimeInput(primaryWorklog?.timeMinutes || item.timeMinutes || 0),
  };
}

function parseTimeInput(value) {
  const parts = String(value || "")
    .trim()
    .split(":")
    .map((part) => Number(part));

  if (
    parts.length !== 2 ||
    parts.some((part) => !Number.isFinite(part) || part < 0)
  ) {
    return 0;
  }

  const [hours, minutes] = parts;
  const totalMinutes = Math.round(hours) * 60 + Math.min(59, Math.round(minutes));
  return Math.round(totalMinutes / 15) * 15;
}

function formatTimeInput(minutes) {
  const safeMinutes = Math.max(0, Math.round(Number(minutes) || 0));
  const hours = Math.floor(safeMinutes / 60);
  const remainingMinutes = safeMinutes % 60;

  return [
    String(hours).padStart(2, "0"),
    String(remainingMinutes).padStart(2, "0"),
  ].join(":");
}

function formatDateInput(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "";

  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function dateInputToIso(value, fallback) {
  const fallbackDate = new Date(fallback || Date.now());
  const [year, month, day] = String(value || "")
    .split("-")
    .map((part) => Number(part));

  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day)
  ) {
    return Number.isNaN(fallbackDate.getTime())
      ? new Date().toISOString()
      : fallbackDate.toISOString();
  }

  const date = Number.isNaN(fallbackDate.getTime())
    ? new Date()
    : fallbackDate;
  date.setFullYear(year, month - 1, day);

  return date.toISOString();
}

function formatWorkTime(minutes) {
  const safeMinutes = Math.max(0, Math.round(Number(minutes) || 0));
  const officeDayMinutes = 8 * 60;

  if (safeMinutes <= officeDayMinutes) {
    return formatTimeInput(safeMinutes);
  }

  const days = Math.floor(safeMinutes / officeDayMinutes);
  const remainder = safeMinutes % officeDayMinutes;
  const hours = Math.floor(remainder / 60);
  const remainingMinutes = remainder % 60;

  return [
    String(days).padStart(2, "0"),
    String(hours).padStart(2, "0"),
    String(remainingMinutes).padStart(2, "0"),
  ].join(":");
}

function acceptsTime(type) {
  return type === "story" || type === "job";
}

function parentLabel(parentId, workItems) {
  if (parentId === ROOT_ID) return "Sprint";
  const parent = workItems.find((item) => item.id === parentId);
  return parent ? parent.title : parentId;
}

function parentFieldLabel(parentId, workItems) {
  if (parentId === ROOT_ID) return "Sprint";
  const parent = workItems.find((item) => item.id === parentId);
  return parent ? formatType(parent.type) : "Parent";
}

function inheritedSprint(parentId, workItems, rootTitle) {
  let currentParentId = parentId;

  while (currentParentId && currentParentId !== ROOT_ID) {
    const parent = workItems.find((item) => item.id === currentParentId);

    if (!parent) break;
    if (parent.sprint) return parent.sprint;

    currentParentId = parent.parentId;
  }

  return rootTitle;
}

function inheritedDocketState(parentId, workItems, rootDocketState) {
  if (parentId === ROOT_ID) return rootDocketState || "concept";

  const parent = workItems.find((item) => item.id === parentId);
  return parent?.docketState || rootDocketState || "concept";
}

function openChildNames(parentId, workItems) {
  return workItems
    .filter(
      (item) =>
        item.parentId === parentId &&
        (item.docketState || "concept") !== "artifact"
    )
    .map((item) => item.title);
}

function artifactBlockedError(parentId, workItems) {
  const names = openChildNames(parentId, workItems);

  if (names.length === 0) return "";

  return `Close these child boxes first: ${names.join(", ")}.`;
}

function normalizeArtifactRollup(items, rootDocketState) {
  const childIdsByParent = items.reduce((acc, item) => {
    if (!acc.has(item.parentId)) acc.set(item.parentId, []);
    acc.get(item.parentId).push(item.id);
    return acc;
  }, new Map());
  const itemById = new Map(items.map((item) => [item.id, item]));
  const nextStateById = new Map();

  function stateFor(id) {
    if (nextStateById.has(id)) return nextStateById.get(id);

    const item = itemById.get(id);
    const childIds = childIdsByParent.get(id) || [];
    let nextState = item?.docketState || "concept";

    if (childIds.length > 0) {
      const allChildrenArtifact = childIds.every(
        (childId) => stateFor(childId) === "artifact"
      );

      if (allChildrenArtifact) {
        nextState = "artifact";
      } else if (nextState === "artifact") {
        nextState = "concept";
      }
    }

    nextStateById.set(id, nextState);
    return nextState;
  }

  const nextItems = items.map((item) => {
    const nextState = stateFor(item.id);
    return item.docketState === nextState
      ? item
      : {
          ...item,
          docketState: nextState,
        };
  });
  const rootChildIds = childIdsByParent.get(ROOT_ID) || [];
  const nextRootDocketState =
    rootChildIds.length > 0 &&
    rootChildIds.every((id) => stateFor(id) === "artifact")
      ? "artifact"
      : rootDocketState === "artifact"
      ? "concept"
      : rootDocketState || "concept";

  return {
    workItems: nextItems,
    rootDocketState: nextRootDocketState,
  };
}

function normalizeStoryStateArtifactRollup(state) {
  const normalized = normalizeArtifactRollup(
    state.workItems,
    state.rootDocketState || "concept"
  );

  return {
    ...state,
    rootDocketState: normalized.rootDocketState,
    workItems: normalized.workItems,
  };
}

function snapshotFromState(state) {
  const result = buildWorklogSnapshot(
    normalizeStoryStateArtifactRollup(state)
  );

  if (!result.valid) {
    throw new Error(result.error);
  }

  return result.snapshot;
}

function normalizeLoadedSnapshot(snapshot) {
  const result = normalizeWorklogSnapshot(snapshot);

  if (!result.valid) {
    throw new Error(result.error);
  }

  return {
    state: normalizeStoryStateArtifactRollup(result.state),
    snapshot: result.snapshot,
  };
}

function snapshotEquals(first, second) {
  if (!first || !second) return false;
  return stableSnapshotString(first) === stableSnapshotString(second);
}

function descendantsIncluding(items, rootId) {
  if (!rootId) return items;

  const childrenByParent = items.reduce((acc, item) => {
    if (!acc.has(item.parentId)) acc.set(item.parentId, []);
    acc.get(item.parentId).push(item);
    return acc;
  }, new Map());
  const visible = [];
  const pending = [rootId];

  while (pending.length) {
    const id = pending.shift();
    const item = items.find((entry) => entry.id === id);

    if (!item) continue;

    visible.push(item);
    pending.push(...(childrenByParent.get(id) || []).map((child) => child.id));
  }

  return visible;
}

function descendantCount(items, id) {
  return descendantsIncluding(items, id).length - 1;
}

function formatLabel(value) {
  const text = String(value || "")
    .replace(/[-_]/g, " ")
    .trim();

  if (!text) return "-";

  return text.replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatDocketState(state) {
  return formatLabel(state);
}

function formatTimestamp(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "-";

  return new Intl.DateTimeFormat(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatRelativeSync(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "Not synced";

  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));

  if (elapsedSeconds < 60) return "Just now";
  if (elapsedSeconds < 3600) return `${Math.floor(elapsedSeconds / 60)} min ago`;
  if (elapsedSeconds < 86400) return `${Math.floor(elapsedSeconds / 3600)}h ago`;
  return formatDateLabel(value);
}

function formatDateLabel(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "-";

  return new Intl.DateTimeFormat(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

function itemMatchesQuery(item, query) {
  const normalized = query.trim().toLowerCase();

  if (!normalized) return true;

  return [
    item.title,
    item.description,
    item.type,
    item.category,
    item.priority,
    item.docketState,
    item.sprint,
    item.id,
  ].some((value) => String(value || "").toLowerCase().includes(normalized));
}

function sprintMatchesQuery(sprint, query) {
  const normalized = query.trim().toLowerCase();

  if (!normalized) return true;

  return [
    sprint.id,
    sprint.title,
    sprint.docketState,
    "sprint",
  ].some((value) => String(value || "").toLowerCase().includes(normalized));
}

function filterWorkItemsForSearch(items, query) {
  const normalized = query.trim().toLowerCase();

  if (!normalized) return items;

  const itemById = new Map(items.map((item) => [item.id, item]));
  const visibleIds = new Set();

  items.forEach((item) => {
    if (!itemMatchesQuery(item, normalized)) return;

    visibleIds.add(item.id);

    let parentId = item.parentId;

    while (parentId && parentId !== ROOT_ID) {
      visibleIds.add(parentId);
      parentId = itemById.get(parentId)?.parentId;
    }
  });

  return items.filter((item) => visibleIds.has(item.id));
}

function primaryWorklogDate(item) {
  const primary = Array.isArray(item?.worklogs) ? item.worklogs[0] : null;
  return primary?.date || item?.updatedAt || item?.createdAt;
}

function MetadataBadge({ children }) {
  return <span className="metadata-badge">{children || "-"}</span>;
}

function ModalSection({ title, children }) {
  return (
    <section className="modal-section">
      <h3>{title}</h3>
      <div className="modal-section-grid">{children}</div>
    </section>
  );
}

function ReadOnlyField({ label, value, badge = false, wide = false }) {
  return (
    <div className={`modal-field ${wide ? "wide" : ""}`}>
      <span>{label}</span>
      {badge ? (
        <MetadataBadge>{value}</MetadataBadge>
      ) : (
        <strong>{value || "-"}</strong>
      )}
    </div>
  );
}

function InlineField({
  label,
  value,
  field,
  editingField,
  onEdit,
  onChange,
  type = "text",
  options = [],
  step,
  badge = false,
  wide = false,
}) {
  const editing = editingField === field;
  const displayValue =
    type === "select"
      ? formatLabel(value)
      : type === "date"
      ? formatDateLabel(dateInputToIso(value))
      : badge
      ? value
      : value;

  if (editing) {
    if (type === "select") {
      return (
        <label className={`modal-field inline-active ${wide ? "wide" : ""}`}>
          <span>{label}</span>
          <select
            className="modal-control inline-control"
            autoFocus
            value={value}
            onChange={(event) => onChange(event.target.value)}
          >
            {options.map((option) => (
              <option key={option} value={option}>
                {formatLabel(option)}
              </option>
            ))}
          </select>
        </label>
      );
    }

    if (type === "textarea") {
      return (
        <label className={`modal-field inline-active ${wide ? "wide" : ""}`}>
          <span>{label}</span>
          <textarea
            className="modal-control inline-control"
            rows="2"
            autoFocus
            value={value}
            onChange={(event) => onChange(event.target.value)}
          />
        </label>
      );
    }

    return (
      <label className={`modal-field inline-active ${wide ? "wide" : ""}`}>
        <span>{label}</span>
        <input
          className="modal-control inline-control"
          type={type}
          step={step}
          autoFocus
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
    );
  }

  return (
    <div
      className={`modal-field inline-readable ${wide ? "wide" : ""}`}
      onDoubleClick={() => onEdit(field)}
      title="Double-click to edit"
    >
      <span>{label}</span>
      {badge ? (
        <MetadataBadge>{displayValue}</MetadataBadge>
      ) : (
        <strong>{displayValue || "-"}</strong>
      )}
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  step,
  wide = false,
}) {
  return (
    <label className={`modal-field ${wide ? "wide" : ""}`}>
      <span>{label}</span>
      <input
        className="modal-control"
        type={type}
        step={step}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function TextAreaField({ label, value, onChange, wide = false }) {
  return (
    <label className={`modal-field ${wide ? "wide" : ""}`}>
      <span>{label}</span>
      <textarea
        className="modal-control"
        rows="3"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function SelectField({ label, value, options, onChange }) {
  return (
    <label className="modal-field">
      <span>{label}</span>
      <select
        className="modal-control"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {formatLabel(option)}
          </option>
        ))}
      </select>
    </label>
  );
}

function WorkItemModal({
  modal,
  mainTitle,
  rootTitle,
  rootDocketState,
  sprints,
  workItems,
  totals,
  onClose,
  onSaveMain,
  onSaveRoot,
  onSaveSprint,
  onSaveItem,
  onCreateItem,
  onDeleteItem,
  onSetView,
}) {
  const [mode, setMode] = useState(
    modal.kind === "create" ? "edit" : "view"
  );
  const [editingField, setEditingField] = useState(null);
  const isMainRoot =
    modal.kind === "details" && modal.id === MAIN_ROOT_ID;
  const activeSprint =
    modal.kind === "details" && modal.id !== ROOT_ID
      ? sprints.find((sprint) => sprint.id === modal.id)
      : null;
  const activeItem =
    modal.kind === "details" &&
    modal.id !== ROOT_ID &&
    modal.id !== MAIN_ROOT_ID &&
    !activeSprint
      ? workItems.find((item) => item.id === modal.id)
      : null;
  const isRoot =
    modal.kind === "details" && modal.id === ROOT_ID;
  const isSprint = isRoot || Boolean(activeSprint);
  const itemType = isMainRoot
    ? "main-root"
    : isSprint
    ? "story-root"
    : modal.kind === "create"
    ? modal.type
    : activeItem?.type;
  const sprintParentId =
    modal.kind === "create" ? modal.parentId : activeItem?.parentId;
  const fallbackSprint = isSprint || isMainRoot
    ? rootTitle
    : inheritedSprint(sprintParentId, workItems, rootTitle);
  const fallbackDocketState = isSprint
    ? rootDocketState || "concept"
    : isMainRoot
    ? "concept"
    : inheritedDocketState(sprintParentId, workItems, rootDocketState);
  const initialDraft =
    modal.kind === "create"
      ? makeCreateDraft(modal.type, fallbackSprint, fallbackDocketState)
      : isMainRoot
      ? { title: mainTitle || "Genesis" }
      : isRoot
      ? { title: rootTitle, docketState: rootDocketState || "concept" }
      : activeSprint
      ? {
          title: activeSprint.title,
          docketState: activeSprint.docketState || "concept",
        }
      : activeItem
      ? makeEditDraft(activeItem, fallbackSprint)
      : null;
  const [draft, setDraft] = useState(initialDraft);
  const [error, setError] = useState("");
  const isEditing = mode === "edit";
  const parentId =
    modal.kind === "create" ? modal.parentId : activeItem?.parentId;
  const currentCategory = activeItem?.category || draft?.category || "feature";
  const currentPriority = activeItem?.priority || draft?.priority || "info";
  const currentDocketState = isRoot
    ? rootDocketState || "concept"
    : activeSprint
    ? activeSprint.docketState || "concept"
    : isMainRoot
    ? "concept"
    : activeItem?.docketState || draft?.docketState || "concept";
  const currentSprint = isSprint || isMainRoot
    ? rootTitle
    : activeItem?.sprint || draft?.sprint || fallbackSprint;
  const hasWorklog = acceptsTime(itemType);
  const contextLabel =
    modal.kind === "create"
      ? `Create ${formatType(itemType)}`
      : isMainRoot
      ? "Main"
      : isSprint
      ? "Sprint"
      : `${formatType(activeItem?.type).toUpperCase()} · ${formatLabel(
          currentCategory
        ).toUpperCase()}`;

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === "Escape") onClose();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  if (
    !draft ||
    (
      modal.kind === "details" &&
      !isMainRoot &&
      !isSprint &&
      !activeItem
    )
  ) {
    return null;
  }

  function updateDraft(field, value) {
    setDraft((current) => ({
      ...current,
      [field]: value,
    }));
    setError("");
  }

  function startInlineEdit(field) {
    if (modal.kind !== "details") return;
    setMode("view");
    setEditingField(field);
  }

  function primaryWorklogPayload() {
    if (!hasWorklog) return undefined;

    const otherWorklogs =
      modal.kind === "details" && Array.isArray(activeItem?.worklogs)
        ? activeItem.worklogs.slice(1)
        : [];
    const fallbackDate =
      modal.kind === "details"
        ? primaryWorklogDate(activeItem)
        : new Date().toISOString();

    return [
      {
        date: dateInputToIso(draft.worklogDate, fallbackDate),
        description: draft.worklogDescription.trim(),
        timeMinutes: parseTimeInput(draft.time),
      },
      ...otherWorklogs,
    ];
  }

  function handleSave() {
    if (!draft.title.trim()) {
      setError("Title is required.");
      return;
    }

    if (isMainRoot) {
      const result = onSaveMain({
        title: draft.title,
      });
      if (result.ok) {
        setMode("view");
        setEditingField(null);
      } else {
        setError(result.error);
      }
      return;
    }

    if (isSprint) {
      const result = isRoot ? onSaveRoot({
        title: draft.title,
        docketState: draft.docketState,
      }) : onSaveSprint(activeSprint.id, {
        title: draft.title,
        docketState: draft.docketState,
      });
      if (result.ok) {
        setMode("view");
        setEditingField(null);
      }
      else setError(result.error);
      return;
    }

    const payload = {
      ...draft,
      title: draft.title.trim(),
      description: draft.description.trim(),
      sprint: draft.sprint.trim() || fallbackSprint,
      docketState: draft.docketState || "concept",
      type: itemType,
      storyPoints:
        itemType === "story"
          ? Number(draft.storyPoints || 0)
          : undefined,
      timeMinutes: acceptsTime(itemType)
        ? parseTimeInput(draft.time)
        : undefined,
      worklogs: primaryWorklogPayload(),
    };
    const result =
      modal.kind === "create"
        ? onCreateItem({
            ...payload,
            parentId: modal.parentId,
          })
        : onSaveItem(activeItem.id, {
            ...payload,
            parentId: activeItem.parentId,
          });

    if (!result.ok) {
      setError(result.error);
      return;
    }

    if (modal.kind === "create") {
      onClose();
      return;
    }

    setMode("view");
    setEditingField(null);
  }

  function handleCancel() {
    if (modal.kind === "create") {
      onClose();
      return;
    }

    setDraft(
      isMainRoot
        ? { title: mainTitle || "Genesis" }
        : isRoot
        ? { title: rootTitle, docketState: rootDocketState || "concept" }
        : activeSprint
        ? {
            title: activeSprint.title,
            docketState: activeSprint.docketState || "concept",
          }
        : makeEditDraft(activeItem, fallbackSprint)
    );
    setError("");
    setMode("view");
    setEditingField(null);
  }

  function handleDelete() {
    if (!activeItem) return;

    const childCount = descendantCount(workItems, activeItem.id);

    if (
      childCount > 0 &&
      !window.confirm(
        `${activeItem.title} has ${childCount} child item${
          childCount === 1 ? "" : "s"
        }. Delete it and all children?`
      )
    ) {
      return;
    }

    const result = onDeleteItem(activeItem);
    if (result?.ok !== false) onClose();
  }

  const calculatedSp = isSprint || isMainRoot
    ? totals.rootTotal
    : activeItem?.type === "epic"
    ? totals.byId[activeItem.id] || 0
    : null;
  const calculatedTime = isSprint || isMainRoot
    ? totals.rootTimeMinutes || 0
    : activeItem
    ? totals.timeById[activeItem.id] || 0
    : 0;
  const headerSummary = modal.kind === "create"
    ? `${formatType(itemType)} · ${parentLabel(parentId, workItems)}`
    : isMainRoot
    ? `${sprints.length} Sprint${sprints.length === 1 ? "" : "s"} · ${
        totals.rootTotal
      } SP · ${formatWorkTime(totals.rootTimeMinutes || 0)}`
    : isSprint
    ? `${formatDocketState(currentDocketState)} · ${
        totals.rootTotal
      } SP · ${formatWorkTime(totals.rootTimeMinutes || 0)}`
    : `${formatLabel(currentPriority)} · ${formatDocketState(
        currentDocketState
      )} · ${formatWorkTime(calculatedTime)}`;
  const showFooter = modal.kind === "create" || modal.kind === "details";

  return (
    <div
      className="modal-backdrop"
      onMouseDown={onClose}
    >
      <section
        className="modal-card"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <div className="modal-header-main">
            <span className="modal-kicker">{contextLabel}</span>
            <h2>
              {modal.kind === "create"
                ? "New work item"
                : isMainRoot
                ? mainTitle || "Genesis"
                : isRoot
                ? rootTitle
                : activeSprint
                ? activeSprint.title
                : activeItem.title}
            </h2>
            <p>{headerSummary}</p>
          </div>
          <div className="modal-header-actions">
            {modal.kind === "details" && activeItem && (
              <button
                type="button"
                onClick={() => {
                  onSetView(activeItem.id);
                  onClose();
                }}
              >
                Set View
              </button>
            )}
            <button
              type="button"
              className="icon-button"
              onClick={onClose}
              aria-label="Close"
            >
              ×
            </button>
          </div>
        </header>

        <div className="modal-body">
          {modal.kind === "details" && !isMainRoot && (
            <label className="docket-state-control">
              <span>Docket State</span>
              <select
                className="modal-control"
                value={draft.docketState || currentDocketState}
                onChange={(event) =>
                  updateDraft("docketState", event.target.value)
                }
              >
                {DOCKET_STATES.map((state) => (
                  <option key={state} value={state}>
                    {formatDocketState(state)}
                  </option>
                ))}
              </select>
            </label>
          )}

          {!isEditing ? (
            <div className="modal-sections">
              {isMainRoot ? (
                <>
                  <ModalSection title="Basic Information">
                    <InlineField
                      label="Title"
                      field="title"
                      value={draft.title}
                      editingField={editingField}
                      onEdit={startInlineEdit}
                      onChange={(value) => updateDraft("title", value)}
                      wide
                    />
                  </ModalSection>
                  <ModalSection title="Rollup">
                    <ReadOnlyField
                      label="Sprints"
                      value={String(sprints.length)}
                      badge
                    />
                    <ReadOnlyField
                      label="Calculated Story Points"
                      value={`${totals.rootTotal} SP`}
                      badge
                    />
                    <ReadOnlyField
                      label="Calculated Time"
                      value={formatWorkTime(totals.rootTimeMinutes || 0)}
                      badge
                    />
                  </ModalSection>
                </>
              ) : isSprint ? (
                <>
                  <ModalSection title="Basic Information">
                    <InlineField
                      label="Title"
                      field="title"
                      value={draft.title}
                      editingField={editingField}
                      onEdit={startInlineEdit}
                      onChange={(value) => updateDraft("title", value)}
                      wide
                    />
                  </ModalSection>
                  <ModalSection title="Effort & Time">
                    <ReadOnlyField
                      label="Calculated Story Points"
                      value={`${totals.rootTotal} SP`}
                      badge
                    />
                    <ReadOnlyField
                      label="Calculated Time"
                      value={formatWorkTime(totals.rootTimeMinutes || 0)}
                      badge
                    />
                  </ModalSection>
                </>
              ) : (
                <>
                  <ModalSection title="Basic Information">
                    <InlineField
                      label="Title"
                      field="title"
                      value={draft.title}
                      editingField={editingField}
                      onEdit={startInlineEdit}
                      onChange={(value) => updateDraft("title", value)}
                    />
                    <InlineField
                      label="Description"
                      field="description"
                      value={draft.description}
                      type="textarea"
                      editingField={editingField}
                      onEdit={startInlineEdit}
                      onChange={(value) =>
                        updateDraft("description", value)
                      }
                    />
                  </ModalSection>
                  {hasWorklog && (
                    <ModalSection title="Worklog">
                      <InlineField
                        label="Date"
                        field="worklogDate"
                        value={draft.worklogDate}
                        type="date"
                        editingField={editingField}
                        onEdit={startInlineEdit}
                        onChange={(value) => updateDraft("worklogDate", value)}
                      />
                      <InlineField
                        label="Description"
                        field="worklogDescription"
                        value={draft.worklogDescription}
                        type="textarea"
                        editingField={editingField}
                        onEdit={startInlineEdit}
                        onChange={(value) =>
                          updateDraft("worklogDescription", value)
                        }
                        wide
                      />
                      <InlineField
                        label="Time"
                        field="time"
                        value={draft.time}
                        editingField={editingField}
                        onEdit={startInlineEdit}
                        onChange={(value) => updateDraft("time", value)}
                        badge
                      />
                    </ModalSection>
                  )}
                  <ModalSection title="Workflow">
                    <InlineField
                      label="Category"
                      field="category"
                      value={draft.category}
                      type="select"
                      options={CATEGORIES}
                      editingField={editingField}
                      onEdit={startInlineEdit}
                      onChange={(value) => updateDraft("category", value)}
                      badge
                    />
                    <InlineField
                      label="Priority"
                      field="priority"
                      value={draft.priority}
                      type="select"
                      options={PRIORITIES}
                      editingField={editingField}
                      onEdit={startInlineEdit}
                      onChange={(value) => updateDraft("priority", value)}
                      badge
                    />
                  </ModalSection>
                  <ModalSection title="Hierarchy">
                    <ReadOnlyField
                      label="Type"
                      value={formatType(activeItem.type)}
                    />
                    <ReadOnlyField
                      label={parentFieldLabel(activeItem.parentId, workItems)}
                      value={parentLabel(activeItem.parentId, workItems)}
                    />
                    <ReadOnlyField label="Sprint" value={currentSprint} />
                  </ModalSection>
                  <ModalSection title="Effort & Time">
                    {activeItem.type === "story" && (
                      <InlineField
                        label="Story Points"
                        field="storyPoints"
                        value={draft.storyPoints}
                        type="number"
                        editingField={editingField}
                        onEdit={startInlineEdit}
                        onChange={(value) => updateDraft("storyPoints", value)}
                        badge
                      />
                    )}
                    {activeItem.type === "epic" && (
                      <ReadOnlyField
                        label="Calculated Story Points"
                        value={`${calculatedSp} SP`}
                        badge
                      />
                    )}
                    <ReadOnlyField
                      label="Calculated Time"
                      value={formatWorkTime(calculatedTime)}
                      badge
                    />
                  </ModalSection>
                  <ModalSection title="System Information">
                    <ReadOnlyField
                      label="Created At"
                      value={formatTimestamp(activeItem.createdAt)}
                    />
                    <ReadOnlyField
                      label="Updated At"
                      value={formatTimestamp(activeItem.updatedAt)}
                    />
                  </ModalSection>
                </>
              )}
            </div>
          ) : (
            <div className="modal-sections">
              <ModalSection title="Basic Information">
                <TextField
                  label="Title"
                  value={draft.title}
                  onChange={(value) => updateDraft("title", value)}
                />

                {!isSprint && !isMainRoot && (
                  <TextAreaField
                    label="Description"
                    value={draft.description}
                    onChange={(value) => updateDraft("description", value)}
                  />
                )}
              </ModalSection>

              {!isSprint && !isMainRoot && hasWorklog && (
                <ModalSection title="Worklog">
                  <TextField
                    label="Date"
                    type="date"
                    value={draft.worklogDate}
                    onChange={(value) => updateDraft("worklogDate", value)}
                  />
                  <TextAreaField
                    label="Description"
                    value={draft.worklogDescription}
                    onChange={(value) =>
                      updateDraft("worklogDescription", value)
                    }
                    wide
                  />
                  <TextField
                    label="Time"
                    value={draft.time}
                    placeholder="HH:MM"
                    onChange={(value) => updateDraft("time", value)}
                  />
                </ModalSection>
              )}

              {!isMainRoot && (
                <ModalSection title="Workflow">
                  {isSprint ? (
                    <SelectField
                      label="Docket State"
                      value={draft.docketState || "concept"}
                      options={DOCKET_STATES}
                      onChange={(value) => updateDraft("docketState", value)}
                    />
                  ) : (
                    <>
                      <SelectField
                        label="Category"
                        value={draft.category}
                        options={CATEGORIES}
                        onChange={(value) => updateDraft("category", value)}
                      />

                      <SelectField
                        label="Priority"
                        value={draft.priority}
                        options={PRIORITIES}
                        onChange={(value) => updateDraft("priority", value)}
                      />

                      <SelectField
                        label="Docket State"
                        value={draft.docketState || "concept"}
                        options={DOCKET_STATES}
                        onChange={(value) => updateDraft("docketState", value)}
                      />
                    </>
                  )}
                </ModalSection>
              )}

              {!isSprint && !isMainRoot && (
                <ModalSection title="Hierarchy">
                  <ReadOnlyField label="Type" value={formatType(itemType)} />
                  <ReadOnlyField
                    label={parentFieldLabel(parentId, workItems)}
                    value={parentLabel(parentId, workItems)}
                  />
                  <ReadOnlyField label="Sprint" value={draft.sprint} />
                </ModalSection>
              )}

              {modal.kind !== "create" ||
              itemType === "story" ||
              acceptsTime(itemType) ? (
                <ModalSection title="Effort & Time">
                  {itemType === "story" && (
                    <TextField
                      label="Story Points"
                      type="number"
                      value={draft.storyPoints}
                      onChange={(value) => updateDraft("storyPoints", value)}
                    />
                  )}

                  {acceptsTime(itemType) && !hasWorklog && (
                    <TextField
                      label="Time"
                      value={draft.time}
                      placeholder="HH:MM"
                      onChange={(value) => updateDraft("time", value)}
                    />
                  )}

                  {modal.kind !== "create" && (
                    <>
                      {(isSprint || isMainRoot) && (
                        <ReadOnlyField
                          label="Calculated Story Points"
                          value={`${totals.rootTotal} SP`}
                          badge
                        />
                      )}
                      {!isSprint && !isMainRoot && activeItem.type === "epic" && (
                        <ReadOnlyField
                          label="Calculated Story Points"
                          value={`${calculatedSp} SP`}
                          badge
                        />
                      )}
                      <ReadOnlyField
                        label="Calculated Time"
                        value={formatWorkTime(calculatedTime)}
                        badge
                      />
                    </>
                  )}
                </ModalSection>
              ) : null}

              {modal.kind !== "create" && !isSprint && !isMainRoot && (
                <ModalSection title="System Information">
                  <ReadOnlyField
                    label="Created At"
                    value={formatTimestamp(activeItem.createdAt)}
                  />
                  <ReadOnlyField
                    label="Updated At"
                    value={formatTimestamp(activeItem.updatedAt)}
                  />
                </ModalSection>
              )}
            </div>
          )}

          {error && <p className="modal-error">{error}</p>}
        </div>

        {showFooter && (
          <footer className="modal-footer">
            <div className="modal-footer-danger">
              {modal.kind === "details" && activeItem && (
                <button
                  type="button"
                  className="danger-button"
                  onClick={handleDelete}
                >
                  Delete
                </button>
              )}
            </div>
            <div className="modal-footer-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={handleCancel}
              >
                Cancel
              </button>
              <button type="button" onClick={handleSave}>
                {modal.kind === "create" ? "Create Work Item" : "Save"}
              </button>
            </div>
          </footer>
        )}
      </section>
    </div>
  );
}

function App() {
  const cachedRecord = useMemo(() => loadCache(), []);
  const cachedSnapshot = useMemo(() => {
    if (!cachedRecord?.snapshot) return null;

    try {
      return normalizeLoadedSnapshot(cachedRecord.snapshot);
    } catch {
      return null;
    }
  }, [cachedRecord]);
  const [storyState, setStoryState] = useState(
    cachedSnapshot?.state || null
  );
  const [selectedId, setSelectedId] = useState(null);
  const [modal, setModal] = useState(null);
  const [message, setMessage] = useState("");
  const [layoutNonce, setLayoutNonce] = useState(1);
  const [viewMode, setViewMode] = useState("sprint");
  const [viewRootId, setViewRootId] = useState(null);
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [loadState, setLoadState] = useState(
    cachedSnapshot ? "ready" : "loading"
  );
  const [syncState, setSyncState] = useState(
    cachedSnapshot ? "syncing" : "loading"
  );
  const [saveState, setSaveState] = useState("idle");
  const [baseSha, setBaseSha] = useState(
    cachedSnapshot ? cachedRecord.sha : ""
  );
  const [baselineSnapshot, setBaselineSnapshot] = useState(
    cachedSnapshot?.snapshot || null
  );
  const [lastSyncedAt, setLastSyncedAt] = useState(
    cachedRecord?.lastSyncedAt || ""
  );
  const [legacyState, setLegacyState] = useState(null);
  const [showLegacyNotice, setShowLegacyNotice] = useState(false);

  const {
    mainTitle = "Genesis",
    rootTitle = "",
    rootDocketState = "concept",
    sprints = [],
    workItems = [],
  } = storyState || {};
  const workItemsRef = useRef(workItems);
  const storyStateRef = useRef(storyState);
  const saveRequestIdRef = useRef(0);
  const hasCheckedLegacyRef = useRef(false);
  const initialSyncStartedRef = useRef(false);
  const currentSnapshot = useMemo(
    () => (storyState ? snapshotFromState(storyState) : null),
    [storyState]
  );
  const dirty = Boolean(
    currentSnapshot &&
      baselineSnapshot &&
      !snapshotEquals(currentSnapshot, baselineSnapshot)
  );
  const canSave =
    loadState === "ready" &&
    dirty &&
    syncState !== "offline" &&
    !saveState.startsWith("saving") &&
    baseSha;
  const totals = useMemo(
    () => calculateStoryPoints(workItems),
    [workItems]
  );
  const visibleWorkItems = useMemo(
    () => descendantsIncluding(workItems, viewRootId),
    [viewRootId, workItems]
  );
  const searchedWorkItems = useMemo(
    () => filterWorkItemsForSearch(visibleWorkItems, searchQuery),
    [searchQuery, visibleWorkItems]
  );
  const searchedSprints = useMemo(() => {
    if (viewMode !== "main" || !searchQuery.trim()) return sprints;

    return sprints.filter((sprint) => sprintMatchesQuery(sprint, searchQuery));
  }, [searchQuery, sprints, viewMode]);
  const displayedTotals = useMemo(
    () => calculateStoryPoints(searchedWorkItems),
    [searchedWorkItems]
  );
  const viewRootItem = viewRootId
    ? workItems.find((item) => item.id === viewRootId)
    : null;
  const contextTitle =
    viewMode === "main"
      ? "Main View"
      : viewRootItem
      ? `${viewRootItem.title} View`
      : "Sprint View";
  const contextItemCount =
    searchedWorkItems.length + (viewMode === "main" ? searchedSprints.length : 1);
  const contextStoryPoints =
    viewRootId ? displayedTotals.byId[viewRootId] || 0 : displayedTotals.rootTotal;
  const contextTimeMinutes =
    viewRootId
      ? displayedTotals.timeById[viewRootId] || 0
      : displayedTotals.rootTimeMinutes || 0;

  useEffect(() => {
    workItemsRef.current = workItems;
    storyStateRef.current = storyState;
  }, [storyState, workItems]);

  const checkLegacyState = useCallback((remoteSnapshot) => {
    if (hasCheckedLegacyRef.current) return;

    hasCheckedLegacyRef.current = true;

    const legacy = loadLegacyStoryViewState();

    if (legacy) {
      const legacySnapshot = snapshotFromState(legacy);
      const differs = !snapshotEquals(legacySnapshot, remoteSnapshot);

      if (differs) {
        setLegacyState(legacy);
        setShowLegacyNotice(true);
      }
    }
  }, []);

  const applyLoadedSnapshot = useCallback(({
    snapshot,
    baseSha: nextSha,
    cache = true,
    message: nextMessage = "Synced",
  }) => {
    const normalized = normalizeLoadedSnapshot(snapshot);
    const syncedAt = new Date().toISOString();

    setStoryState(normalized.state);
    workItemsRef.current = normalized.state.workItems;
    setBaselineSnapshot(normalized.snapshot);
    setBaseSha(nextSha);
    setSelectedId(null);
    setViewMode("sprint");
    setViewRootId(null);
    setModal(null);
    setLoadState("ready");
    setSyncState("synced");
    setSaveState("idle");
    setMessage(nextMessage);
    setLastSyncedAt(syncedAt);
    setLayoutNonce((value) => value + 1);
    if (cache) {
      saveCache({
        snapshot: normalized.snapshot,
        sha: nextSha,
        lastSyncedAt: syncedAt,
      });
    }
    return normalized.snapshot;
  }, []);

  const loadRemoteSnapshot = useCallback(async ({ block = false } = {}) => {
    if (block) {
      setLoadState("loading");
      setSyncState("loading");
      setMessage("Loading worklog...");
    } else {
      setSyncState("syncing");
    }

    try {
      const result = await loadWorklogSnapshot();
      const remoteSha = result.baseSha;

      if (!block && baseSha && remoteSha === baseSha) {
        const normalized = normalizeLoadedSnapshot(result.snapshot);
        const syncedAt = new Date().toISOString();
        setBaselineSnapshot(normalized.snapshot);
        setBaseSha(remoteSha);
        setLoadState("ready");
        setSyncState("synced");
        setLastSyncedAt(syncedAt);
        setMessage((current) =>
          current === "Offline (using cached data)" || current === "Syncing..."
            ? "Synced"
            : current || "Synced"
        );
        saveCache({
          snapshot: normalized.snapshot,
          sha: remoteSha,
          lastSyncedAt: syncedAt,
        });
        checkLegacyState(normalized.snapshot);
        return;
      }

      const remoteSnapshot = applyLoadedSnapshot({
        ...result,
        message: "Synced",
      });
      checkLegacyState(remoteSnapshot);
    } catch (error) {
      setSyncState("offline");
      setMessage("Offline (using cached data)");

      if (block) {
        setLoadState("error");
        setMessage(error.message || "Unable to load remote worklog.");
      } else {
        setLoadState("ready");
      }
    }
  }, [applyLoadedSnapshot, baseSha, checkLegacyState]);

  useEffect(() => {
    if (initialSyncStartedRef.current) return;

    initialSyncStartedRef.current = true;
    queueMicrotask(() => {
      loadRemoteSnapshot({
        block: !cachedSnapshot,
      });
    });
  }, [cachedSnapshot, loadRemoteSnapshot]);

  useEffect(() => {
    if (!dirty) return undefined;

    const handleBeforeUnload = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [dirty]);

  useEffect(() => {
    function handleKeyDown(event) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }

      if (event.key === "Escape") {
        setSearchOpen(false);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleSelectNode = useCallback((id) => {
    setSelectedId(id);

    if (id) {
      setModal({
        kind: "details",
        id,
      });
    } else {
      setModal(null);
    }
  }, []);

  const handleStartSprint = useCallback(() => {
    const currentSprints = storyStateRef.current?.sprints || [];
    const id = generateSprintId(currentSprints);
    const title = `Sprint ${currentSprints.length + 1}`;

    setStoryState((current) => ({
      ...current,
      sprints: [
        ...(current?.sprints || []),
        {
          id,
          title,
          docketState: "concept",
        },
      ],
    }));
    setMessage("Unsaved Changes");
    setLayoutNonce((value) => value + 1);
  }, []);

  const createItem = useCallback((payload) => {
    const currentWorkItems = workItemsRef.current;
    const id = generateWorkItemId(currentWorkItems, payload.type);
    const result = createWorkItem(currentWorkItems, {
      ...payload,
      id,
    });

    if (!result.ok) {
      setMessage(result.error);
      return result;
    }

    const normalized = normalizeArtifactRollup(
      result.items,
      rootDocketState
    );

    setStoryState((current) => ({
      ...current,
      rootDocketState: normalized.rootDocketState,
      workItems: normalized.workItems,
    }));
    workItemsRef.current = normalized.workItems;
    setSelectedId(result.item.id);
    setMessage("Unsaved Changes");
    setLayoutNonce((value) => value + 1);

    return result;
  }, [rootDocketState]);

  const handleStartChild = useCallback((type, parentId) => {
    const currentWorkItems = workItemsRef.current;
    const sprintParent = sprints.find((sprint) => sprint.id === parentId);
    const actualParentId =
      type === "epic" && sprintParent ? ROOT_ID : parentId;
    const fallbackSprint = sprintParent
      ? sprintParent.title
      : inheritedSprint(actualParentId, currentWorkItems, rootTitle);
    const fallbackDocketState = inheritedDocketState(
      actualParentId,
      currentWorkItems,
      sprintParent?.docketState || rootDocketState
    );
    const typeLabel = formatType(type);

    createItem({
      title: `New ${typeLabel}`,
      description: "",
      category: "feature",
      priority: "info",
      sprint: fallbackSprint,
      docketState: fallbackDocketState,
      type,
      parentId: actualParentId,
      storyPoints: type === "story" ? 0 : undefined,
      timeMinutes: acceptsTime(type) ? 0 : undefined,
      worklogs: acceptsTime(type)
        ? [
            {
              date: new Date().toISOString(),
              description: "",
              timeMinutes: 0,
            },
          ]
        : undefined,
    });
  }, [createItem, rootDocketState, rootTitle, sprints]);

  const openDetailsModal = useCallback((id) => {
    setModal({
      kind: "details",
      id,
    });
    setMessage("");
  }, []);

  const setFocusedView = useCallback((id) => {
    setViewMode("focused");
    setViewRootId(id);
    setSelectedId(id);
    setViewMenuOpen(false);
    setLayoutNonce((value) => value + 1);
  }, []);

  const showSprintView = useCallback(() => {
    setViewMode("sprint");
    setViewRootId(null);
    setSelectedId(null);
    setViewMenuOpen(false);
    setLayoutNonce((value) => value + 1);
  }, []);

  const showMainView = useCallback(() => {
    setViewMode("main");
    setViewRootId(null);
    setSelectedId(null);
    setViewMenuOpen(false);
    setLayoutNonce((value) => value + 1);
  }, []);

  const saveRootTitle = useCallback((updates) => {
    const trimmed = updates.title.trim();

    if (!trimmed) {
      setMessage("Root title is required.");
      return {
        ok: false,
        error: "Root title is required.",
      };
    }

    const requestedDocketState = updates.docketState || "concept";
    const blockedError =
      requestedDocketState === "artifact"
        ? artifactBlockedError(ROOT_ID, workItemsRef.current)
        : "";

    if (blockedError) {
      setMessage(blockedError);
      return {
        ok: false,
        error: blockedError,
      };
    }

    const normalized = normalizeArtifactRollup(
      workItemsRef.current,
      requestedDocketState
    );

    setStoryState((current) => ({
      ...current,
      rootTitle: trimmed,
      rootDocketState: normalized.rootDocketState,
      sprints: (current?.sprints || []).map((sprint) =>
        sprint.id === ROOT_ID
          ? {
              ...sprint,
              title: trimmed,
              docketState: normalized.rootDocketState,
            }
          : sprint
      ),
      workItems: normalized.workItems,
    }));
    workItemsRef.current = normalized.workItems;
    setMessage("Unsaved Changes");

    return {
      ok: true,
    };
  }, []);

  const saveMainTitle = useCallback((updates) => {
    const trimmed = updates.title.trim();

    if (!trimmed) {
      setMessage("Main title is required.");
      return {
        ok: false,
        error: "Main title is required.",
      };
    }

    setStoryState((current) => ({
      ...current,
      mainTitle: trimmed,
    }));
    setMessage("Unsaved Changes");

    return {
      ok: true,
    };
  }, []);

  const saveSprint = useCallback((id, updates) => {
    const trimmed = updates.title.trim();

    if (!trimmed) {
      setMessage("Sprint title is required.");
      return {
        ok: false,
        error: "Sprint title is required.",
      };
    }

    setStoryState((current) => ({
      ...current,
      sprints: (current?.sprints || []).map((sprint) =>
        sprint.id === id
          ? {
              ...sprint,
              title: trimmed,
              docketState: updates.docketState || "concept",
            }
          : sprint
      ),
    }));
    setMessage("Unsaved Changes");

    return {
      ok: true,
    };
  }, []);

  const saveWorkItem = useCallback((id, updates) => {
    const existingItems = workItemsRef.current;
    const requestedDocketState = updates.docketState || "concept";
    const blockedError =
      requestedDocketState === "artifact"
        ? artifactBlockedError(id, existingItems)
        : "";

    if (blockedError) {
      setMessage(blockedError);
      return {
        ok: false,
        error: blockedError,
      };
    }

    const result = updateWorkItem(
      existingItems,
      id,
      updates
    );

    if (!result.ok) {
      setMessage(result.error);
      return result;
    }

    const normalized = normalizeArtifactRollup(
      result.items,
      rootDocketState
    );

    setStoryState((current) => ({
      ...current,
      rootDocketState: normalized.rootDocketState,
      workItems: normalized.workItems,
    }));
    workItemsRef.current = normalized.workItems;
    setMessage("Unsaved Changes");

    return result;
  }, [rootDocketState]);

  const removeWorkItem = useCallback((item) => {
    const result = deleteWorkItem(workItemsRef.current, item.id);

    if (!result.ok) {
      setMessage(result.error);
      return result;
    }

    const normalized = normalizeArtifactRollup(
      result.items,
      rootDocketState
    );

    setStoryState((current) => ({
      ...current,
      rootDocketState: normalized.rootDocketState,
      workItems: normalized.workItems,
    }));
    workItemsRef.current = normalized.workItems;
    setSelectedId(null);
    if (result.deletedIds.includes(viewRootId)) {
      setViewRootId(null);
    }
    setMessage("Unsaved Changes");
    setLayoutNonce((value) => value + 1);

    return result;
  }, [rootDocketState, viewRootId]);

  const handleSaveChanges = useCallback(async () => {
    if (!canSave || !currentSnapshot) return;

    const sentSnapshot = currentSnapshot;
    const sentSnapshotString = stableSnapshotString(sentSnapshot);
    const requestId = saveRequestIdRef.current + 1;

    saveRequestIdRef.current = requestId;
    setSaveState("saving");
    setMessage("Saving...");

    try {
      const result = await saveWorklogSnapshot({
        snapshot: sentSnapshot,
        baseSha,
        commitMessage: `worklog: save snapshot ${new Date().toISOString()}`,
      });
      const normalized = normalizeLoadedSnapshot(result.snapshot);
      const syncedAt = new Date().toISOString();

      if (saveRequestIdRef.current !== requestId) return;

      setBaseSha(result.baseSha);
      setBaselineSnapshot(normalized.snapshot);
      saveCache({
        snapshot: normalized.snapshot,
        sha: result.baseSha,
        lastSyncedAt: syncedAt,
      });
      setLastSyncedAt(syncedAt);
      setSyncState("synced");
      setSaveState("idle");

      const latestSnapshot = snapshotFromState(storyStateRef.current);
      const stillDirty =
        stableSnapshotString(latestSnapshot) !== sentSnapshotString;

      setMessage(stillDirty ? "Unsaved Changes" : "Saved");
    } catch (error) {
      setSaveState(error.status === 409 ? "conflict" : "failed");
      setSyncState(error.status === 409 ? "synced" : "offline");
      setMessage(
        error.status === 409
          ? "Remote worklog changed since you loaded it."
          : error.message || "Save failed."
      );
    }
  }, [
    baseSha,
    canSave,
    currentSnapshot,
  ]);

  const handleDiscardChanges = useCallback(() => {
    if (!dirty || !baselineSnapshot) return;

    if (!window.confirm("Discard all unsaved working-copy changes?")) {
      return;
    }

    const normalized = normalizeLoadedSnapshot(baselineSnapshot);
    setStoryState(normalized.state);
    workItemsRef.current = normalized.state.workItems;
    setSelectedId(null);
    setViewMode("sprint");
    setViewRootId(null);
    setModal(null);
    setSaveState("idle");
    setMessage("Saved");
    setLayoutNonce((value) => value + 1);
  }, [baselineSnapshot, dirty]);

  const handleReloadRemote = useCallback(async () => {
    if (
      dirty &&
      !window.confirm("Reload remote worklog and discard local changes?")
    ) {
      return;
    }

    setSaveState("idle");
    await loadRemoteSnapshot({ block: false });
  }, [dirty, loadRemoteSnapshot]);

  const handleUseSampleLocally = useCallback(() => {
    const seedState = normalizeStoryStateArtifactRollup(
      normalizeSeedData(yamlText)
    );
    setStoryState(seedState);
    workItemsRef.current = seedState.workItems;
    setLoadState("ready");
    setSaveState("idle");
    setMessage("Unsaved local sample data");
    setSelectedId(null);
    setViewMode("sprint");
    setViewRootId(null);
    setModal(null);
    setLayoutNonce((value) => value + 1);
  }, []);

  const handleUseLegacyState = useCallback(() => {
    if (!legacyState) return;

    const normalized = normalizeStoryStateArtifactRollup(legacyState);
    setStoryState(normalized);
    workItemsRef.current = normalized.workItems;
    setShowLegacyNotice(false);
    setMessage("Unsaved Changes");
    setSelectedId(null);
    setViewMode("sprint");
    setViewRootId(null);
    setModal(null);
    setLayoutNonce((value) => value + 1);
  }, [legacyState]);

  const handleIgnoreLegacyState = useCallback(() => {
    setShowLegacyNotice(false);
  }, []);

  const statusLabel =
    saveState === "failed"
      ? "Save failed"
      : saveState === "saving"
      ? "Syncing..."
      : syncState === "offline"
      ? "Offline"
      : syncState === "syncing" || syncState === "loading"
      ? "Syncing..."
      : "Synced";

  if (loadState === "loading") {
    return (
      <div className="app-container app-state-screen">
        <section className="state-panel">
          <h1>Loading worklog</h1>
          <p>Loading the latest GitHub snapshot...</p>
        </section>
      </div>
    );
  }

  if (loadState === "error") {
    return (
      <div className="app-container app-state-screen">
        <section className="state-panel">
          <h1>Unable to load worklog</h1>
          <p>{message}</p>
          <div className="state-actions">
            <button
              type="button"
              onClick={() => loadRemoteSnapshot({ block: true })}
            >
              Retry
            </button>
            <button type="button" onClick={handleUseSampleLocally}>
              Use Sample Data Locally
            </button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="app-container">
      <header className="top-toolbar">
        <div className="toolbar-left">
          <div className="app-logo" aria-label="Jira Flow">
            JF
          </div>
          <div className="view-selector">
            <button
              type="button"
              className="view-selector-button"
              onClick={() => setViewMenuOpen((open) => !open)}
              aria-expanded={viewMenuOpen}
              aria-haspopup="listbox"
            >
              <span>
                {viewMode === "main"
                  ? "Main View"
                  : viewRootItem
                  ? `${viewRootItem.title} View`
                  : "Sprint View"}
              </span>
              <span className="view-selector-caret" aria-hidden="true">
                v
              </span>
            </button>
            {viewMenuOpen && (
              <div className="view-selector-menu" role="listbox">
                <button
                  type="button"
                  className={viewMode === "main" ? "selected" : ""}
                  onClick={showMainView}
                  role="option"
                  aria-selected={viewMode === "main"}
                >
                  Main View
                </button>
                <button
                  type="button"
                  className={viewMode === "sprint" ? "selected" : ""}
                  onClick={showSprintView}
                  role="option"
                  aria-selected={viewMode === "sprint"}
                >
                  Sprint View
                </button>
                {viewRootItem && (
                  <button
                    type="button"
                    className="selected"
                    onClick={() => setViewMenuOpen(false)}
                    role="option"
                    aria-selected="true"
                  >
                    {viewRootItem.title} View
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="toolbar-context" aria-label="Current view summary">
          <strong>{contextTitle}</strong>
          <span>{contextItemCount} Items</span>
          <span>{contextStoryPoints} SP</span>
          <span>{formatWorkTime(contextTimeMinutes)} Logged</span>
          <span>Last synced {formatRelativeSync(lastSyncedAt)}</span>
        </div>

        <div className="toolbar-actions">
          <button
            type="button"
            className="search-trigger"
            onClick={() => setSearchOpen(true)}
          >
            Search
            <span>Ctrl K</span>
          </button>
          <span className={`sync-status ${syncState}`}>
            {statusLabel}
          </span>

          {dirty && (
            <>
              <button
                type="button"
                className="primary-button"
                onClick={handleSaveChanges}
                disabled={!canSave}
              >
                {saveState === "saving" ? "Saving..." : "Save Changes"}
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={handleDiscardChanges}
                disabled={saveState === "saving"}
              >
                Discard Changes
              </button>
            </>
          )}
          {saveState === "conflict" && (
            <button type="button" onClick={handleReloadRemote}>
              Reload Remote
            </button>
          )}
          {viewRootId && (
            <button type="button" onClick={showSprintView}>
              Sprint View
            </button>
          )}
        </div>
      </header>

      {showLegacyNotice && (
        <div className="legacy-notice">
          <span>Local worklog data was found.</span>
          <button type="button" onClick={handleIgnoreLegacyState}>
            Ignore
          </button>
          <button type="button" onClick={handleUseLegacyState}>
            Replace Working Copy with Local Data
          </button>
        </div>
      )}

      {searchOpen && (
        <div className="search-overlay" onMouseDown={() => setSearchOpen(false)}>
          <section
            className="search-panel"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <label>
              <span>Search workspace</span>
              <input
                autoFocus
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search epics, stories, tasks, jobs, sprints..."
              />
            </label>
            <div className="search-results">
              <span>{searchedWorkItems.length} work items</span>
              <span>{searchedSprints.length} sprints</span>
            </div>
          </section>
        </div>
      )}

      {searchedWorkItems.length === 0 && viewMode !== "main" && (
        <div className="empty-canvas-state">
          <h2>Create your first work item</h2>
          <p>Use the plus button on the Sprint View box to begin.</p>
        </div>
      )}

      <GraphView
        workItems={searchedWorkItems}
        mainTitle={mainTitle}
        rootTitle={rootTitle}
        rootDocketState={rootDocketState}
        sprints={searchedSprints}
        storyPointTotals={displayedTotals}
        viewRootId={viewRootId}
        viewMode={viewMode}
        selectedId={selectedId}
        onSelect={handleSelectNode}
        onOpenDetails={openDetailsModal}
        onStartChild={handleStartChild}
        onStartSprint={handleStartSprint}
        layoutNonce={layoutNonce}
      />

      {modal && (
        <WorkItemModal
          modal={modal}
          mainTitle={mainTitle}
          rootTitle={rootTitle}
          rootDocketState={rootDocketState}
          sprints={sprints}
          workItems={workItems}
          totals={totals}
          onClose={() => setModal(null)}
          onSaveMain={saveMainTitle}
          onSaveRoot={saveRootTitle}
          onSaveSprint={saveSprint}
          onSaveItem={saveWorkItem}
          onCreateItem={createItem}
          onDeleteItem={removeWorkItem}
          onSetView={setFocusedView}
        />
      )}
    </div>
  );
}

export default App;
