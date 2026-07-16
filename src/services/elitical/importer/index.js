import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_ID = "storyRoot";
const DEFAULT_DUMP_DIR = ".elitical/dump";
const DEFAULT_OUTPUT_FILE = "src/data/elitical-normalized.json";
const TARGET_PROJECT_CODE = "DES";
const TARGET_PROJECT_NAME = "UX Designer";
const SUPPORTED_TYPES = new Set(["EPIC", "STORY", "JOB"]);
const STATE_BY_NAME = {
  artifact: "artifact",
  closed: "closed",
  concept: "concept",
  design: "design",
  review: "review",
};
const PRIORITY_BY_NAME = {
  blocker: "blocker",
  critical: "critical",
  info: "info",
  major: "major",
  minor: "minor",
};
const CATEGORY_BY_NAME = {
  defect: "defect",
  escalation: "escalation",
  enhancement: "enhancement",
  feature: "feature",
};

function repoRoot() {
  const currentFile = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(currentFile), "../../../..");
}

function readJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8").trim();

  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function endpointFromFilename(fileName) {
  if (fileName.includes("_Project_user_")) return "projects";
  if (fileName.includes("_Sprint_projectId_")) return "sprints";
  if (fileName.includes("_Sprint_utResCode_")) return "sprint";
  if (fileName.includes("_Docket_attrList_")) return "dockets";
  if (fileName.includes("_IssuesBoard_")) return "dockets";
  if (fileName.includes("_Docket_childList_")) return "childDockets";
  if (fileName.includes("_Docket_utResCode_")) return "docket";
  if (fileName.includes("_DocketState_projectId_")) return "states";
  if (fileName.includes("_Employee_projectId_")) return "employees";
  if (fileName.includes("_Employee_utResCode_")) return "employee";
  return "unsupported";
}

function paramFromFilename(fileName, name) {
  const match = fileName.match(new RegExp(`_${name}_([^_]+)(?:_|\\.json$)`));
  return match?.[1] || "";
}

function uniqueById(items) {
  const byId = new Map();

  items.forEach((item) => {
    if (!item?.id) return;
    byId.set(item.id, {
      ...byId.get(item.id),
      ...item,
    });
  });

  return Array.from(byId.values());
}

function isoFromMillis(value) {
  const numberValue = Number(value);

  if (!Number.isFinite(numberValue) || numberValue <= 0) return "";

  return new Date(numberValue).toISOString();
}

function text(value) {
  return String(value || "").trim();
}

function enumValue(value, map, fallback) {
  const normalized = text(value).toLowerCase().replace(/[_\s]+/g, "-");
  return map[normalized] || fallback;
}

function normalizeProject(project) {
  return {
    id: text(project.id),
    code: text(project.code),
    name: text(project.name),
    state: text(project.projectState || project.objState),
    teamId: text(project.teamId),
  };
}

function normalizeSprint(sprint, projectId = "") {
  return {
    id: text(sprint.id),
    projectId,
    code: text(sprint.code),
    title: text(sprint.name || sprint.title || sprint.code || sprint.id),
    sprintStartDate: isoFromMillis(sprint.plannedStartDate),
    sprintEndDate: isoFromMillis(sprint.plannedEndDate),
    sprintState: text(sprint.sprintState),
    state: text(sprint.objState || sprint.nextState),
    createdBy: text(sprint.createdUserName),
    createdAt: isoFromMillis(sprint.createdTime),
    updatedBy: text(sprint.updatedUserName),
    updatedAt: isoFromMillis(sprint.updatedTime),
  };
}

function normalizeState(state, projectId = "") {
  return {
    id: text(state.id),
    projectId,
    code: text(state.code),
    name: text(state.name),
    category: text(state.category),
    docketState: enumValue(state.name, STATE_BY_NAME, "concept"),
  };
}

function normalizeEmployee(employee, projectId = "") {
  const user = employee.userDto || {};

  return {
    id: text(employee.id),
    projectId,
    employeeId: text(employee.employeeId),
    name: text(employee.name || user.userName || employee.userName),
    userId: text(employee.userId || user.id),
    email: text(employee.workEmail || user.emailId),
    designation: text(employee.designationName),
    department: text(employee.departmentName),
  };
}

function normalizeDocket(docket, fileProjectId = "") {
  const type = text(docket.type).toUpperCase();

  if (!SUPPORTED_TYPES.has(type)) return null;

  return {
    id: text(docket.id),
    num: text(docket.num),
    type,
    title: text(docket.title || docket.num || docket.id),
    description: text(docket.descr),
    projectId: text(docket.projectId || fileProjectId),
    sprintId: text(docket.sprintId),
    epicId: text(docket.epicId),
    epicName: text(docket.epicName),
    epicNum: text(docket.epicNum),
    storyId: text(docket.storyId),
    storyName: text(docket.storyName),
    storyNum: text(docket.storyNum),
    parentId: text(docket.parentId),
    stateId: text(docket.dktStateId),
    stateName: text(docket.dktStateName),
    docketState: enumValue(docket.dktStateName, STATE_BY_NAME, "concept"),
    category: enumValue(docket.category, CATEGORY_BY_NAME, "feature"),
    priority: enumValue(docket.priority, PRIORITY_BY_NAME, "info"),
    assigneeId: text(docket.assigneeId),
    assigneeName: text(docket.assigneeName),
    reporterId: text(docket.reporterId),
    reporterName: text(docket.reporterName),
    storyPoints: Number.isFinite(Number(docket.storyPointEst))
      ? Number(docket.storyPointEst)
      : 0,
    createdBy: text(docket.createdUserName),
    createdAt: isoFromMillis(docket.createdTime),
    updatedBy: text(docket.updatedUserName),
    updatedAt: isoFromMillis(docket.updatedTime || docket.sortedTime),
  };
}

function collectDump(dumpDir) {
  const collected = {
    projects: [],
    sprints: [],
    dockets: [],
    states: [],
    employees: [],
    ignoredFiles: [],
  };

  const files = fs.readdirSync(dumpDir).filter((file) => file.endsWith(".json"));

  files.forEach((file) => {
    const endpoint = endpointFromFilename(file);
    const payload = readJsonFile(path.join(dumpDir, file));
    const projectId = paramFromFilename(file, "projectId");

    if (!payload) {
      collected.ignoredFiles.push({ file, reason: "empty-or-invalid-json" });
      return;
    }

    if (endpoint === "projects" && Array.isArray(payload.projectList)) {
      collected.projects.push(...payload.projectList.map(normalizeProject));
      return;
    }

    if (endpoint === "sprints" && Array.isArray(payload.sprintList)) {
      collected.sprints.push(
        ...payload.sprintList.map((sprint) => normalizeSprint(sprint, projectId))
      );
      return;
    }

    if (endpoint === "sprint" && payload.id) {
      collected.sprints.push(normalizeSprint(payload, projectId));
      return;
    }

    if (
      (endpoint === "dockets" || endpoint === "childDockets") &&
      Array.isArray(payload.docketList)
    ) {
      collected.dockets.push(
        ...payload.docketList
          .map((docket) => normalizeDocket(docket, projectId))
          .filter(Boolean)
      );
      return;
    }

    if (endpoint === "docket" && payload.id) {
      const docket = normalizeDocket(payload, projectId);
      if (docket) collected.dockets.push(docket);
      return;
    }

    if (endpoint === "states" && Array.isArray(payload.docketStateList)) {
      collected.states.push(
        ...payload.docketStateList.map((state) => normalizeState(state, projectId))
      );
      return;
    }

    if (endpoint === "employees" && Array.isArray(payload.employeeList)) {
      collected.employees.push(
        ...payload.employeeList.map((employee) => normalizeEmployee(employee, projectId))
      );
      return;
    }

    if (endpoint === "employee" && payload.id) {
      collected.employees.push(normalizeEmployee(payload, projectId));
      return;
    }

    collected.ignoredFiles.push({ file, reason: "unsupported-endpoint" });
  });

  return {
    projects: uniqueById(collected.projects),
    sprints: uniqueById(collected.sprints),
    dockets: uniqueById(collected.dockets),
    states: uniqueById(collected.states),
    employees: uniqueById(collected.employees),
    ignoredFiles: collected.ignoredFiles,
  };
}

function isTargetProject(project) {
  return project.code === TARGET_PROJECT_CODE || project.name === TARGET_PROJECT_NAME;
}

function filterToTargetProject(collected) {
  const targetProjects = collected.projects.filter(isTargetProject);
  const targetProjectIds = new Set(targetProjects.map((project) => project.id));
  const targetDockets = collected.dockets.filter((docket) =>
    targetProjectIds.has(docket.projectId)
  );
  const targetDocketIds = new Set(targetDockets.map((docket) => docket.id));
  const referencedSprintIds = new Set(
    targetDockets.map((docket) => docket.sprintId).filter(Boolean)
  );
  const targetSprints = collected.sprints.filter(
    (sprint) =>
      targetProjectIds.has(sprint.projectId) || referencedSprintIds.has(sprint.id)
  );
  const targetStates = collected.states.filter((state) =>
    targetProjectIds.has(state.projectId)
  );
  const targetEmployeeIds = new Set();

  targetDockets.forEach((docket) => {
    if (docket.assigneeId) targetEmployeeIds.add(docket.assigneeId);
    if (docket.reporterId) targetEmployeeIds.add(docket.reporterId);
  });

  const targetEmployees = collected.employees.filter(
    (employee) =>
      targetProjectIds.has(employee.projectId) || targetEmployeeIds.has(employee.id)
  );
  const filteredOut = {
    projects: collected.projects.length - targetProjects.length,
    sprints: collected.sprints.length - targetSprints.length,
    dockets: collected.dockets.length - targetDockets.length,
    states: collected.states.length - targetStates.length,
    employees: collected.employees.length - targetEmployees.length,
  };

  return {
    filtered: {
      ...collected,
      projects: targetProjects,
      sprints: targetSprints,
      dockets: targetDockets.filter((docket) => {
        if (docket.type === "EPIC") return true;
        if (docket.type === "STORY") return !docket.epicId || targetDocketIds.has(docket.epicId);
        if (docket.type === "JOB") return !docket.storyId || targetDocketIds.has(docket.storyId);
        return false;
      }),
      states: targetStates,
      employees: targetEmployees,
    },
    filteredOut,
  };
}

function sprintTitle(sprintsById, sprintId) {
  return sprintsById.get(sprintId)?.title || "";
}

function workItemBase(docket, sprintsById) {
  const timestamp = docket.updatedAt || docket.createdAt || new Date(0).toISOString();

  return {
    id: docket.id,
    sourceId: docket.id,
    title: docket.title,
    description: docket.description,
    category: docket.category,
    priority: docket.priority,
    sprint: sprintTitle(sprintsById, docket.sprintId),
    docketState: docket.docketState,
    assignee: docket.assigneeName,
    createdBy: docket.createdBy,
    createdAt: docket.createdAt || timestamp,
    updatedBy: docket.updatedBy,
    updatedAt: timestamp,
    elitical: {
      num: docket.num,
      projectId: docket.projectId,
      sprintId: docket.sprintId,
      epicId: docket.epicId,
      storyId: docket.storyId,
      stateId: docket.stateId,
      assigneeId: docket.assigneeId,
      reporterId: docket.reporterId,
    },
  };
}

function buildDocketModel(collected) {
  const docketsById = new Map(collected.dockets.map((docket) => [docket.id, docket]));
  const epics = [];
  const stories = [];
  const jobs = [];

  collected.dockets.forEach((docket) => {
    if (docket.type === "EPIC") {
      epics.push({
        ...docket,
        parentId: ROOT_ID,
      });
    }
  });

  collected.dockets.forEach((docket) => {
    if (docket.type !== "STORY") return;

    const parentId =
      docket.parentId ||
      (docket.epicId && docketsById.get(docket.epicId)?.type === "EPIC"
        ? docket.epicId
        : "");

    if (!parentId) return;

    stories.push({
      ...docket,
      parentId,
    });
  });

  collected.dockets.forEach((docket) => {
    if (docket.type !== "JOB") return;

    const parentId =
      docket.parentId ||
      (docket.storyId && docketsById.get(docket.storyId)?.type === "STORY"
        ? docket.storyId
        : "");

    if (!parentId) return;

    jobs.push({
      ...docket,
      parentId,
    });
  });

  return {
    epics,
    stories,
    jobs,
  };
}

function toWorkItems(model) {
  const sprintsById = new Map(model.sprints.map((sprint) => [sprint.id, sprint]));
  const syntheticWorkItem = (item, type) => ({
    id: item.id,
    title: item.title,
    description: item.description || "",
    category: item.category || "feature",
    type,
    priority: item.priority || "info",
    parentId: item.parentId,
    sprint: item.sprint || sprintTitle(sprintsById, item.sprintId),
    docketState: item.docketState || "concept",
    assignee: "",
    createdBy: "",
    createdAt: new Date(0).toISOString(),
    updatedBy: "",
    updatedAt: new Date(0).toISOString(),
  });

  return [
    ...model.epics.map((epic) =>
      epic.num
        ? {
            ...workItemBase(epic, sprintsById),
            type: "epic",
            parentId: ROOT_ID,
          }
        : syntheticWorkItem(epic, "epic")
    ),
    ...model.stories.map((story) =>
      story.num
        ? {
            ...workItemBase(story, sprintsById),
            type: "story",
            parentId: story.parentId,
            storyPoints: story.storyPoints,
            worklogs: [
              {
                date: story.updatedAt || story.createdAt || new Date(0).toISOString(),
                description: "",
                timeMinutes: 0,
              },
            ],
          }
        : {
            ...syntheticWorkItem(story, "story"),
            storyPoints: story.storyPoints || 0,
            worklogs: [
              {
                date: new Date(0).toISOString(),
                description: "",
                timeMinutes: 0,
              },
            ],
          }
    ),
    ...model.jobs.map((job) => ({
      ...workItemBase(job, sprintsById),
      type: "job",
      parentId: job.parentId,
      worklogs: [
        {
          date: job.updatedAt || job.createdAt || new Date(0).toISOString(),
          description: "",
          timeMinutes: 0,
        },
      ],
    })),
  ];
}

function toAppState(model) {
  return {
    mainTitle: "Genesis",
    rootTitle: TARGET_PROJECT_NAME,
    rootDocketState: "concept",
    rootPosition: null,
    sprints: [
      {
        id: ROOT_ID,
        title: TARGET_PROJECT_NAME,
        docketState: "concept",
      },
      ...model.sprints.map((sprint) => ({
        id: sprint.id,
        code: sprint.code,
        title: sprint.title,
        sprintStartDate: sprint.sprintStartDate,
        sprintEndDate: sprint.sprintEndDate,
        sprintState: sprint.sprintState,
        state: sprint.state,
        createdBy: sprint.createdBy,
        createdAt: sprint.createdAt,
        updatedBy: sprint.updatedBy,
        updatedAt: sprint.updatedAt,
        docketState: "concept",
      })),
    ],
    workItems: toWorkItems(model),
  };
}

export function importEliticalDump({
  dumpDir = path.join(repoRoot(), DEFAULT_DUMP_DIR),
  outputFile = path.join(repoRoot(), DEFAULT_OUTPUT_FILE),
} = {}) {
  const collected = collectDump(dumpDir);
  const { filtered, filteredOut } = filterToTargetProject(collected);
  const docketModel = buildDocketModel(filtered);
  const targetDocketCounts = {
    epics: filtered.dockets.filter((docket) => docket.type === "EPIC").length,
    stories: filtered.dockets.filter((docket) => docket.type === "STORY").length,
    jobs: filtered.dockets.filter((docket) => docket.type === "JOB").length,
  };
  const model = {
    generatedAt: new Date().toISOString(),
    sourceDir: path.relative(repoRoot(), dumpDir),
    targetProject: {
      code: TARGET_PROJECT_CODE,
      name: TARGET_PROJECT_NAME,
    },
    ignoredFiles: filtered.ignoredFiles,
    filteredOut,
    projects: filtered.projects,
    sprints: filtered.sprints,
    states: filtered.states,
    employees: filtered.employees,
    epics: docketModel.epics,
    stories: docketModel.stories,
    jobs: docketModel.jobs,
    report: {
      removedStartupDemoData: [
        "src/data/jira.yaml startup seed import",
        "src/data/predefinedSprints.js startup merge",
        "src/data/predefinedEpics.js startup preset import",
        "local cached snapshot as startup source",
        "automatic remote GitHub snapshot as startup source",
      ],
      filter: {
        projectCode: TARGET_PROJECT_CODE,
        projectName: TARGET_PROJECT_NAME,
        projectsFilteredOut: filteredOut.projects,
        sprintsFilteredOut: filteredOut.sprints,
        docketsFilteredOut: filteredOut.dockets,
        statesFilteredOut: filteredOut.states,
        employeesFilteredOut: filteredOut.employees,
        storiesDroppedBecauseParentMissing: targetDocketCounts.stories - docketModel.stories.length,
        jobsDroppedBecauseParentMissing: targetDocketCounts.jobs - docketModel.jobs.length,
      },
      remaining: {
        projects: filtered.projects.length,
        sprints: filtered.sprints.length,
        epics: docketModel.epics.length,
        stories: docketModel.stories.length,
        jobs: docketModel.jobs.length,
      },
    },
  };
  const output = {
    ...model,
    appState: toAppState(model),
  };

  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, `${JSON.stringify(output, null, 2)}\n`);

  return output;
}

if (globalThis.process?.argv?.[1] === fileURLToPath(import.meta.url)) {
  const output = importEliticalDump();
  const counts = {
    projects: output.projects.length,
    sprints: output.sprints.length,
    epics: output.epics.length,
    stories: output.stories.length,
    jobs: output.jobs.length,
    ignoredFiles: output.ignoredFiles.length,
    filteredOut: output.filteredOut,
  };

  console.log(JSON.stringify(counts, null, 2));
}
