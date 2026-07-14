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
  story: ["job"],
  task: [],
  job: [],
};

const DEFAULT_ROOT_TITLE = "Sprint View";
export const SNAPSHOT_SCHEMA_VERSION = 1;

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
    rootDocketState: "concept",
    rootPosition: null,
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
      rootDocketState: normalizeDocketState(input?.rootDocketState),
      rootPosition: normalizePosition(input?.rootPosition),
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
    snapshot: {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      root: {
        title: normalized.state.rootTitle,
        docketState: normalizeDocketState(normalized.state.rootDocketState),
      },
      workItems: normalized.state.workItems.map(canonicalWorkItem),
    },
  };
}

export function normalizeWorklogSnapshot(snapshot) {
  if (snapshot?.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    return {
      valid: false,
      error: "Unsupported worklog snapshot version.",
    };
  }

  const root = snapshot.root || {};
  const normalized = normalizeSavedState({
    rootTitle: root.title,
    rootDocketState: root.docketState,
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

export function stableSnapshotString(snapshot) {
  return JSON.stringify(snapshot);
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
