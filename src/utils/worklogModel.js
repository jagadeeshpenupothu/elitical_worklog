import yaml from "js-yaml";

export const ROOT_ID = "storyRoot";

export const CATEGORIES = [
  "feature",
  "enhancement",
  "defect",
  "escalation",
];

export const WORK_ITEM_TYPES = [
  "epic",
  "story",
  "task",
  "job",
];

export const GENERIC_WORK_ITEM_TYPES = [
  "workspace",
  "sprint",
  "epic",
  "story",
  "task",
  "bug",
  "feature",
  "research",
  "job",
];

export const RELATIONSHIP_TYPES = [
  "parent",
  "child",
  "assigned_to_sprint",
  "depends_on",
  "blocks",
  "related_to",
  "duplicate_of",
];

export const PRIORITIES = [
  "info",
  "minor",
  "major",
  "critical",
  "blocker",
];

export const DOCKET_STATES = [
  "concept",
  "design",
  "review",
  "closed",
  "artifact",
];

const RELATIONSHIPS = {
  [ROOT_ID]: ["epic", "story", "task", "job"],
  epic: ["story", "task"],
  story: ["job"],
  task: [],
  job: [],
};

const DEFAULT_ROOT_TITLE = "Sprint View";
const DEFAULT_MAIN_TITLE = "Genesis";
export const SNAPSHOT_SCHEMA_VERSION = 2;
const LEGACY_SNAPSHOT_SCHEMA_VERSION = 1;
const WORKSPACE_ID = "workspace";
const DEFAULT_TIMESTAMP = "1970-01-01T00:00:00.000Z";

function nowIso() {
  return new Date().toISOString();
}

function normalizeEnum(value, allowed, fallback) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();

  return allowed.includes(normalized)
    ? normalized
    : fallback;
}

function normalizeStoryPoints(value) {
  const numberValue = Number(value);

  return Number.isFinite(numberValue) && numberValue >= 0
    ? numberValue
    : 0;
}

function normalizeTimeMinutes(value) {
  const numberValue = Number(value);

  return Number.isFinite(numberValue) && numberValue >= 0
    ? Math.round(numberValue)
    : 0;
}

function normalizeHours(value) {
  const numberValue = Number(value);

  return Number.isFinite(numberValue) && numberValue >= 0
    ? Number(numberValue.toFixed(2))
    : 0;
}

function normalizeOptionalDate(value) {
  if (!value) return "";

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function isWorklogType(type) {
  return type === "story" || type === "job";
}

function normalizeWorklogDate(value, fallback) {
  const date = new Date(value || fallback);

  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function normalizeWorklogs(input, fallbackDate, fallbackDescription, fallbackTime) {
  const source = Array.isArray(input) && input.length > 0
    ? input
    : [
        {
          date: fallbackDate,
          description: fallbackDescription,
          timeMinutes: fallbackTime,
        },
      ];

  return source.map((entry) => ({
    date: normalizeWorklogDate(entry?.date, fallbackDate),
    description: String(entry?.description || ""),
    timeMinutes: normalizeTimeMinutes(entry?.timeMinutes),
  }));
}

function worklogTotalMinutes(worklogs) {
  return worklogs.reduce(
    (total, entry) => total + normalizeTimeMinutes(entry.timeMinutes),
    0
  );
}

function normalizePosition(position) {
  if (
    !position ||
    !Number.isFinite(Number(position.x)) ||
    !Number.isFinite(Number(position.y))
  ) {
    return null;
  }

  return {
    x: Number(position.x),
    y: Number(position.y),
  };
}

function normalizeType(type) {
  const lower = String(type || "")
    .trim()
    .toLowerCase();

  if (lower === "epic") return "epic";
  if (lower === "story") return "story";
  if (lower === "job") return "job";
  if (lower === "task") return "task";

  return "task";
}

function normalizeDocketState(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();

  return DOCKET_STATES.includes(normalized) ? normalized : "concept";
}

function makeRelationshipId(sourceId, targetId, relationshipType) {
  return `${relationshipType}:${sourceId}:${targetId}`;
}

function makeSprintAssignmentId(sprintId, workItemId) {
  return `sprint-assignment:${sprintId}:${workItemId}`;
}

function normalizeGenericType(type) {
  const normalized = String(type || "").trim().toLowerCase();

  return GENERIC_WORK_ITEM_TYPES.includes(normalized) ? normalized : "task";
}

function normalizeRelationshipType(type) {
  const normalized = String(type || "").trim().toLowerCase();

  return RELATIONSHIP_TYPES.includes(normalized) ? normalized : "related_to";
}

function normalizeSprint(input, fallbackId = ROOT_ID) {
  const id = String(input?.id || fallbackId || "").trim();
  const title = String(input?.title || DEFAULT_ROOT_TITLE).trim();

  return {
    id: id || fallbackId,
    title: title || DEFAULT_ROOT_TITLE,
    docketState: normalizeDocketState(input?.docketState),
  };
}

function normalizeSprints(input, rootTitle, rootDocketState) {
  const source = Array.isArray(input) ? input : [];
  const seenIds = new Set([ROOT_ID]);
  const normalized = source
    .map((entry) => normalizeSprint(entry))
    .filter((entry) => {
      if (!entry.id || !entry.title || seenIds.has(entry.id)) return false;

      seenIds.add(entry.id);
      return true;
    });
  const byId = new Map(normalized.map((entry) => [entry.id, entry]));
  const rootSprint = {
    ...normalizeSprint(byId.get(ROOT_ID), ROOT_ID),
    id: ROOT_ID,
    title: rootTitle,
    docketState: normalizeDocketState(rootDocketState),
  };

  byId.set(ROOT_ID, rootSprint);

  return [
    rootSprint,
    ...normalized.filter((entry) => entry.id !== ROOT_ID),
  ];
}

function makeWorkItem(input, fallbackParentId = ROOT_ID) {
  const type = normalizeType(input.type);
  const createdAt = input.createdAt || nowIso();
  const item = {
    id: String(input.id || "").trim(),
    title: String(input.title || input.id || "Untitled").trim(),
    description: String(input.description || ""),
    category: normalizeEnum(input.category, CATEGORIES, "feature"),
    type,
    priority: normalizeEnum(input.priority, PRIORITIES, "info"),
    parentId: input.parentId || fallbackParentId,
    openQueue: Boolean(input.openQueue),
    assignee: String(input.assignee || ""),
    sprint: String(input.sprint || ""),
    docketState: normalizeDocketState(input.docketState),
    plannedStartDate: normalizeOptionalDate(input.plannedStartDate),
    plannedEndDate: normalizeOptionalDate(input.plannedEndDate),
    actualStartDate: normalizeOptionalDate(input.actualStartDate),
    actualEndDate: normalizeOptionalDate(input.actualEndDate),
    dueDate: normalizeOptionalDate(input.dueDate || input.worklogDate),
    estimatedHours: normalizeHours(
      input.estimatedHours ?? input.estimatedTime
    ),
    loggedHours: normalizeHours(
      input.loggedHours ??
      (input.loggedTime !== undefined
        ? input.loggedTime
        : input.timeMinutes !== undefined
        ? normalizeTimeMinutes(input.timeMinutes) / 60
        : 0)
    ),
    remainingHours: normalizeHours(input.remainingHours),
    labels: Array.isArray(input.labels)
      ? input.labels.map((label) => String(label).trim()).filter(Boolean)
      : [],
    createdAt,
    updatedAt: input.updatedAt || createdAt,
    position: normalizePosition(input.position),
  };

  if (type === "story") {
    item.storyPoints = normalizeStoryPoints(input.storyPoints);
  }

  if (isWorklogType(type)) {
    item.worklogs = normalizeWorklogs(
      input.worklogs,
      input.worklogDate || item.updatedAt || item.createdAt,
      item.description,
      input.timeMinutes
    );
    item.timeMinutes = worklogTotalMinutes(item.worklogs);
  }

  return item;
}

function hasDuplicateIds(items) {
  return new Set(items.map((item) => item.id)).size !== items.length;
}

function getItem(items, id) {
  return items.find((item) => item.id === id);
}

function parentTypeFor(items, parentId) {
  if (parentId === ROOT_ID) return ROOT_ID;

  return getItem(items, parentId)?.type || null;
}

function createsCycle(items, itemId, parentId) {
  let currentParentId = parentId;

  while (currentParentId && currentParentId !== ROOT_ID) {
    if (currentParentId === itemId) return true;
    currentParentId = getItem(items, currentParentId)?.parentId;
  }

  return false;
}

export function isValidParent(items, childType, parentId, childId = null) {
  if (!WORK_ITEM_TYPES.includes(childType)) return false;
  if (!parentId) return false;
  if (childId && childId === parentId) return false;
  if (childId && createsCycle(items, childId, parentId)) return false;

  const parentType = parentTypeFor(items, parentId);

  if (!parentType) return false;

  return RELATIONSHIPS[parentType].includes(childType);
}

function descendantsOf(items, itemId) {
  const descendants = [];
  const visit = (parentId) => {
    items
      .filter((item) => item.parentId === parentId)
      .forEach((child) => {
        descendants.push(child.id);
        visit(child.id);
      });
  };

  visit(itemId);
  return descendants;
}

function childrenRemainValid(items, itemId, nextType) {
  return items
    .filter((item) => item.parentId === itemId)
    .every((child) => RELATIONSHIPS[nextType].includes(child.type));
}

export function validateWorkItems(items) {
  if (!Array.isArray(items)) {
    return {
      valid: false,
      error: "Work items must be an array.",
    };
  }

  if (items.some((item) => !item.id || item.id === ROOT_ID)) {
    return {
      valid: false,
      error: "Work items need stable non-root IDs.",
    };
  }

  if (hasDuplicateIds(items)) {
    return {
      valid: false,
      error: "Duplicate work item IDs are not allowed.",
    };
  }

  for (const item of items) {
    if (!isValidParent(items, item.type, item.parentId, item.id)) {
      return {
        valid: false,
        error: `${item.id} has an invalid parent relationship.`,
      };
    }
  }

  return {
    valid: true,
    error: "",
  };
}

export function normalizeSeedData(yamlText) {
  const data = yaml.load(yamlText) || {};
  const items = [];

  function traverse(id, rawItem, parentId = ROOT_ID) {
    const type = normalizeType(rawItem?.type);
    const item = makeWorkItem(
      {
        id,
        title: rawItem?.title || id,
        description: rawItem?.description || "",
        type,
        category: rawItem?.category || "feature",
        priority: rawItem?.priority || "info",
        parentId,
        openQueue: rawItem?.openQueue || false,
        assignee: rawItem?.assignee || "",
        sprint: rawItem?.sprint || "",
        docketState: rawItem?.docketState || "concept",
        storyPoints: type === "story" ? rawItem?.storyPoints : undefined,
        timeMinutes:
          isWorklogType(type)
            ? rawItem?.timeMinutes
            : undefined,
        worklogs: rawItem?.worklogs,
      },
      parentId
    );

    items.push(item);

    Object.entries(rawItem?.children || {}).forEach(
      ([childId, childItem]) => {
        traverse(childId, childItem, id);
      }
    );
  }

  Object.entries(data).forEach(([id, rawItem]) => {
    traverse(id, rawItem, ROOT_ID);
  });

  const validItems = items.filter((item) =>
    isValidParent(items, item.type, item.parentId, item.id)
  );

  return {
    rootTitle: DEFAULT_ROOT_TITLE,
    mainTitle: DEFAULT_MAIN_TITLE,
    rootDocketState: "concept",
    rootPosition: null,
    sprints: normalizeSprints([], DEFAULT_ROOT_TITLE, "concept"),
    workItems: validItems,
  };
}

export function normalizeSavedState(input) {
  const savedRootTitle =
    typeof input?.rootTitle === "string" && input.rootTitle.trim()
      ? input.rootTitle.trim()
      : DEFAULT_ROOT_TITLE;
  const rootTitle =
    savedRootTitle === "Story View" ? DEFAULT_ROOT_TITLE : savedRootTitle;
  const mainTitle =
    typeof input?.mainTitle === "string" && input.mainTitle.trim()
      ? input.mainTitle.trim()
      : DEFAULT_MAIN_TITLE;

  const sourceItems = Array.isArray(input?.workItems)
    ? input.workItems
    : [];

  const workItems = sourceItems.map((item) =>
    makeWorkItem(item, item.parentId)
  );

  const validation = validateWorkItems(workItems);

  if (!validation.valid) {
    return {
      valid: false,
      error: validation.error,
    };
  }

  return {
    valid: true,
    state: {
      rootTitle,
      mainTitle,
      rootDocketState: normalizeDocketState(input?.rootDocketState),
      rootPosition: normalizePosition(input?.rootPosition),
      sprints: normalizeSprints(
        input?.sprints,
        rootTitle,
        input?.rootDocketState
      ),
      workItems,
    },
  };
}

function canonicalWorkItem(item) {
  const normalized = makeWorkItem(item, item.parentId);
  const canonical = {
    id: normalized.id,
    title: normalized.title,
    description: normalized.description,
    category: normalized.category,
    type: normalized.type,
    priority: normalized.priority,
    parentId: normalized.parentId,
    openQueue: normalized.openQueue,
    assignee: normalized.assignee,
    sprint: normalized.sprint,
    docketState: normalized.docketState,
    plannedStartDate: normalized.plannedStartDate,
    plannedEndDate: normalized.plannedEndDate,
    actualStartDate: normalized.actualStartDate,
    actualEndDate: normalized.actualEndDate,
    dueDate: normalized.dueDate,
    estimatedHours: normalized.estimatedHours,
    loggedHours: normalized.loggedHours,
    remainingHours: normalized.remainingHours,
    labels: normalized.labels,
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
  };

  if (normalized.type === "story") {
    canonical.storyPoints = normalized.storyPoints;
  }

  if (isWorklogType(normalized.type)) {
    canonical.timeMinutes = normalized.timeMinutes;
    canonical.worklogs = normalized.worklogs;
  }

  return canonical;
}

function canonicalGraphWorkItem(item) {
  const base = {
    id: String(item.id || "").trim(),
    title: String(item.title || item.id || "Untitled").trim(),
    description: String(item.description || ""),
    type: normalizeGenericType(item.type),
    status: normalizeDocketState(item.status || item.docketState),
    priority: normalizeEnum(item.priority, PRIORITIES, "info"),
    storyPoints: normalizeStoryPoints(item.storyPoints),
    estimatedTime: normalizeTimeMinutes(item.estimatedTime ?? item.timeMinutes),
    loggedTime: normalizeTimeMinutes(item.loggedTime ?? item.timeMinutes),
    plannedStartDate: normalizeOptionalDate(item.plannedStartDate),
    plannedEndDate: normalizeOptionalDate(item.plannedEndDate),
    actualStartDate: normalizeOptionalDate(item.actualStartDate),
    actualEndDate: normalizeOptionalDate(item.actualEndDate),
    dueDate: normalizeOptionalDate(item.dueDate || item.worklogDate),
    estimatedHours: normalizeHours(
      item.estimatedHours ??
      (item.estimatedTime !== undefined
        ? normalizeTimeMinutes(item.estimatedTime) / 60
        : 0)
    ),
    loggedHours: normalizeHours(
      item.loggedHours ??
      (item.loggedTime !== undefined
        ? normalizeTimeMinutes(item.loggedTime) / 60
        : item.timeMinutes !== undefined
        ? normalizeTimeMinutes(item.timeMinutes) / 60
        : 0)
    ),
    remainingHours: normalizeHours(item.remainingHours),
    labels: Array.isArray(item.labels)
      ? item.labels.map((label) => String(label).trim()).filter(Boolean)
      : [],
    parentId: item.parentId || "",
    category: normalizeEnum(item.category, CATEGORIES, "feature"),
    openQueue: Boolean(item.openQueue),
    assignee: String(item.assignee || ""),
    sprint: String(item.sprint || ""),
    createdAt: item.createdAt || nowIso(),
    updatedAt: item.updatedAt || item.createdAt || nowIso(),
  };

  if (Array.isArray(item.worklogs)) {
    base.worklogs = normalizeWorklogs(
      item.worklogs,
      base.updatedAt,
      base.description,
      base.loggedTime
    );
    base.loggedTime = worklogTotalMinutes(base.worklogs);
  }

  return base;
}

function canonicalRelationship(input) {
  const sourceId = String(input?.sourceId || "").trim();
  const targetId = String(input?.targetId || "").trim();
  const relationshipType = normalizeRelationshipType(input?.relationshipType);

  return {
    id: String(input?.id || makeRelationshipId(sourceId, targetId, relationshipType)),
    sourceId,
    targetId,
    relationshipType,
  };
}

function canonicalSprintAssignment(input) {
  const sprintId = String(input?.sprintId || "").trim();
  const workItemId = String(input?.workItemId || "").trim();

  return {
    id: String(input?.id || makeSprintAssignmentId(sprintId, workItemId)),
    sprintId,
    workItemId,
    plannedHours: normalizeTimeMinutes(input?.plannedHours),
    loggedHours: normalizeTimeMinutes(input?.loggedHours),
    status: normalizeDocketState(input?.status),
    assignedDate: isValidDate(input?.assignedDate)
      ? new Date(input.assignedDate).toISOString()
      : nowIso(),
  };
}

function isValidDate(value) {
  return !Number.isNaN(new Date(value).getTime());
}

function uniqueById(items) {
  const seen = new Set();

  return items.filter((item) => {
    if (!item.id || seen.has(item.id)) return false;

    seen.add(item.id);
    return true;
  });
}

function graphItemKind(item) {
  return normalizeGenericType(item?.type);
}

function legacyVisibleGraphItemIds(snapshot) {
  return new Set(
    (snapshot.workItems || [])
      .filter((item) => {
        const type = graphItemKind(item);
        return type === "workspace" ||
          type === "sprint" ||
          WORK_ITEM_TYPES.includes(type);
      })
      .map((item) => item.id)
  );
}

function mergeGraphSnapshot(previousSnapshot, nextSnapshot) {
  if (!previousSnapshot || previousSnapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    return nextSnapshot;
  }

  const nextItems = (nextSnapshot.workItems || []).map(canonicalGraphWorkItem);
  const nextItemIds = new Set(nextItems.map((item) => item.id));
  const previousVisibleIds = legacyVisibleGraphItemIds(previousSnapshot);
  const preservedItems = (previousSnapshot.workItems || [])
    .map(canonicalGraphWorkItem)
    .filter((item) => !nextItemIds.has(item.id) && !previousVisibleIds.has(item.id));
  const mergedItems = uniqueById([...nextItems, ...preservedItems]);
  const validIds = new Set(mergedItems.map((item) => item.id));
  const nextRelationships = (nextSnapshot.relationships || []).map(canonicalRelationship);
  const generatedParentTargets = new Set(
    nextRelationships
      .filter((relationship) => relationship.relationshipType === "parent")
      .map((relationship) => relationship.targetId)
  );
  const previousRelationships = (previousSnapshot.relationships || [])
    .map(canonicalRelationship)
    .filter((relationship) => {
      if (!validIds.has(relationship.sourceId) || !validIds.has(relationship.targetId)) {
        return false;
      }

      return !(
        relationship.relationshipType === "parent" &&
        generatedParentTargets.has(relationship.targetId)
      );
    });
  const nextAssignments = (nextSnapshot.sprintAssignments || [])
    .map(canonicalSprintAssignment)
    .filter((assignment) =>
      validIds.has(assignment.sprintId) && validIds.has(assignment.workItemId)
    );
  const previousAssignments = (previousSnapshot.sprintAssignments || [])
    .map(canonicalSprintAssignment)
    .filter((assignment) =>
      validIds.has(assignment.sprintId) && validIds.has(assignment.workItemId)
    );

  return {
    ...nextSnapshot,
    views: Array.isArray(previousSnapshot.views) && previousSnapshot.views.length > 0
      ? uniqueById([...nextSnapshot.views, ...previousSnapshot.views])
      : nextSnapshot.views,
    workItems: mergedItems,
    relationships: uniqueById([...nextRelationships, ...previousRelationships]),
    sprintAssignments: uniqueById([...nextAssignments, ...previousAssignments]),
    settings: {
      ...(previousSnapshot.settings || {}),
      ...(nextSnapshot.settings || {}),
    },
  };
}

function legacyStateToGraphSnapshot(state) {
  const sprints = normalizeSprints(
    state.sprints,
    state.rootTitle,
    state.rootDocketState
  );
  const sprintByTitle = new Map(sprints.map((sprint) => [sprint.title, sprint]));
  const relationships = [];
  const sprintAssignments = [];
  const latestUpdatedAt = state.workItems.reduce((latest, item) => {
    const itemTime = new Date(item.updatedAt || item.createdAt || 0).getTime();
    const latestTime = new Date(latest || 0).getTime();

    return itemTime > latestTime ? item.updatedAt || item.createdAt : latest;
  }, DEFAULT_TIMESTAMP);
  const graphItems = [
    canonicalGraphWorkItem({
      id: WORKSPACE_ID,
      title: state.mainTitle || DEFAULT_MAIN_TITLE,
      type: "workspace",
      status: "concept",
      createdAt: DEFAULT_TIMESTAMP,
      updatedAt: latestUpdatedAt,
    }),
    ...sprints.map((sprint) =>
      canonicalGraphWorkItem({
        id: sprint.id,
        title: sprint.title,
        type: "sprint",
        status: sprint.docketState,
        parentId: WORKSPACE_ID,
        createdAt: DEFAULT_TIMESTAMP,
        updatedAt: latestUpdatedAt,
      })
    ),
    ...state.workItems.map((item) => {
      const canonical = canonicalWorkItem(item);

      return canonicalGraphWorkItem({
        ...canonical,
        status: canonical.docketState,
        loggedTime: canonical.timeMinutes,
      });
    }),
  ];

  sprints.forEach((sprint) => {
    relationships.push(canonicalRelationship({
      sourceId: WORKSPACE_ID,
      targetId: sprint.id,
      relationshipType: "parent",
    }));
  });

  state.workItems.forEach((item) => {
    if (item.parentId && item.parentId !== ROOT_ID) {
      relationships.push(canonicalRelationship({
        sourceId: item.parentId,
        targetId: item.id,
        relationshipType: "parent",
      }));
    }

    const sprint = sprintByTitle.get(item.sprint) || sprints[0];

    if (sprint) {
      const assignment = canonicalSprintAssignment({
        sprintId: sprint.id,
        workItemId: item.id,
        plannedHours: item.timeMinutes || 0,
        loggedHours: item.timeMinutes || 0,
        status: item.docketState,
        assignedDate: item.createdAt || nowIso(),
      });

      sprintAssignments.push(assignment);
      relationships.push(canonicalRelationship({
        sourceId: sprint.id,
        targetId: item.id,
        relationshipType: "assigned_to_sprint",
      }));
    }
  });

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    workspace: {
      id: WORKSPACE_ID,
      title: state.mainTitle || DEFAULT_MAIN_TITLE,
      rootSprintId: ROOT_ID,
    },
    views: [
      { id: "main", title: "Main View", type: "main" },
      { id: "sprint", title: state.rootTitle, type: "sprint", sprintId: ROOT_ID },
      { id: "epic", title: "Epic View", type: "epic" },
      { id: "story", title: "Story View", type: "story" },
      { id: "timeline", title: "Timeline View", type: "timeline" },
      { id: "calendar", title: "Calendar View", type: "calendar" },
      { id: "month", title: "Month View", type: "month" },
      { id: "week", title: "Week View", type: "week" },
      { id: "day", title: "Day View", type: "day" },
      { id: "range", title: "Custom Date Range", type: "range" },
      { id: "worklog", title: "Work Log View", type: "worklog" },
      { id: "dependencies", title: "Dependencies View", type: "dependencies" },
      { id: "backlog", title: "Backlog View", type: "backlog" },
      { id: "completed", title: "Completed View", type: "completed" },
    ],
    workItems: uniqueById(graphItems),
    relationships: uniqueById(relationships),
    sprintAssignments: uniqueById(sprintAssignments),
    settings: {
      defaultViewId: "main",
      legacyRootId: ROOT_ID,
    },
  };
}

function graphSnapshotToLegacyState(snapshot) {
  const graphItems = Array.isArray(snapshot.workItems) ? snapshot.workItems : [];
  const relationships = Array.isArray(snapshot.relationships)
    ? snapshot.relationships.map(canonicalRelationship)
    : [];
  const sprintAssignments = Array.isArray(snapshot.sprintAssignments)
    ? snapshot.sprintAssignments.map(canonicalSprintAssignment)
    : [];
  const parentByTarget = new Map(
    relationships
      .filter((relationship) => relationship.relationshipType === "parent")
      .map((relationship) => [relationship.targetId, relationship.sourceId])
  );
  const sprints = graphItems
    .filter((item) => normalizeGenericType(item.type) === "sprint")
    .map((item) => ({
      id: item.id,
      title: item.title,
      docketState: normalizeDocketState(item.status || item.docketState),
    }));
  const rootSprint =
    sprints.find((sprint) => sprint.id === snapshot.workspace?.rootSprintId) ||
    sprints.find((sprint) => sprint.id === ROOT_ID) ||
    normalizeSprint(null, ROOT_ID);
  const sprintById = new Map(sprints.map((sprint) => [sprint.id, sprint]));
  const firstAssignmentByItem = new Map();

  sprintAssignments.forEach((assignment) => {
    if (!firstAssignmentByItem.has(assignment.workItemId)) {
      firstAssignmentByItem.set(assignment.workItemId, assignment);
    }
  });

  const workItems = graphItems
    .filter((item) => WORK_ITEM_TYPES.includes(normalizeGenericType(item.type)))
    .map((item) => {
      const assignment = firstAssignmentByItem.get(item.id);
      const sprint = sprintById.get(assignment?.sprintId) || rootSprint;
      const parentId = parentByTarget.get(item.id) || ROOT_ID;

      return makeWorkItem({
        ...item,
        type: normalizeType(item.type),
        docketState: item.status || item.docketState,
        parentId: parentId === WORKSPACE_ID ? ROOT_ID : parentId,
        sprint: sprint.title,
        timeMinutes: item.loggedTime,
      }, ROOT_ID);
    });

  return normalizeSavedState({
    mainTitle: snapshot.workspace?.title || DEFAULT_MAIN_TITLE,
    rootTitle: rootSprint.title,
    rootDocketState: rootSprint.docketState,
    sprints,
    workItems,
  });
}

export function buildWorklogSnapshot(state, previousSnapshot = null) {
  const normalized = normalizeSavedState(state);

  if (!normalized.valid) {
    return {
      valid: false,
      error: normalized.error,
      snapshot: null,
    };
  }

  return {
    valid: true,
    error: "",
    snapshot: mergeGraphSnapshot(
      previousSnapshot,
      legacyStateToGraphSnapshot(normalized.state)
    ),
  };
}

export function normalizeWorklogSnapshot(snapshot) {
  if (snapshot?.schemaVersion === LEGACY_SNAPSHOT_SCHEMA_VERSION) {
    const root = snapshot.root || {};
    const normalized = normalizeSavedState({
      rootTitle: root.title,
      mainTitle: root.mainTitle,
      rootDocketState: root.docketState,
      sprints: root.sprints,
      workItems: snapshot.workItems,
    });

    if (!normalized.valid) {
      return normalized;
    }

    const canonical = buildWorklogSnapshot(normalized.state);

    return {
      valid: canonical.valid,
      error: canonical.error,
      state: normalized.state,
      snapshot: canonical.snapshot,
    };
  }

  if (snapshot?.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    return {
      valid: false,
      error: "Unsupported worklog snapshot version.",
    };
  }

  const normalized = graphSnapshotToLegacyState(snapshot);

  if (!normalized.valid) {
    return normalized;
  }

  const canonical = buildWorklogSnapshot(normalized.state, snapshot);

  return {
    valid: canonical.valid,
    error: canonical.error,
    state: normalized.state,
    snapshot: canonical.snapshot,
  };
}

export function stableSnapshotString(snapshot) {
  return JSON.stringify(snapshot);
}

export function getRelationshipsByType(snapshot, relationshipType) {
  const normalizedType = normalizeRelationshipType(relationshipType);

  return (snapshot.relationships || []).filter(
    (relationship) => relationship.relationshipType === normalizedType
  );
}

export function getSprintAssignments(snapshot, sprintId) {
  return (snapshot.sprintAssignments || []).filter(
    (assignment) => !sprintId || assignment.sprintId === sprintId
  );
}

export function createRelationship(sourceId, targetId, relationshipType) {
  return canonicalRelationship({
    sourceId,
    targetId,
    relationshipType,
  });
}

export function addRelationship(snapshot, relationship) {
  const nextRelationship = canonicalRelationship(relationship);
  const itemIds = new Set((snapshot.workItems || []).map((item) => item.id));

  if (
    !itemIds.has(nextRelationship.sourceId) ||
    !itemIds.has(nextRelationship.targetId)
  ) {
    return {
      ok: false,
      error: "Relationship points to a missing work item.",
    };
  }

  return {
    ok: true,
    snapshot: {
      ...snapshot,
      relationships: uniqueById([
        ...(snapshot.relationships || []),
        nextRelationship,
      ]),
    },
    relationship: nextRelationship,
  };
}

export function removeRelationship(snapshot, relationshipId) {
  return {
    ok: true,
    snapshot: {
      ...snapshot,
      relationships: (snapshot.relationships || []).filter(
        (relationship) => relationship.id !== relationshipId
      ),
    },
  };
}

export function createSprintAssignment({
  sprintId,
  workItemId,
  plannedHours = 0,
  loggedHours = 0,
  status = "concept",
  assignedDate = nowIso(),
}) {
  return canonicalSprintAssignment({
    sprintId,
    workItemId,
    plannedHours,
    loggedHours,
    status,
    assignedDate,
  });
}

export function addSprintAssignment(snapshot, assignment) {
  const nextAssignment = canonicalSprintAssignment(assignment);
  const itemById = new Map((snapshot.workItems || []).map((item) => [item.id, item]));
  const sprint = itemById.get(nextAssignment.sprintId);

  if (
    normalizeGenericType(sprint?.type) !== "sprint" ||
    !itemById.has(nextAssignment.workItemId)
  ) {
    return {
      ok: false,
      error: "Sprint assignment points to a missing sprint or work item.",
    };
  }

  const relationship = createRelationship(
    nextAssignment.sprintId,
    nextAssignment.workItemId,
    "assigned_to_sprint"
  );

  return {
    ok: true,
    snapshot: {
      ...snapshot,
      sprintAssignments: uniqueById([
        ...(snapshot.sprintAssignments || []),
        nextAssignment,
      ]),
      relationships: uniqueById([
        ...(snapshot.relationships || []),
        relationship,
      ]),
    },
    assignment: nextAssignment,
  };
}

export function removeSprintAssignment(snapshot, assignmentId) {
  const assignment = (snapshot.sprintAssignments || []).find(
    (entry) => entry.id === assignmentId
  );

  return {
    ok: true,
    snapshot: {
      ...snapshot,
      sprintAssignments: (snapshot.sprintAssignments || []).filter(
        (entry) => entry.id !== assignmentId
      ),
      relationships: assignment
        ? (snapshot.relationships || []).filter(
            (relationship) =>
              relationship.id !==
              makeRelationshipId(
                assignment.sprintId,
                assignment.workItemId,
                "assigned_to_sprint"
              )
          )
        : snapshot.relationships || [],
    },
  };
}

export function generateViewGraph(snapshot, view) {
  const normalizedSnapshot =
    snapshot.schemaVersion === SNAPSHOT_SCHEMA_VERSION
      ? snapshot
      : normalizeWorklogSnapshot(snapshot).snapshot;
  const workItems = normalizedSnapshot.workItems || [];
  const itemById = new Map(workItems.map((item) => [item.id, item]));
  const relationships = normalizedSnapshot.relationships || [];
  const sprintAssignments = normalizedSnapshot.sprintAssignments || [];
  const viewType = typeof view === "string" ? view : view?.type;
  const parentRelationships = relationships.filter(
    (relationship) => relationship.relationshipType === "parent"
  );
  const childIdsByParent = parentRelationships.reduce((acc, relationship) => {
    if (!acc.has(relationship.sourceId)) acc.set(relationship.sourceId, []);
    acc.get(relationship.sourceId).push(relationship.targetId);
    return acc;
  }, new Map());

  function descendantsFrom(rootIds, allowedTypes = null) {
    const visibleIds = new Set(rootIds);
    const queue = [...rootIds];

    while (queue.length > 0) {
      const parentId = queue.shift();
      const childIds = childIdsByParent.get(parentId) || [];

      childIds.forEach((childId) => {
        const child = itemById.get(childId);
        if (!child || visibleIds.has(childId)) return;
        if (allowedTypes && !allowedTypes.has(normalizeGenericType(child.type))) return;

        visibleIds.add(childId);
        queue.push(childId);
      });
    }

    return visibleIds;
  }

  function graphForIds(ids, edgeTypes = null) {
    return {
      nodes: Array.from(ids).map((id) => itemById.get(id)).filter(Boolean),
      edges: relationships.filter((relationship) => {
        if (edgeTypes && !edgeTypes.has(relationship.relationshipType)) return false;

        return ids.has(relationship.sourceId) && ids.has(relationship.targetId);
      }),
    };
  }

  if (viewType === "sprint") {
    const sprintId = typeof view === "string" ? ROOT_ID : view?.sprintId || ROOT_ID;
    const assignedIds = new Set(
      sprintAssignments
        .filter((assignment) => assignment.sprintId === sprintId)
        .map((assignment) => assignment.workItemId)
    );

    return {
      nodes: workItems.filter((item) => item.id === sprintId || assignedIds.has(item.id)),
      edges: relationships.filter(
        (relationship) =>
          relationship.sourceId === sprintId ||
          assignedIds.has(relationship.sourceId) ||
          assignedIds.has(relationship.targetId)
      ),
    };
  }

  if (viewType === "epic") {
    const rootEpicId = typeof view === "string" ? null : view?.epicId;
    const epicIds = workItems
      .filter((item) =>
        normalizeGenericType(item.type) === "epic" &&
        (!rootEpicId || item.id === rootEpicId)
      )
      .map((item) => item.id);
    const ids = descendantsFrom(
      epicIds,
      new Set(["story", "task", "job", "bug", "feature", "research"])
    );

    return graphForIds(ids, new Set(["parent", "child"]));
  }

  if (viewType === "story") {
    const rootStoryId = typeof view === "string" ? null : view?.storyId;
    const storyIds = workItems
      .filter((item) =>
        normalizeGenericType(item.type) === "story" &&
        (!rootStoryId || item.id === rootStoryId)
      )
      .map((item) => item.id);
    const ids = descendantsFrom(
      storyIds,
      new Set(["task", "job", "bug", "feature", "research"])
    );

    return graphForIds(ids, new Set(["parent", "child"]));
  }

  if (viewType === "timeline") {
    return {
      nodes: workItems
        .filter((item) => item.type !== "workspace")
        .slice()
        .sort((a, b) =>
          new Date(a.updatedAt || a.createdAt || 0).getTime() -
          new Date(b.updatedAt || b.createdAt || 0).getTime()
        ),
      edges: [],
    };
  }

  if (["calendar", "month", "week", "day", "range", "worklog"].includes(viewType)) {
    const scheduled = workItems.filter((item) =>
      item.type !== "workspace" &&
      item.type !== "sprint" &&
      (
        item.plannedStartDate ||
        item.plannedEndDate ||
        item.actualStartDate ||
        item.actualEndDate ||
        item.dueDate ||
        (Array.isArray(item.worklogs) && item.worklogs.length > 0)
      )
    );
    const ids = new Set(scheduled.map((item) => item.id));

    return {
      nodes: scheduled,
      edges: relationships.filter(
        (relationship) =>
          ids.has(relationship.sourceId) && ids.has(relationship.targetId)
      ),
    };
  }

  if (viewType === "dependencies") {
    const dependencyRelationships = relationships.filter((relationship) =>
      ["depends_on", "blocks"].includes(relationship.relationshipType)
    );
    const ids = new Set(
      dependencyRelationships.flatMap((relationship) => [
        relationship.sourceId,
        relationship.targetId,
      ])
    );

    return {
      nodes: Array.from(ids).map((id) => itemById.get(id)).filter(Boolean),
      edges: dependencyRelationships,
    };
  }

  if (viewType === "backlog") {
    const assignedIds = new Set(
      sprintAssignments.map((assignment) => assignment.workItemId)
    );

    return {
      nodes: workItems.filter(
        (item) => item.type !== "workspace" && item.type !== "sprint" && !assignedIds.has(item.id)
      ),
      edges: [],
    };
  }

  if (viewType === "completed") {
    const completed = workItems.filter((item) => item.status === "closed");
    const ids = new Set(completed.map((item) => item.id));

    return {
      nodes: completed,
      edges: relationships.filter(
        (relationship) => ids.has(relationship.sourceId) && ids.has(relationship.targetId)
      ),
    };
  }

  return {
    nodes: workItems,
    edges: relationships,
  };
}

export function createWorkItem(items, input) {
  const item = makeWorkItem(input);

  if (!item.id) {
    return {
      ok: false,
      error: "ID is required.",
    };
  }

  if (items.some((existing) => existing.id === item.id)) {
    return {
      ok: false,
      error: "A work item with this ID already exists.",
    };
  }

  if (!item.title) {
    return {
      ok: false,
      error: "Title is required.",
    };
  }

  if (!isValidParent(items, item.type, item.parentId)) {
    return {
      ok: false,
      error: "Choose a valid parent for this work item type.",
    };
  }

  return {
    ok: true,
    items: [...items, item],
    item,
  };
}

export function updateWorkItem(items, id, updates) {
  const existing = getItem(items, id);

  if (!existing) {
    return {
      ok: false,
      error: "Work item not found.",
    };
  }

  const nextType = updates.type
    ? normalizeType(updates.type)
    : existing.type;
  const nextParentId =
    updates.parentId === undefined
      ? existing.parentId
      : updates.parentId;

  if (!childrenRemainValid(items, id, nextType)) {
    return {
      ok: false,
      error: "This type change would make existing children invalid.",
    };
  }

  const updatedAt = nowIso();
  const merged = {
    ...existing,
    ...updates,
    id: existing.id,
    type: nextType,
    parentId: nextParentId,
    updatedAt,
  };

  if (
    isWorklogType(nextType) &&
    !updates.worklogs &&
    (updates.description !== undefined || updates.timeMinutes !== undefined)
  ) {
    const [primaryWorklog, ...otherWorklogs] = normalizeWorklogs(
      existing.worklogs,
      existing.updatedAt || existing.createdAt,
      existing.description,
      existing.timeMinutes
    );

    merged.worklogs = [
      {
        ...primaryWorklog,
        date: updatedAt,
        description: merged.description,
        timeMinutes: normalizeTimeMinutes(merged.timeMinutes),
      },
      ...otherWorklogs,
    ];
  }

  const draft = makeWorkItem(merged);

  if (!draft.title) {
    return {
      ok: false,
      error: "Title is required.",
    };
  }

  const nextItems = items.map((item) =>
    item.id === id ? draft : item
  );

  if (!isValidParent(nextItems, draft.type, draft.parentId, draft.id)) {
    return {
      ok: false,
      error: "Choose a valid parent for this work item type.",
    };
  }

  return {
    ok: true,
    items: nextItems,
    item: draft,
  };
}

export function reparentWorkItem(items, id, parentId) {
  return updateWorkItem(items, id, {
    parentId,
  });
}

export function deleteWorkItem(items, id) {
  const item = getItem(items, id);

  if (!item) {
    return {
      ok: false,
      error: "Work item not found.",
    };
  }

  const deleteIds = new Set([id, ...descendantsOf(items, id)]);

  return {
    ok: true,
    items: items.filter((entry) => !deleteIds.has(entry.id)),
    deletedIds: Array.from(deleteIds),
  };
}

export function calculateStoryPoints(items) {
  const byId = {};
  const timeById = {};
  const childrenByParent = items.reduce((acc, item) => {
    if (!acc[item.parentId]) acc[item.parentId] = [];
    acc[item.parentId].push(item);
    return acc;
  }, {});

  items.forEach((item) => {
    if (item.type === "story") {
      byId[item.id] = normalizeStoryPoints(item.storyPoints);
    }
  });

  function timeFor(item) {
    if (timeById[item.id] !== undefined) return timeById[item.id];

    const ownTime =
      isWorklogType(item.type)
        ? normalizeTimeMinutes(item.timeMinutes)
        : 0;
    const childTime = (childrenByParent[item.id] || []).reduce(
      (total, child) => total + timeFor(child),
      0
    );

    timeById[item.id] = ownTime + childTime;
    return timeById[item.id];
  }

  items.forEach((item) => {
    timeFor(item);
  });

  function storyPointsFor(item) {
    if (byId[item.id] !== undefined) return byId[item.id];

    byId[item.id] = (childrenByParent[item.id] || []).reduce(
      (total, child) => total + storyPointsFor(child),
      0
    );
    return byId[item.id];
  }

  items
    .filter((item) => item.type === "epic")
    .forEach((epic) => {
      byId[epic.id] = (childrenByParent[epic.id] || [])
        .filter((child) => child.type === "story")
        .reduce(
          (total, story) =>
            total + normalizeStoryPoints(story.storyPoints),
          0
        );
    });

  items.forEach((item) => {
    storyPointsFor(item);
  });

  byId[ROOT_ID] = (childrenByParent[ROOT_ID] || [])
    .reduce((total, child) => total + (byId[child.id] || 0), 0);
  timeById[ROOT_ID] = (childrenByParent[ROOT_ID] || []).reduce(
    (total, child) => total + timeFor(child),
    0
  );

  return {
    rootTotal: byId[ROOT_ID],
    byId,
    rootTimeMinutes: timeById[ROOT_ID],
    timeById,
  };
}

export function getValidParentOptions(items, type, childId = null) {
  const options = [
    {
      id: ROOT_ID,
      title: "Sprint",
      type: ROOT_ID,
    },
    ...items.map((item) => ({
      id: item.id,
      title: item.title,
      type: item.type,
    })),
  ];

  return options.filter((option) =>
    isValidParent(items, type, option.id, childId)
  );
}

export function generateWorkItemId(items, type) {
  const prefixByType = {
    epic: "EPIC",
    story: "STORY",
    task: "TASK",
    job: "JOB",
  };
  const prefix = prefixByType[type] || "ITEM";
  const existingIds = new Set(items.map((item) => item.id));
  let index = items.length + 1;
  let id = `${prefix}-${index}`;

  while (existingIds.has(id)) {
    index += 1;
    id = `${prefix}-${index}`;
  }

  return id;
}

export function generateSprintId(sprints) {
  const existingIds = new Set((sprints || []).map((sprint) => sprint.id));
  let index = existingIds.size + 1;
  let id = `sprint-${index}`;

  while (existingIds.has(id)) {
    index += 1;
    id = `sprint-${index}`;
  }

  return id;
}
