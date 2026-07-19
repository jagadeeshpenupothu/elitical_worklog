import {
  ORPHAN_SPRINT_ID,
  isReferenceNode,
} from "./hierarchyProjection.js";
import { ROOT_ID } from "./worklogModel.js";

const DOCKET_TYPES = new Set(["epic", "story", "task", "job"]);
const CONFIRMED_UPDATE_FIELDS = new Set([
  "title",
  "description",
  "dktStateId",
  "dktStateName",
  "assigneeId",
  "sprintId",
  "sprintName",
  "hasNoSprint",
  "category",
  "priority",
  "epicId",
  "storyPointEst",
]);

function normalizeType(value) {
  return String(value || "").trim().toLowerCase();
}

export function canonicalDocketId(value) {
  const id = String(value || "").trim();

  if (
    !id ||
    id === ORPHAN_SPRINT_ID ||
    id.startsWith("reference-") ||
    id.startsWith("ghost-") ||
    id.startsWith("virtual-")
  ) {
    return "";
  }

  return id;
}

export function canonicalDocketIdForItem(item) {
  if (!item || item.isVirtual || item.isOrphanSprint) return "";

  const id = isReferenceNode(item)
    ? item.sourceItemId || item.sourceDocketId || item.sourceId
    : item.id;

  return canonicalDocketId(id);
}

export function validateDocketOperation({
  operation,
  docket,
  payload = {},
  changes = {},
  workItems = [],
  sprints = [],
} = {}) {
  const type = normalizeType(payload.type || docket?.type);
  const title = String(payload.title ?? changes.title ?? docket?.title ?? "").trim();
  const parentId = String(payload.parentId ?? docket?.parentId ?? ROOT_ID).trim();
  const parent = workItems.find((item) => item.id === parentId);
  const sprintId = String(payload.sprintId ?? docket?.elitical?.sprintId ?? docket?.sprintId ?? "").trim();

  if (!["create", "update"].includes(operation)) {
    return "Unsupported docket operation.";
  }

  if (!DOCKET_TYPES.has(type)) {
    return "Choose a valid docket type.";
  }

  if (!title) {
    return "Title is required.";
  }

  if (sprintId === ORPHAN_SPRINT_ID) {
    return "Orphan Sprint is render-only and cannot be persisted.";
  }

  if (operation === "update") {
    const unsupported = Object.keys(changes).filter(
      (field) => !CONFIRMED_UPDATE_FIELDS.has(field)
    );

    if (unsupported.length) {
      return `Unsupported Elitical update field: ${unsupported.join(", ")}.`;
    }

    if (Object.prototype.hasOwnProperty.call(changes, "sprintId")) {
      const changedSprintId = String(changes.sprintId || "").trim();

      if (!changedSprintId || changedSprintId === ORPHAN_SPRINT_ID || changedSprintId.startsWith("virtual-")) {
        return "Moving a docket to no sprint / Orphan Sprint is not yet supported for Elitical sync.";
      }
    }

    if (Object.prototype.hasOwnProperty.call(changes, "dktStateId")) {
      const stateId = String(changes.dktStateId || "").trim();

      if (!stateId || stateId.startsWith("local-") || stateId.startsWith("virtual-")) {
        return "Docket State updates require a real Elitical state ID.";
      }
    }

    if (Object.prototype.hasOwnProperty.call(changes, "assigneeId")) {
      const assigneeId = String(changes.assigneeId || "").trim();

      if (!assigneeId || assigneeId.startsWith("local-") || assigneeId.startsWith("virtual-")) {
        return "Assignee updates require a real Elitical user ID.";
      }
    }

    if (Object.prototype.hasOwnProperty.call(changes, "epicId")) {
      if (type !== "story") {
        return "Only Story to Epic parent updates are confirmed for Elitical sync.";
      }

      const epicId = String(changes.epicId || "").trim();

      if (!canonicalDocketId(epicId) || epicId.startsWith("local-docket-")) {
        return "Story parent updates require a real canonical Epic ID.";
      }
    }

    if (Object.prototype.hasOwnProperty.call(changes, "storyPointEst") && type !== "story") {
      return "Only Story dockets support direct story point updates.";
    }
  }

  if (type === "epic") return "";

  if (type === "story" || type === "task") {
    return parent?.type === "epic" ? "" : "Story and Task need an Epic parent.";
  }

  if (type === "job") {
    return parent?.type === "story" ? "" : "Job needs a Story parent.";
  }

  return "";
}

export const FUTURE_DOCKET_VALIDATION_RULES = [
  "closed sprint restrictions",
  "allowed state transitions",
  "assignee eligibility",
  "story point constraints",
  "hierarchy movement restrictions",
  "mandatory field parity with Elitical by docket type",
];
