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
  [ROOT_ID]: ["epic"],
  epic: ["story", "task"],
  story: ["job", "task"],
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

function isWorklogType(type) {
  return type === "story" || type === "job" || type === "task";
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
    ...entry,
    id: entry?.id ? String(entry.id) : undefined,
    date: normalizeWorklogDate(entry?.date || entry?.worklogDate, fallbackDate),
    worklogDate: entry?.worklogDate
      ? normalizeWorklogDate(entry.worklogDate, fallbackDate)
      : undefined,
    description: String(entry?.description || entry?.comment || ""),
    comment: entry?.comment ? String(entry.comment) : undefined,
    employeeId: entry?.employeeId ? String(entry.employeeId) : undefined,
    employeeName: entry?.employeeName ? String(entry.employeeName) : undefined,
    timeMinutes: normalizeTimeMinutes(entry?.timeMinutes ?? entry?.durationMinutes),
    durationMinutes: normalizeTimeMinutes(entry?.durationMinutes ?? entry?.timeMinutes),
  }));
}

function worklogTotalMinutes(worklogs) {
  return worklogs.reduce(
    (total, entry) => total + normalizeTimeMinutes(entry.timeMinutes),
    0
  );
}

function worklogStableId(entry, itemId, index) {
  return String(
    entry?.id ||
      entry?.worklogId ||
      [
        itemId,
        entry?.date || entry?.worklogDate || "",
        entry?.employeeId || entry?.employeeName || "",
        entry?.description || entry?.comment || "",
        entry?.timeMinutes ?? entry?.durationMinutes ?? "",
        index,
      ].join(":")
  );
}

function directWorklogEntries(item) {
  if (!isWorklogType(item?.type) || !Array.isArray(item.worklogs)) return [];

  return item.worklogs
    .filter((entry) => entry?.id || entry?.worklogId)
    .map((entry, index) => ({
      id: worklogStableId(entry, item.id, index),
      minutes: normalizeTimeMinutes(entry?.timeMinutes ?? entry?.durationMinutes),
    }));
}

export function aggregateLoggedDurations(items = []) {
  const timeById = {};
  const ownTimeById = {};
  const worklogIdsById = {};
  const worklogMinutesById = {};
  const sprintTimeById = {};
  const sprintTimeByTitle = {};
  const childrenByParent = items.reduce((acc, item) => {
    if (!acc[item.parentId]) acc[item.parentId] = [];
    acc[item.parentId].push(item);
    return acc;
  }, {});

  function ownWorklogsFor(item) {
    const uniqueIds = new Set();
    let minutes = 0;

    directWorklogEntries(item).forEach((entry) => {
      if (!entry.id || uniqueIds.has(entry.id)) return;

      uniqueIds.add(entry.id);
      worklogMinutesById[entry.id] = entry.minutes;
      minutes += entry.minutes;
    });

    ownTimeById[item.id] = minutes;
    return uniqueIds;
  }

  function aggregateFor(item) {
    if (worklogIdsById[item.id]) {
      return worklogIdsById[item.id];
    }

    const ids = ownWorklogsFor(item);

    (childrenByParent[item.id] || []).forEach((child) => {
      aggregateFor(child).forEach((id) => ids.add(id));
    });

    worklogIdsById[item.id] = ids;
    timeById[item.id] = Array.from(ids).reduce(
      (total, id) => total + normalizeTimeMinutes(worklogMinutesById[id]),
      0
    );
    return ids;
  }

  items.forEach((item) => {
    aggregateFor(item);
  });

  const rootIds = new Set();
  (childrenByParent[ROOT_ID] || []).forEach((child) => {
    aggregateFor(child).forEach((id) => rootIds.add(id));
  });
  worklogIdsById[ROOT_ID] = rootIds;
  timeById[ROOT_ID] = Array.from(rootIds).reduce(
    (total, id) => total + normalizeTimeMinutes(worklogMinutesById[id]),
    0
  );

  items.forEach((item) => {
    const ownIds = ownWorklogsFor(item);
    const sprintId = item.elitical?.sprintId || item.sprintId || "";
    const sprintTitle = item.sprint || "";

    if (sprintId) {
      sprintTimeById[sprintId] = sprintTimeById[sprintId] || {
        ids: new Set(),
        minutes: 0,
      };
      ownIds.forEach((id) => sprintTimeById[sprintId].ids.add(id));
    }

    if (sprintTitle) {
      sprintTimeByTitle[sprintTitle] = sprintTimeByTitle[sprintTitle] || {
        ids: new Set(),
        minutes: 0,
      };
      ownIds.forEach((id) => sprintTimeByTitle[sprintTitle].ids.add(id));
    }
  });

  Object.values(sprintTimeById).forEach((entry) => {
    entry.minutes = Array.from(entry.ids).reduce(
      (total, id) => total + normalizeTimeMinutes(worklogMinutesById[id]),
      0
    );
  });
  Object.values(sprintTimeByTitle).forEach((entry) => {
    entry.minutes = Array.from(entry.ids).reduce(
      (total, id) => total + normalizeTimeMinutes(worklogMinutesById[id]),
      0
    );
  });

  return {
    rootTimeMinutes: timeById[ROOT_ID],
    timeById,
    ownTimeById,
    worklogIdsById,
    worklogMinutesById,
    sprintTimeById: Object.fromEntries(
      Object.entries(sprintTimeById).map(([id, entry]) => [id, entry.minutes])
    ),
    sprintTimeByTitle: Object.fromEntries(
      Object.entries(sprintTimeByTitle).map(([title, entry]) => [title, entry.minutes])
    ),
  };
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
    code: String(input?.code || input?.id || "").trim(),
    title: title || DEFAULT_ROOT_TITLE,
    docketState: normalizeDocketState(input?.docketState),
    sprintStartDate: isValidDate(input?.sprintStartDate)
      ? new Date(input.sprintStartDate).toISOString()
      : "",
    sprintEndDate: isValidDate(input?.sprintEndDate)
      ? new Date(input.sprintEndDate).toISOString()
      : "",
    sprintState: String(input?.sprintState || "").trim(),
    state: String(input?.state || "").trim(),
    createdBy: String(input?.createdBy || "").trim(),
    createdAt: isValidDate(input?.createdAt)
      ? new Date(input.createdAt).toISOString()
      : "",
    updatedBy: String(input?.updatedBy || "").trim(),
    updatedAt: isValidDate(input?.updatedAt)
      ? new Date(input.updatedAt).toISOString()
      : "",
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
    createdBy: String(input.createdBy || ""),
    updatedBy: String(input.updatedBy || ""),
    sprint: String(input.sprint || ""),
    docketState: normalizeDocketState(input.docketState),
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
    parentId: item.parentId || "",
    category: normalizeEnum(item.category, CATEGORIES, "feature"),
    openQueue: Boolean(item.openQueue),
    assignee: String(item.assignee || ""),
    sprint: String(item.sprint || ""),
    code: String(item.code || "").trim(),
    sprintStartDate: isValidDate(item.sprintStartDate)
      ? new Date(item.sprintStartDate).toISOString()
      : "",
    sprintEndDate: isValidDate(item.sprintEndDate)
      ? new Date(item.sprintEndDate).toISOString()
      : "",
    sprintState: String(item.sprintState || "").trim(),
    state: String(item.state || "").trim(),
    createdBy: String(item.createdBy || "").trim(),
    updatedBy: String(item.updatedBy || "").trim(),
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
        code: sprint.code,
        sprintStartDate: sprint.sprintStartDate,
        sprintEndDate: sprint.sprintEndDate,
        sprintState: sprint.sprintState,
        state: sprint.state,
        createdBy: sprint.createdBy,
        createdAt: sprint.createdAt || DEFAULT_TIMESTAMP,
        updatedBy: sprint.updatedBy,
        updatedAt: sprint.updatedAt || latestUpdatedAt,
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
      { id: "main", title: "Tree View", type: "main" },
      { id: "sprint", title: state.rootTitle, type: "sprint", sprintId: ROOT_ID },
      { id: "backlog", title: "Backlog View", type: "backlog" },
      { id: "worklog", title: "Worklog View", type: "worklog" },
      { id: "dashboard", title: "Dashboard", type: "dashboard" },
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
      code: item.code || item.id,
      title: item.title,
      docketState: normalizeDocketState(item.status || item.docketState),
      sprintStartDate: item.sprintStartDate,
      sprintEndDate: item.sprintEndDate,
      sprintState: item.sprintState,
      state: item.state,
      createdBy: item.createdBy,
      createdAt: item.createdAt,
      updatedBy: item.updatedBy,
      updatedAt: item.updatedAt,
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

export function buildWorklogSnapshot(state) {
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
    snapshot: legacyStateToGraphSnapshot(normalized.state),
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

  const canonical = buildWorklogSnapshot(normalized.state);

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
  const loggedDurations = aggregateLoggedDurations(items);

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

  byId[ROOT_ID] = (childrenByParent[ROOT_ID] || [])
    .filter((child) => child.type === "epic")
    .reduce((total, epic) => total + (byId[epic.id] || 0), 0);

  return {
    rootTotal: byId[ROOT_ID],
    byId,
    ...loggedDurations,
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
