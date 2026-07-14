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
  normalizeSeedData,
  normalizeWorklogSnapshot,
  stableSnapshotString,
  updateWorkItem,
} from "./utils/worklogModel";
import { loadLegacyStoryViewState } from "./utils/storage";
import {
  loadWorklogSnapshot,
  saveWorklogSnapshot,
} from "./services/worklogApi";
import "./App.css";

function formatType(type) {
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

function formatDateLabel(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "-";

  return new Intl.DateTimeFormat(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
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
  rootTitle,
  rootDocketState,
  workItems,
  totals,
  onClose,
  onSaveRoot,
  onSaveItem,
  onCreateItem,
  onDeleteItem,
  onSetView,
}) {
  const [mode, setMode] = useState(
    modal.kind === "create" ? "edit" : "view"
  );
  const [editingField, setEditingField] = useState(null);
  const activeItem =
    modal.kind === "details" && modal.id !== ROOT_ID
      ? workItems.find((item) => item.id === modal.id)
      : null;
  const isRoot =
    modal.kind === "details" && modal.id === ROOT_ID;
  const itemType = isRoot
    ? "story-root"
    : modal.kind === "create"
    ? modal.type
    : activeItem?.type;
  const sprintParentId =
    modal.kind === "create" ? modal.parentId : activeItem?.parentId;
  const fallbackSprint = isRoot
    ? rootTitle
    : inheritedSprint(sprintParentId, workItems, rootTitle);
  const fallbackDocketState = isRoot
    ? rootDocketState || "concept"
    : inheritedDocketState(sprintParentId, workItems, rootDocketState);
  const initialDraft =
    modal.kind === "create"
      ? makeCreateDraft(modal.type, fallbackSprint, fallbackDocketState)
      : isRoot
      ? { title: rootTitle, docketState: rootDocketState || "concept" }
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
    : activeItem?.docketState || draft?.docketState || "concept";
  const currentSprint = isRoot
    ? rootTitle
    : activeItem?.sprint || draft?.sprint || fallbackSprint;
  const hasWorklog = acceptsTime(itemType);
  const contextLabel =
    modal.kind === "create"
      ? `Create ${formatType(itemType)}`
      : isRoot
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

  if (!draft || (modal.kind === "details" && !isRoot && !activeItem)) {
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

    if (isRoot) {
      const result = onSaveRoot({
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
      isRoot
        ? { title: rootTitle, docketState: rootDocketState || "concept" }
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

  const calculatedSp = isRoot
    ? totals.rootTotal
    : activeItem?.type === "epic"
    ? totals.byId[activeItem.id] || 0
    : null;
  const calculatedTime = isRoot
    ? totals.rootTimeMinutes || 0
    : activeItem
    ? totals.timeById[activeItem.id] || 0
    : 0;
  const headerSummary = modal.kind === "create"
    ? `${formatType(itemType)} · ${parentLabel(parentId, workItems)}`
    : isRoot
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
                : isRoot
                ? rootTitle
                : activeItem.title}
            </h2>
            <p>{headerSummary}</p>
          </div>
          <div className="modal-header-actions">
            {modal.kind === "details" && !isRoot && (
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
          {modal.kind === "details" && (
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
              {isRoot ? (
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

                {!isRoot && (
                  <TextAreaField
                    label="Description"
                    value={draft.description}
                    onChange={(value) => updateDraft("description", value)}
                  />
                )}
              </ModalSection>

              {!isRoot && hasWorklog && (
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

              <ModalSection title="Workflow">
                {isRoot ? (
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

              {!isRoot && (
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
                      {isRoot && (
                        <ReadOnlyField
                          label="Calculated Story Points"
                          value={`${totals.rootTotal} SP`}
                          badge
                        />
                      )}
                      {!isRoot && activeItem.type === "epic" && (
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

              {modal.kind !== "create" && !isRoot && (
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
              {modal.kind === "details" && !isRoot && (
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
  const [storyState, setStoryState] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [modal, setModal] = useState(null);
  const [message, setMessage] = useState("");
  const [layoutNonce, setLayoutNonce] = useState(1);
  const [viewRootId, setViewRootId] = useState(null);
  const [loadState, setLoadState] = useState("loading");
  const [saveState, setSaveState] = useState("idle");
  const [baseSha, setBaseSha] = useState("");
  const [baselineSnapshot, setBaselineSnapshot] = useState(null);
  const [legacyState, setLegacyState] = useState(null);
  const [showLegacyNotice, setShowLegacyNotice] = useState(false);

  const {
    rootTitle = "",
    rootDocketState = "concept",
    workItems = [],
  } = storyState || {};
  const workItemsRef = useRef(workItems);
  const storyStateRef = useRef(storyState);
  const saveRequestIdRef = useRef(0);
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
    loadState === "ready" && dirty && !saveState.startsWith("saving") && baseSha;
  const totals = useMemo(
    () => calculateStoryPoints(workItems),
    [workItems]
  );
  const visibleWorkItems = useMemo(
    () => descendantsIncluding(workItems, viewRootId),
    [viewRootId, workItems]
  );
  const visibleTotals = useMemo(
    () => calculateStoryPoints(visibleWorkItems),
    [visibleWorkItems]
  );
  const viewRootItem = viewRootId
    ? workItems.find((item) => item.id === viewRootId)
    : null;
  const displayedToolbarSp = viewRootId
    ? visibleTotals.byId[viewRootId] || 0
    : totals.rootTotal;

  useEffect(() => {
    workItemsRef.current = workItems;
    storyStateRef.current = storyState;
  }, [storyState, workItems]);

  const applyLoadedSnapshot = useCallback(({ snapshot, baseSha: nextSha }) => {
    const normalized = normalizeLoadedSnapshot(snapshot);

    setStoryState(normalized.state);
    workItemsRef.current = normalized.state.workItems;
    setBaselineSnapshot(normalized.snapshot);
    setBaseSha(nextSha);
    setSelectedId(null);
    setViewRootId(null);
    setModal(null);
    setLoadState("ready");
    setSaveState("idle");
    setMessage("Saved");
    setLayoutNonce((value) => value + 1);
    return normalized.snapshot;
  }, []);

  const loadRemoteSnapshot = useCallback(async () => {
    setLoadState("loading");
    setMessage("Loading worklog...");

    try {
      const result = await loadWorklogSnapshot();
      const remoteSnapshot = applyLoadedSnapshot(result);
      const legacy = loadLegacyStoryViewState();

      if (legacy) {
        const legacySnapshot = snapshotFromState(legacy);
        const differs = !snapshotEquals(legacySnapshot, remoteSnapshot);

        if (differs) {
          setLegacyState(legacy);
          setShowLegacyNotice(true);
        }
      }
    } catch (error) {
      setLoadState("error");
      setMessage(error.message || "Unable to load remote worklog.");
    }
  }, [applyLoadedSnapshot]);

  useEffect(() => {
    queueMicrotask(loadRemoteSnapshot);
  }, [loadRemoteSnapshot]);

  useEffect(() => {
    if (!dirty) return undefined;

    const handleBeforeUnload = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [dirty]);

  const openCreateModal = useCallback((type, parentId) => {
    setModal({
      kind: "create",
      type,
      parentId,
    });
    setMessage("");
  }, []);

  const openDetailsModal = useCallback((id) => {
    setModal({
      kind: "details",
      id,
    });
    setMessage("");
  }, []);

  const setFocusedView = useCallback((id) => {
    setViewRootId(id);
    setSelectedId(id);
    setLayoutNonce((value) => value + 1);
  }, []);

  const showSprintView = useCallback(() => {
    setViewRootId(null);
    setSelectedId(null);
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
      workItems: normalized.workItems,
    }));
    workItemsRef.current = normalized.workItems;
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

  const handleReset = useCallback(() => {
    if (
      !window.confirm(
        "Reset the working copy to the YAML sample? This will not save to GitHub until you click Save Changes."
      )
    ) {
      return;
    }

    const seedState = normalizeStoryStateArtifactRollup(
      normalizeSeedData(yamlText)
    );
    setStoryState(seedState);
    workItemsRef.current = seedState.workItems;
    setSelectedId(null);
    setViewRootId(null);
    setModal(null);
    setMessage("Unsaved Changes");
    setLayoutNonce((value) => value + 1);
  }, []);

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

      if (saveRequestIdRef.current !== requestId) return;

      setBaseSha(result.baseSha);
      setBaselineSnapshot(normalized.snapshot);
      setSaveState("idle");

      const latestSnapshot = snapshotFromState(storyStateRef.current);
      const stillDirty =
        stableSnapshotString(latestSnapshot) !== sentSnapshotString;

      setMessage(stillDirty ? "Unsaved Changes" : "Saved");
    } catch (error) {
      setSaveState(error.status === 409 ? "conflict" : "failed");
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
    await loadRemoteSnapshot();
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
    setViewRootId(null);
    setModal(null);
    setLayoutNonce((value) => value + 1);
  }, [legacyState]);

  const handleIgnoreLegacyState = useCallback(() => {
    setShowLegacyNotice(false);
  }, []);

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
            <button type="button" onClick={loadRemoteSnapshot}>
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
        <div className="toolbar-title">
          <strong>Jira Flow</strong>
          <span>
            {viewRootItem ? `${viewRootItem.title} View` : "Sprint View"}
          </span>
          <span className="toolbar-sp">
            {displayedToolbarSp} SP
          </span>
        </div>

        {message && (
          <span className="toolbar-message">
            {saveState === "conflict"
              ? "Conflict"
              : saveState === "failed"
              ? "Save Failed"
              : saveState === "saving"
              ? "Saving..."
              : dirty
              ? "Unsaved Changes"
              : message}
          </span>
        )}

        <button
          type="button"
          onClick={handleSaveChanges}
          disabled={!canSave}
        >
          {saveState === "saving" ? "Saving..." : "Save Changes"}
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={handleDiscardChanges}
          disabled={!dirty || saveState === "saving"}
        >
          Discard Changes
        </button>
        {saveState === "conflict" && (
          <button type="button" onClick={handleReloadRemote}>
            Reload Remote
          </button>
        )}
        <button
          type="button"
          onClick={() =>
            openCreateModal("epic", ROOT_ID)
          }
        >
          + New Work Item
        </button>
        {viewRootId && (
          <button type="button" onClick={showSprintView}>
            Sprint View
          </button>
        )}
        <button
          type="button"
          onClick={() =>
            setLayoutNonce((value) => value + 1)
          }
        >
          Re-layout
        </button>
        <button type="button" onClick={handleReset}>
          Reset to Sample
        </button>
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

      <GraphView
        workItems={visibleWorkItems}
        rootTitle={rootTitle}
        rootDocketState={rootDocketState}
        storyPointTotals={viewRootId ? visibleTotals : totals}
        viewRootId={viewRootId}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onOpenDetails={openDetailsModal}
        onStartChild={openCreateModal}
        layoutNonce={layoutNonce}
      />

      {modal && (
        <WorkItemModal
          modal={modal}
          rootTitle={rootTitle}
          rootDocketState={rootDocketState}
          workItems={workItems}
          totals={totals}
          onClose={() => setModal(null)}
          onSaveRoot={saveRootTitle}
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
