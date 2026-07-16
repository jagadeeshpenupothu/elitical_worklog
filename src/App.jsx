import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import GraphView from "./views/GraphView";
import PlanningView from "./views/PlanningView";
import {
  loadEliticalData,
  loadEliticalEpicPresets,
} from "./services/elitical/loadEliticalData";
import { buildTimeGraph } from "./utils/planningGraph";
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
  normalizeWorklogSnapshot,
  stableSnapshotString,
  updateWorkItem,
} from "./utils/worklogModel";
import { loadLegacyStoryViewState } from "./utils/storage";
import {
  saveCache,
} from "./utils/cache";
import {
  loadWorklogSnapshot,
  saveWorklogSnapshot,
} from "./services/worklogApi";
import "./App.css";

const MAIN_ROOT_ID = "mainRoot";
const CREATE_NEW_EPIC_ID = "__create_new_epic__";
const ELITICAL_INITIAL_STATE = loadEliticalData();
const ELITICAL_EPIC_PRESETS = loadEliticalEpicPresets();
const PLANNING_VIEWS = [
  { id: "backlog", label: "Backlog View" },
  { id: "timeline", label: "Timeline View" },
  { id: "calendar", label: "Calendar View" },
  { id: "month", label: "Month View" },
  { id: "week", label: "Week View" },
  { id: "day", label: "Day View" },
  { id: "range", label: "Custom Date Range" },
  { id: "worklog", label: "Work Log View" },
];
const PLANNING_VIEW_IDS = new Set(PLANNING_VIEWS.map((view) => view.id));
const GRAPH_TIME_VIEW_IDS = new Set(["day", "week", "month", "range", "timeline"]);
const EPIC_PRESET_OPTIONS = [
  CREATE_NEW_EPIC_ID,
  ...ELITICAL_EPIC_PRESETS.map((epic) => epic.id),
];

function epicPresetLabel(id) {
  if (id === CREATE_NEW_EPIC_ID) return "Create New Epic";

  const epic = ELITICAL_EPIC_PRESETS.find((entry) => entry.id === id);
  return epic ? `${epic.id} · ${epic.title}` : id;
}

function epicPresetDraft(id, fallbackSprint, fallbackDocketState) {
  const epic = ELITICAL_EPIC_PRESETS.find((entry) => entry.id === id);

  if (!epic) {
    return {
      id: undefined,
      title: "",
      description: "",
      category: "feature",
      sprint: fallbackSprint,
      docketState: fallbackDocketState,
      assignee: "",
      createdBy: "",
      createdAt: undefined,
      updatedBy: "",
      updatedAt: undefined,
    };
  }

  return {
    id: epic.id,
    title: epic.title,
    description: "",
    category: epic.category,
    sprint: epic.sprint || fallbackSprint,
    docketState: epic.docketState,
    assignee: epic.assignee,
    createdBy: epic.createdBy,
    createdAt: epic.createdAt,
    updatedBy: epic.updatedBy,
    updatedAt: epic.updatedAt || epic.createdAt,
  };
}

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
    epicPresetId: type === "epic" ? CREATE_NEW_EPIC_ID : undefined,
  };
}

function makeSprintDraft(sprint, rootTitle, rootDocketState) {
  return {
    code: sprint?.code || "",
    title: sprint?.title || rootTitle || "New Sprint",
    sprintStartDate: sprint?.sprintStartDate
      ? formatDateInput(sprint.sprintStartDate)
      : "",
    sprintEndDate: sprint?.sprintEndDate
      ? formatDateInput(sprint.sprintEndDate)
      : "",
    sprintState: sprint?.sprintState || "",
    state: sprint?.state || "",
    createdBy: sprint?.createdBy || "",
    createdAt: sprint?.createdAt ? formatDateTimeLocalInput(sprint.createdAt) : "",
    updatedBy: sprint?.updatedBy || "",
    updatedAt: sprint?.updatedAt ? formatDateTimeLocalInput(sprint.updatedAt) : "",
    docketState: sprint?.docketState || rootDocketState || "concept",
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

function formatDateTimeLocalInput(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "";

  return [
    formatDateInput(date),
    [
      String(date.getHours()).padStart(2, "0"),
      String(date.getMinutes()).padStart(2, "0"),
    ].join(":"),
  ].join("T");
}

function dateTimeInputToIso(value) {
  if (!value) return "";

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function optionalDateInputToIso(value) {
  if (!value) return "";

  return dateInputToIso(value, value);
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
    snapshot: snapshotFromState(result.state),
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

function ModalSection({ title, children, className = "" }) {
  return (
    <section className={`modal-section ${className}`}>
      <h3>{title}</h3>
      <div className="modal-section-grid">{children}</div>
    </section>
  );
}

function ReadOnlyField({ label, value, badge = false, wide = false }) {
  return (
    <div className={`modal-field readonly-disabled ${wide ? "wide" : ""}`}>
      <span>{label}</span>
      {badge ? (
        <MetadataBadge>{value}</MetadataBadge>
      ) : (
        <strong>{value || "-"}</strong>
      )}
    </div>
  );
}

function CustomSelectField({
  label,
  value,
  options,
  onChange,
  onOpen,
  wide = false,
  getOptionLabel = formatLabel,
}) {
  const [open, setOpen] = useState(false);
  const fieldRef = useRef(null);
  const selectedLabel = getOptionLabel(value);

  useEffect(() => {
    if (!open) return undefined;

    function handlePointerDown(event) {
      if (!fieldRef.current?.contains(event.target)) {
        setOpen(false);
      }
    }

    function handleKeyDown(event) {
      if (event.key === "Escape") setOpen(false);
    }

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  function toggleOpen() {
    onOpen?.();
    setOpen((current) => !current);
  }

  function selectOption(option) {
    onChange(option);
    setOpen(false);
  }

  return (
    <div
      ref={fieldRef}
      className={`modal-field custom-select-field custom-select-value-${value || "empty"} ${
        open ? "open" : ""
      } ${wide ? "wide" : ""}`}
    >
      <span>{label}</span>
      <button
        type="button"
        className="custom-select-trigger"
        onClick={toggleOpen}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span>{selectedLabel || "-"}</span>
        <span className="custom-select-caret" aria-hidden="true">⌄</span>
      </button>
      {open && (
        <div className="custom-select-menu" role="listbox">
          {options.map((option) => {
            const selected = option === value;

            return (
              <button
                key={option}
                type="button"
                className={`custom-select-option custom-select-value-${option} ${
                  selected ? "selected" : ""
                }`}
                onClick={() => selectOption(option)}
                role="option"
                aria-selected={selected}
              >
                <span className="custom-select-check" aria-hidden="true">
                  {selected ? "✓" : ""}
                </span>
                <span>{getOptionLabel(option)}</span>
              </button>
            );
          })}
        </div>
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
  onCommit,
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

  if (type === "select") {
    return (
      <CustomSelectField
        label={label}
        value={value}
        options={options}
        onOpen={() => onEdit(field)}
        onChange={onChange}
        wide={wide}
      />
    );
  }

  if (editing) {
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
            onBlur={onCommit}
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
          onBlur={onCommit}
        />
      </label>
    );
  }

  return (
    <div
      className={`modal-field inline-readable ${wide ? "wide" : ""}`}
      onClick={() => onEdit(field)}
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
    <CustomSelectField
      label={label}
      value={value}
      options={options}
      onChange={onChange}
    />
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
  const createSprintParent =
    modal.kind === "create"
      ? sprints.find((sprint) => sprint.id === modal.parentId)
      : null;
  const fallbackSprint = modal.kind === "create" && modal.sprint
    ? modal.sprint
    : createSprintParent
    ? createSprintParent.title
    : isSprint || isMainRoot
    ? rootTitle
    : inheritedSprint(sprintParentId, workItems, rootTitle);
  const fallbackDocketState = modal.kind === "create" && modal.docketState
    ? modal.docketState
    : createSprintParent
    ? createSprintParent.docketState || rootDocketState || "concept"
    : isSprint
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
      ? makeSprintDraft(activeSprint, rootTitle, rootDocketState)
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

  function handleEpicPresetChange(value) {
    const preset = epicPresetDraft(value, fallbackSprint, fallbackDocketState);

    setDraft((current) => ({
      ...current,
      ...preset,
      epicPresetId: value,
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
        code: draft.code,
        sprintStartDate: draft.sprintStartDate,
        sprintEndDate: draft.sprintEndDate,
        sprintState: draft.sprintState,
        state: draft.state,
        createdBy: draft.createdBy,
        createdAt: draft.createdAt,
        updatedBy: draft.updatedBy,
        updatedAt: draft.updatedAt,
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
      createdAt:
        modal.kind === "create" && itemType === "epic"
          ? draft.createdAt || modal.worklogDate
          : draft.createdAt,
      updatedAt:
        modal.kind === "create" && itemType === "epic"
          ? draft.updatedAt || draft.createdAt || modal.worklogDate
          : draft.updatedAt,
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
        ? makeSprintDraft(activeSprint, rootTitle, rootDocketState)
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
        className={`modal-card ${isEditing ? "modal-card-edit" : "modal-card-view"}`}
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
            <CustomSelectField
              label="Docket State"
              value={draft.docketState || currentDocketState}
              options={DOCKET_STATES}
              onChange={(value) => updateDraft("docketState", value)}
              wide
            />
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
                      onCommit={handleSave}
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
                      onCommit={handleSave}
                      wide
                    />
                    {activeSprint && (
                      <>
                        <ReadOnlyField label="Code" value={draft.code} />
                        <ReadOnlyField
                          label="Sprint Start Date"
                          value={formatDateLabel(draft.sprintStartDate)}
                        />
                        <ReadOnlyField
                          label="Sprint End Date"
                          value={formatDateLabel(draft.sprintEndDate)}
                        />
                        <ReadOnlyField
                          label="Sprint State"
                          value={draft.sprintState}
                          badge
                        />
                        <ReadOnlyField label="State" value={draft.state} badge />
                      </>
                    )}
                  </ModalSection>
                  {activeSprint && (
                    <section className="modal-section modal-section-untitled">
                      <div className="modal-section-grid">
                        <ReadOnlyField label="Created By" value={draft.createdBy} />
                        <ReadOnlyField
                          label="Created At"
                          value={formatTimestamp(activeSprint.createdAt)}
                        />
                        <ReadOnlyField label="Updated By" value={draft.updatedBy} />
                        <ReadOnlyField
                          label="Updated At"
                          value={formatTimestamp(activeSprint.updatedAt)}
                        />
                      </div>
                    </section>
                  )}
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
                      onCommit={handleSave}
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
                      onCommit={handleSave}
                    />
                  </ModalSection>
                  {hasWorklog && (
                    <ModalSection title="Worklog" className="worklog-section">
                      <InlineField
                        label="Date"
                        field="worklogDate"
                        value={draft.worklogDate}
                        type="date"
                        editingField={editingField}
                        onEdit={startInlineEdit}
                        onChange={(value) => updateDraft("worklogDate", value)}
                        onCommit={handleSave}
                      />
                      <InlineField
                        label="Time"
                        field="time"
                        value={draft.time}
                        editingField={editingField}
                        onEdit={startInlineEdit}
                        onChange={(value) => updateDraft("time", value)}
                        onCommit={handleSave}
                        badge
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
                        onCommit={handleSave}
                        wide
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
                    {activeItem.type === "story" && (
                      <InlineField
                        label="Story Points"
                        field="storyPoints"
                        value={draft.storyPoints}
                        type="number"
                        editingField={editingField}
                        onEdit={startInlineEdit}
                        onChange={(value) => updateDraft("storyPoints", value)}
                        onCommit={handleSave}
                        badge
                      />
                    )}
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
                    {activeItem.assignee && (
                      <ReadOnlyField label="Assignee" value={activeItem.assignee} />
                    )}
                  </ModalSection>
                  <section className="modal-section modal-section-untitled">
                    <div className="modal-section-grid">
                      {activeItem.createdBy && (
                        <ReadOnlyField label="Created By" value={activeItem.createdBy} />
                      )}
                      <ReadOnlyField
                        label="Created At"
                        value={formatTimestamp(activeItem.createdAt)}
                      />
                      {activeItem.updatedBy && (
                        <ReadOnlyField label="Updated By" value={activeItem.updatedBy} />
                      )}
                      <ReadOnlyField
                        label="Updated At"
                        value={formatTimestamp(activeItem.updatedAt)}
                      />
                    </div>
                  </section>
                </>
              )}
            </div>
          ) : (
            <div className="modal-sections">
              {modal.kind === "create" && itemType === "epic" && (
                <ModalSection title="Epic">
                  <CustomSelectField
                    label="Epic"
                    value={draft.epicPresetId || CREATE_NEW_EPIC_ID}
                    options={EPIC_PRESET_OPTIONS}
                    onChange={handleEpicPresetChange}
                    getOptionLabel={epicPresetLabel}
                    wide
                  />
                </ModalSection>
              )}

              <ModalSection title="Basic Information">
                <TextField
                  label="Title"
                  value={draft.title}
                  onChange={(value) => updateDraft("title", value)}
                />

                {activeSprint && (
                  <>
                    <TextField
                      label="Code"
                      value={draft.code}
                      onChange={(value) => updateDraft("code", value)}
                    />
                    <TextField
                      label="Sprint Start Date"
                      type="date"
                      value={draft.sprintStartDate}
                      onChange={(value) => updateDraft("sprintStartDate", value)}
                    />
                    <TextField
                      label="Sprint End Date"
                      type="date"
                      value={draft.sprintEndDate}
                      onChange={(value) => updateDraft("sprintEndDate", value)}
                    />
                    <TextField
                      label="Sprint State"
                      value={draft.sprintState}
                      onChange={(value) => updateDraft("sprintState", value)}
                    />
                    <TextField
                      label="State"
                      value={draft.state}
                      onChange={(value) => updateDraft("state", value)}
                    />
                    <TextField
                      label="Created By"
                      value={draft.createdBy}
                      onChange={(value) => updateDraft("createdBy", value)}
                    />
                    <TextField
                      label="Created Time"
                      type="datetime-local"
                      value={draft.createdAt}
                      onChange={(value) => updateDraft("createdAt", value)}
                    />
                    <TextField
                      label="Updated By"
                      value={draft.updatedBy}
                      onChange={(value) => updateDraft("updatedBy", value)}
                    />
                    <TextField
                      label="Updated Time"
                      type="datetime-local"
                      value={draft.updatedAt}
                      onChange={(value) => updateDraft("updatedAt", value)}
                    />
                  </>
                )}

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
                <section className="modal-section modal-section-untitled">
                  <div className="modal-section-grid">
                    <ReadOnlyField
                      label="Created At"
                      value={formatTimestamp(activeItem.createdAt)}
                    />
                    <ReadOnlyField
                      label="Updated At"
                      value={formatTimestamp(activeItem.updatedAt)}
                    />
                  </div>
                </section>
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
  const importedSnapshot = useMemo(() => {
    try {
      return snapshotFromState(ELITICAL_INITIAL_STATE);
    } catch {
      return null;
    }
  }, []);
  const [storyState, setStoryState] = useState(
    ELITICAL_INITIAL_STATE
  );
  const [selectedId, setSelectedId] = useState(null);
  const [modal, setModal] = useState(null);
  const [message, setMessage] = useState(
    "Imported Elitical data"
  );
  const [layoutNonce, setLayoutNonce] = useState(1);
  const [viewMode, setViewMode] = useState("sprint");
  const [viewRootId, setViewRootId] = useState(null);
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [planningAnchorDate, setPlanningAnchorDate] = useState(
    formatDateInput(new Date())
  );
  const [planningRangeStart, setPlanningRangeStart] = useState(
    formatDateInput(new Date(new Date().setDate(new Date().getDate() - 7)))
  );
  const [planningRangeEnd, setPlanningRangeEnd] = useState(
    formatDateInput(new Date(new Date().setDate(new Date().getDate() + 14)))
  );
  const [loadState, setLoadState] = useState(
    "ready"
  );
  const [syncState, setSyncState] = useState(
    "syncing"
  );
  const [saveState, setSaveState] = useState("idle");
  const [baseSha, setBaseSha] = useState("");
  const [baselineSnapshot, setBaselineSnapshot] = useState(
    importedSnapshot
  );
  const [lastSyncedAt, setLastSyncedAt] = useState("");
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
  const isGraphTimeView = GRAPH_TIME_VIEW_IDS.has(viewMode);
  const visibleWorkItems = useMemo(
    () => descendantsIncluding(workItems, isGraphTimeView ? null : viewRootId),
    [isGraphTimeView, viewRootId, workItems]
  );
  const searchedWorkItems = useMemo(
    () => filterWorkItemsForSearch(visibleWorkItems, searchQuery),
    [searchQuery, visibleWorkItems]
  );
  const searchedSprints = useMemo(() => {
    if (viewMode !== "main" || !searchQuery.trim()) return sprints;

    return sprints.filter((sprint) => sprintMatchesQuery(sprint, searchQuery));
  }, [searchQuery, sprints, viewMode]);
  const timeGraph = useMemo(
    () =>
      isGraphTimeView
        ? buildTimeGraph({
            viewMode,
            workItems: searchedWorkItems,
            sprints,
            rootTitle,
            anchorDate: planningAnchorDate,
            rangeStart: planningRangeStart,
            rangeEnd: planningRangeEnd,
          })
        : null,
    [
      isGraphTimeView,
      planningAnchorDate,
      planningRangeEnd,
      planningRangeStart,
      rootTitle,
      searchedWorkItems,
      sprints,
      viewMode,
    ]
  );
  const graphWorkItems = timeGraph?.workItems || searchedWorkItems;
  const graphSprints = timeGraph ? [] : searchedSprints;
  const graphRootId = timeGraph?.rootId || viewRootId;
  const graphTotals = useMemo(
    () => calculateStoryPoints(graphWorkItems),
    [graphWorkItems]
  );
  const viewRootItem = viewRootId
    ? workItems.find((item) => item.id === viewRootId)
    : null;
  const isPlanningView = PLANNING_VIEW_IDS.has(viewMode);
  const usesPlanningSurface = isPlanningView && !isGraphTimeView;
  const planningViewLabel =
    PLANNING_VIEWS.find((view) => view.id === viewMode)?.label || "";
  const contextTitle =
    isPlanningView
      ? planningViewLabel
      : viewMode === "main"
      ? "Main View"
      : viewRootItem
      ? `${viewRootItem.title} View`
      : "Sprint View";
  const contextItemCount =
    (timeGraph ? graphWorkItems.length : searchedWorkItems.length) +
    (!isPlanningView && viewMode === "main" ? searchedSprints.length : 0) +
    (!isPlanningView && viewMode !== "main" ? 1 : 0);
  const contextStoryPoints =
    graphRootId ? graphTotals.byId[graphRootId] || 0 : graphTotals.rootTotal;
  const contextTimeMinutes =
    graphRootId
      ? graphTotals.timeById[graphRootId] || 0
      : graphTotals.rootTimeMinutes || 0;

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
    const now = new Date().toISOString();

    setStoryState((current) => ({
      ...current,
      sprints: [
        ...(current?.sprints || []),
        {
          id,
          code: "",
          title: "New Sprint",
          docketState: "concept",
          sprintStartDate: "",
          sprintEndDate: "",
          sprintState: "",
          state: "",
          createdBy: "",
          createdAt: now,
          updatedBy: "",
          updatedAt: "",
        },
      ],
    }));
    setSelectedId(id);
    setModal({
      kind: "details",
      id,
    });
    setMessage("Unsaved Changes");
    setLayoutNonce((value) => value + 1);
  }, []);

  const createItem = useCallback((payload) => {
    const currentWorkItems = workItemsRef.current;
    const id = payload.id || generateWorkItemId(currentWorkItems, payload.type);
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

  const handleStartChild = useCallback((type, parentId, options = {}) => {
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

    if (type === "epic") {
      setModal({
        kind: "create",
        type,
        parentId: actualParentId,
        sprint: fallbackSprint,
        docketState: fallbackDocketState,
        worklogDate: options.worklogDate,
      });
      return;
    }

    const typeLabel = formatType(type);
    const worklogDate = options.worklogDate || new Date().toISOString();

    createItem({
      title: `New ${typeLabel}`,
      description: "",
      category: "feature",
      priority: "info",
      sprint: fallbackSprint,
      docketState: fallbackDocketState,
      type,
      parentId: actualParentId,
      createdAt: options.worklogDate || undefined,
      updatedAt: options.worklogDate || undefined,
      storyPoints: type === "story" ? 0 : undefined,
      timeMinutes: acceptsTime(type) ? 0 : undefined,
      worklogs: acceptsTime(type)
        ? [
            {
              date: worklogDate,
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

  const showPlanningView = useCallback((nextViewMode) => {
    setViewMode(nextViewMode);
    setViewRootId(null);
    setSelectedId(null);
    setViewMenuOpen(false);
    if (GRAPH_TIME_VIEW_IDS.has(nextViewMode)) {
      setLayoutNonce((value) => value + 1);
    }
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
              code: updates.code || "",
              sprintStartDate: optionalDateInputToIso(updates.sprintStartDate),
              sprintEndDate: optionalDateInputToIso(updates.sprintEndDate),
              sprintState: updates.sprintState || "",
              state: updates.state || "",
              createdBy: updates.createdBy || "",
              createdAt: dateTimeInputToIso(updates.createdAt) || sprint.createdAt || "",
              updatedBy: updates.updatedBy || "",
              updatedAt: dateTimeInputToIso(updates.updatedAt) || "",
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
      ELITICAL_INITIAL_STATE
    );
    setStoryState(seedState);
    workItemsRef.current = seedState.workItems;
    setLoadState("ready");
    setSaveState("idle");
    setMessage("Imported Elitical data");
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
              Use Imported Elitical Data
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
                {isPlanningView
                  ? planningViewLabel
                  : viewMode === "main"
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
                <div className="view-selector-group">Planning</div>
                {PLANNING_VIEWS.map((view) => (
                  <button
                    key={view.id}
                    type="button"
                    className={viewMode === view.id ? "selected" : ""}
                    onClick={() => showPlanningView(view.id)}
                    role="option"
                    aria-selected={viewMode === view.id}
                  >
                    {view.label}
                  </button>
                ))}
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

        {(isGraphTimeView || viewMode === "calendar") && (
          <div className="time-view-controls">
            {viewMode === "range" ? (
              <>
                <input
                  type="date"
                  value={planningRangeStart}
                  onChange={(event) => {
                    setPlanningRangeStart(event.target.value);
                    setLayoutNonce((value) => value + 1);
                  }}
                  aria-label="Range start"
                />
                <input
                  type="date"
                  value={planningRangeEnd}
                  onChange={(event) => {
                    setPlanningRangeEnd(event.target.value);
                    setLayoutNonce((value) => value + 1);
                  }}
                  aria-label="Range end"
                />
              </>
            ) : (
              <input
                type="date"
                value={planningAnchorDate}
                onChange={(event) => {
                  setPlanningAnchorDate(event.target.value);
                  setLayoutNonce((value) => value + 1);
                }}
                aria-label="Planning date"
              />
            )}
          </div>
        )}

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

      {graphWorkItems.length === 0 && !usesPlanningSurface && viewMode !== "main" && (
        <div className="empty-canvas-state">
          <h2>Create your first work item</h2>
          <p>Use the plus button on the Sprint View box to begin.</p>
        </div>
      )}

      {usesPlanningSurface ? (
        <PlanningView
          viewMode={viewMode}
          workItems={searchedWorkItems}
          sprints={searchedSprints}
          onOpenDetails={openDetailsModal}
          anchorDate={planningAnchorDate}
          onAnchorDateChange={setPlanningAnchorDate}
          onOpenDay={(date) => {
            setPlanningAnchorDate(date);
            showPlanningView("day");
          }}
        />
      ) : (
        <GraphView
          workItems={graphWorkItems}
          mainTitle={mainTitle}
          rootTitle={timeGraph?.title || rootTitle}
          rootDocketState={rootDocketState}
          sprints={graphSprints}
          storyPointTotals={graphTotals}
          viewRootId={graphRootId}
          viewMode={viewMode}
          selectedId={selectedId}
          onSelect={handleSelectNode}
          onOpenDetails={openDetailsModal}
          onStartChild={handleStartChild}
          onStartSprint={handleStartSprint}
          layoutNonce={layoutNonce}
        />
      )}

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
