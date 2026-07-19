import { EliticalAuthError, EliticalAuthService } from "../auth/index.js";
import type {
  AttachmentPayload,
  CreateDocketPayload,
  CreateWorklogPayload,
  EliticalAuthenticatedRequest,
  EliticalAuthenticatedResponse,
  EliticalClientContract,
  EliticalEmployee,
  EliticalLookupValue,
  EliticalUser,
  UpdateDocketPayload,
} from "../types/index.js";
import type {
  Docket,
  Issue,
  Project,
  Sprint,
  Worklog,
} from "../models/index.js";
import {
  eliticalWorklogDateMillis,
  selectUniqueWorklogReconciliationMatch,
  worklogMatchesForReconciliation,
} from "../worklogReconciliation.js";
import { EliticalClientError } from "./EliticalClientError.js";

let nextEliticalClientId = 1;
const DOCKET_REFERRER_PATH = "/docket/issues/list";
const DOCKET_FORM_REFERRER_PATH = "/docket/form";
const UPDATE_DOCKET_FIELDS = new Set([
  "title",
  "description",
  "descr",
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
  "storyPoints",
  "type",
]);

const PRIORITIES: EliticalLookupValue[] = [
  { id: "INFO", code: "INFO", name: "Info" },
  { id: "MINOR", code: "MINOR", name: "Minor" },
  { id: "MAJOR", code: "MAJOR", name: "Major" },
  { id: "CRITICAL", code: "CRITICAL", name: "Critical" },
  { id: "BLOCKER", code: "BLOCKER", name: "Blocker" },
];

const CATEGORIES: EliticalLookupValue[] = [
  { id: "FEATURE", code: "FEATURE", name: "Feature" },
  { id: "ENHANCEMENT", code: "ENHANCEMENT", name: "Enhancement" },
  { id: "DEFECT", code: "DEFECT", name: "Defect" },
  { id: "ESCALATION", code: "ESCALATION", name: "Escalation" },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function listPayload<T>(payload: unknown, key: string): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (!isRecord(payload)) return [];

  const keyed = payload[key];
  const items = payload.items;
  const docketList = payload.docketList;
  const docketListMap = payload.docketListMap;

  if (Array.isArray(keyed)) return keyed as T[];
  if (Array.isArray(items)) return items as T[];
  if (Array.isArray(docketList)) return docketList as T[];
  if (isRecord(docketListMap)) {
    return Object.values(docketListMap).flatMap((entry) =>
      Array.isArray(entry) ? (entry as T[]) : []
    );
  }

  return [];
}

function positiveInteger(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function duplicateDocketIdCount(issues: Issue[]) {
  const seen = new Set<string>();
  let duplicates = 0;

  issues.forEach((issue) => {
    if (!issue.id) return;

    if (seen.has(issue.id)) {
      duplicates += 1;
      return;
    }

    seen.add(issue.id);
  });

  return duplicates;
}

function requireRecord<T>(payload: unknown, endpoint: string): T {
  if (!isRecord(payload)) {
    throw new EliticalClientError(
      "INVALID_RESPONSE",
      "Elitical response was not an object.",
      { endpoint, payload }
    );
  }

  return payload as T;
}

function minutesFromWorklogPayload(payload: CreateWorklogPayload): number {
  const explicitMinutes = Number(
    payload.minutes ??
      payload.timeMinutes ??
      payload.durationMinutes ??
      payload.loggedMinutes
  );

  if (Number.isFinite(explicitMinutes) && explicitMinutes > 0) {
    return Math.round(explicitMinutes);
  }

  const hours = Number(payload.hour ?? payload.hours ?? payload.loggedHours ?? payload.duration ?? 0);
  const minutes = Number(payload.min ?? 0);

  return Math.max(0, Math.round((Number.isFinite(hours) ? hours : 0) * 60 + (Number.isFinite(minutes) ? minutes : 0)));
}

function numericWorklogValue(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;

  const number = Number(value);

  return Number.isFinite(number) ? number : null;
}

function localDateKeyFromMillis(value: number | null) {
  if (!value) return "";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "";

  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function worklogDurationFromValues(hour: unknown, min: unknown) {
  return (numericWorklogValue(hour) || 0) * 60 + (numericWorklogValue(min) || 0);
}

function upperLookup(value: unknown, fallback: string) {
  const text = String(value || "").trim();

  return text ? text.toUpperCase() : fallback;
}

function firstText(...values: unknown[]) {
  const match = values.find(
    (value) => value !== undefined && value !== null && String(value).trim()
  );

  return match === undefined ? "" : String(match).trim();
}

function numericValue(value: unknown): number {
  if (value === undefined || value === null || value === "") return 0;

  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : 0;
}

function worklogId(worklog: Worklog): string {
  return String(worklog.id || worklog.worklogId || worklog.cx || "");
}

function worklogIdFromPayload(payload: unknown): string {
  if (Array.isArray(payload)) {
    for (const entry of payload) {
      const nested = worklogIdFromPayload(entry);

      if (nested) return nested;
    }

    return "";
  }

  if (!payload || typeof payload !== "object") return "";

  const record = payload as Record<string, unknown>;
  const direct = String(record.id || record.worklogId || record.eliticalId || record.cx || "");

  if (direct) return direct;

  for (const key of ["payload", "data", "body", "worklog", "worklogDto", "worklogDTO"]) {
    const nested = worklogIdFromPayload(record[key]);

    if (nested) return nested;
  }

  return "";
}

function nativeDocketUpdatePayload(
  docketId: string,
  fields: Record<string, unknown>
) {
  return {
    id: docketId,
    title: "",
    num: "",
    projectId: "",
    projectName: "",
    type: null,
    descr: null,
    assigneeId: "",
    assigneeImage: "",
    assigneeName: "",
    captchaText: null,
    category: null,
    categorySet: [],
    check: false,
    createdTime: null,
    createdUserId: null,
    createdUserName: null,
    currentPage: null,
    dktEndDate: null,
    dktStartDate: null,
    dktStateCategory: null,
    priority: null,
    prioritySet: [],
    dktStateId: "",
    dktStateName: "",
    endItem: null,
    epicId: "",
    epicName: null,
    epicNum: null,
    hasNoSprint: false,
    sprintId: null,
    sprintName: "",
    milestoneId: null,
    milestoneName: null,
    objState: null,
    objStateSet: null,
    pagesize: null,
    randomNumber: null,
    removeComment: null,
    reporterId: "",
    reporterName: null,
    reviewerComment: null,
    reviewerRating: null,
    secndAssigneeName: null,
    secondaryAssigneeId: null,
    startItem: null,
    storyId: "",
    storyName: "",
    storyNum: null,
    storyPointEst: 0,
    tags: null,
    totalItem: null,
    totalPage: null,
    typeSet: [],
    updateComment: null,
    updateUserId: null,
    updatedTime: null,
    updatedUserName: null,
    imgAttachmentDtoSet: [],
    videoAttachmentDtoSet: [],
    ...fields,
  };
}

function validateResponse(response: EliticalAuthenticatedResponse) {
  if (!response.ok) {
    console.error("[EliticalClient] validateResponse() throwing", {
      endpoint: response.endpoint,
      status: response.status,
      statusText: response.statusText,
      payload: response.payload,
      callStack: new Error().stack,
    });

    throw new EliticalClientError(
      response.status === 401 || response.status === 403
        ? "AUTHENTICATION_REQUIRED"
        : "REQUEST_FAILED",
      `Elitical request failed (${response.status}): ${
        isRecord(response.payload)
          ? String(response.payload.message || response.payload.error || response.statusText || "")
          : String(response.payload || response.statusText || "")
      }`.trim(),
      {
        endpoint: response.endpoint,
        status: response.status,
        payload: response.payload,
      }
    );
  }

  if (response.payload === undefined) {
    response.payload = null;
  }
}

export class EliticalClient implements EliticalClientContract {
  private authService: EliticalAuthService;
  private readonly instanceId = nextEliticalClientId++;

  constructor(authService: EliticalAuthService) {
    this.authService = authService;
    console.info("[EliticalClient] constructed", {
      eliticalClientInstanceId: this.instanceId,
    });
  }

  async login() {
    return this.authService.login();
  }

  async logout(): Promise<void> {
    await this.authService.logout();
  }

  async close(): Promise<void> {
    await this.authService.close();
  }

  async currentUser(): Promise<EliticalUser> {
    return this.getCurrentUser();
  }

  async getCurrentUser(): Promise<EliticalUser> {
    const response = await this.request({
      path: "/api/1/UserSessionDto",
    });

    return requireRecord<EliticalUser>(response.payload, response.endpoint);
  }

  async getProjects(): Promise<Project[]> {
    const response = await this.request({
      path: "/api/1/Project/user",
    });

    return listPayload<Project>(response.payload, "projectList");
  }

  async getSprints(projectId: string): Promise<Sprint[]> {
    const response = await this.request({
      method: "POST",
      path: "/api/1/Sprint/projectId",
      body: {
        projectId,
        sprintStateSet: null,
      },
    });

    return listPayload<Sprint>(response.payload, "sprintList");
  }

  async getUsers(projectId: string): Promise<EliticalEmployee[]> {
    const response = await this.request({
      path: "/api/1/Employee/projectId",
      query: {
        projectId,
      },
    });

    return listPayload<EliticalEmployee>(response.payload, "employeeList");
  }

  async getStates(projectId: string): Promise<EliticalLookupValue[]> {
    const response = await this.request({
      path: "/api/1/DocketState/projectId",
      query: {
        projectId,
      },
    });

    return listPayload<EliticalLookupValue>(response.payload, "docketStateList");
  }

  async getPriorities(): Promise<EliticalLookupValue[]> {
    return PRIORITIES;
  }

  async getCategories(): Promise<EliticalLookupValue[]> {
    return CATEGORIES;
  }

  async getDockets(projectId: string): Promise<Issue[]> {
    return this.getIssues(projectId);
  }

  async getIssues(projectId: string): Promise<Issue[]> {
    const baseBody = {
      projectId,
      currentPage: 1,
      pagesize: 25,
    };

    const firstResponse = await this.request({
      method: "POST",
      path: "/api/1/IssuesBoard",
      referrerPath: "/docket/issues/list",
      body: baseBody,
    });

    const totalPage = isRecord(firstResponse.payload)
      ? positiveInteger(firstResponse.payload.totalPage, 1)
      : 1;
    const allDockets = listPayload<Issue>(firstResponse.payload, "issues");

    console.log(`Fetching page 1/${totalPage}`);

    for (let currentPage = 2; currentPage <= totalPage; currentPage += 1) {
      console.log(`Fetching page ${currentPage}/${totalPage}`);

      const pageResponse = await this.request({
        method: "POST",
        path: "/api/1/IssuesBoard",
        referrerPath: "/docket/issues/list",
        body: {
          ...baseBody,
          currentPage,
        },
      });

      allDockets.push(...listPayload<Issue>(pageResponse.payload, "issues"));
    }

    console.log("Total pages fetched:", totalPage);
    console.log("Total dockets fetched:", allDockets.length);
    console.log("Duplicate docket IDs:", duplicateDocketIdCount(allDockets));

    return allDockets;
  }

  async getDocket(docketId: string): Promise<Docket> {
    const response = await this.request({
      path: "/api/1/Docket",
      query: {
        id: docketId,
      },
    });

    return requireRecord<Docket>(response.payload, response.endpoint);
  }

  async getWorklogs(docketId: string): Promise<Worklog[]> {
    const response = await this.request({
      path: "/api/1/Worklog/list",
      query: {
        docketId,
      },
    });

    return listPayload<Worklog>(response.payload, "worklogList");
  }

  async createEpic(payload: Omit<CreateDocketPayload, "type">): Promise<Docket> {
    return this.createDocket({ ...(payload as CreateDocketPayload), type: "EPIC" });
  }

  async createStory(payload: Omit<CreateDocketPayload, "type">): Promise<Docket> {
    return this.createDocket({ ...(payload as CreateDocketPayload), type: "STORY" });
  }

  async createTask(payload: Omit<CreateDocketPayload, "type">): Promise<Docket> {
    return this.createDocket({ ...(payload as CreateDocketPayload), type: "TASK" });
  }

  async createJob(payload: Omit<CreateDocketPayload, "type">): Promise<Docket> {
    return this.createDocket({ ...(payload as CreateDocketPayload), type: "JOB" });
  }

  async createDocket(payload: CreateDocketPayload): Promise<Docket> {
    const body = this.docketPayload(payload) as Record<string, unknown>;
    const response = await this.request({
      method: "POST",
      path: "/api/1/Docket",
      referrerPath:
        payload.type === "STORY"
          ? DOCKET_REFERRER_PATH
          : payload.type === "JOB" || payload.type === "TASK" || payload.type === "EPIC"
          ? DOCKET_FORM_REFERRER_PATH
          : undefined,
      body,
    });

    if (isRecord(response.payload)) {
      const docket = response.payload as Docket;
      const id = String(docket.id || docket.docketId || docket.dktId || docket.cx || "");

      return id ? this.getDocket(id) : docket;
    }

    console.info("[EliticalClient] createDocket accepted with empty response", {
      endpoint: response.endpoint,
      status: response.status,
      type: payload.type,
      title: payload.title,
      requestedReferrerPath:
        payload.type === "STORY"
          ? DOCKET_REFERRER_PATH
          : payload.type === "JOB" || payload.type === "TASK" || payload.type === "EPIC"
          ? DOCKET_FORM_REFERRER_PATH
          : "",
      parentId: payload.parentId || "",
      projectId: body.projectId,
      epicId: body.epicId,
      storyId: body.storyId,
      sprintId: body.sprintId,
      sprintName: body.sprintName,
      assigneeId: body.assigneeId,
      outgoingDtoFieldNames: Object.keys(body),
      parentIdIsSynthetic: String(payload.parentId || "").startsWith("reference-"),
      epicIdIsSynthetic: String(body.epicId || "").startsWith("reference-"),
      storyIdIsSynthetic: String(body.storyId || "").startsWith("reference-"),
      parentResolution:
        String(payload.parentId || "").startsWith("reference-") ||
        String(body.epicId || "").startsWith("reference-") ||
        String(body.storyId || "").startsWith("reference-")
          ? "synthetic-reference-id-present"
          : "canonical-or-empty",
      emptyResponse: response.payload === null || response.payload === "",
      postConsideredSuccessful: response.ok,
    });

    return {
      __eliticalCreateAccepted: true,
      __emptyCreateResponse: true,
      __createEndpoint: response.endpoint,
      __createStatus: response.status,
      ...body,
    } as unknown as Docket;
  }

  async updateDocket(docketId: string, updates: UpdateDocketPayload): Promise<Docket> {
    const updateEntries: Array<[string, unknown, (value: unknown) => Promise<unknown>]> = [
      ["title", updates.title, (value) => this.mutateDocketUpdateField(docketId, "title", "/api/1/Docket/title", { title: String(value) })],
      [
        "description",
        updates.description ?? updates.descr,
        (value) => this.mutateDocketUpdateField(docketId, "description", "/api/1/Docket/description", {
          descr: String(value),
        }),
      ],
      [
        "dktStateId",
        updates.dktStateId,
        (value) => this.mutateDocketUpdateField(docketId, "dktStateId", "/api/1/Docket/state", {
          dktStateId: String(value),
          dktStateName: firstText(updates.dktStateName),
        }),
      ],
      [
        "assigneeId",
        updates.assigneeId,
        (value) => this.mutateDocketUpdateField(docketId, "assigneeId", "/api/1/Docket/assignee", {
          assigneeId: String(value),
        }),
      ],
      [
        "sprintId",
        updates.sprintId,
        (value) => this.mutateDocketUpdateField(docketId, "sprintId", "/api/1/Docket/sprint", {
          sprintId: String(value),
          sprintName: firstText(updates.sprintName),
          hasNoSprint: false,
        }),
      ],
      [
        "category",
        updates.category,
        (value) => this.mutateDocketUpdateField(docketId, "category", "/api/1/Docket/category", {
          category: String(value).trim().toUpperCase(),
        }),
      ],
      [
        "priority",
        updates.priority,
        (value) => this.mutateDocketUpdateField(docketId, "priority", "/api/1/Docket/priority", {
          priority: String(value).trim().toUpperCase(),
        }),
      ],
      [
        "epicId",
        updates.epicId,
        (value) => this.mutateDocketUpdateField(docketId, "epicId", "/api/1/Docket/parent", {
          type: "STORY",
          epicId: String(value),
        }),
      ],
      [
        "storyPointEst",
        updates.storyPointEst ?? updates.storyPoints,
        (value) => this.mutateDocketUpdateField(docketId, "storyPointEst", "/api/1/Docket/storyPoints", {
          storyPointEst: numericValue(value),
        }),
      ],
    ];
    const unsupportedFields = Object.keys(updates || {}).filter(
      (field) => field !== "id" && !UPDATE_DOCKET_FIELDS.has(field)
    );

    const entries = updateEntries.filter(([, value]) => value !== undefined);

    if (unsupportedFields.length) {
      console.info("[EliticalClient] updateDocket ignored unconfirmed fields", {
        docketId,
        unsupportedFields,
        allowedFields: Array.from(UPDATE_DOCKET_FIELDS),
      });
    }

    if (!entries.length) return this.getDocket(docketId);

    const results = [];

    for (const [field, value, update] of entries) {
      results.push(await update(value));
    }

    const accepted = results.filter((result) => isRecord(result) && result.accepted);
    const failed = results.filter((result) => isRecord(result) && !result.accepted);

    if (!accepted.length) {
      const firstFailure = failed.find(isRecord);
      throw new EliticalClientError(
        "REQUEST_FAILED",
        firstFailure?.message
          ? String(firstFailure.message)
          : "Elitical docket update failed.",
        {
          endpoint: firstFailure?.endpoint ? String(firstFailure.endpoint) : undefined,
          status: Number(firstFailure?.status || 0) || undefined,
          payload: firstFailure,
        }
      );
    }

    console.info("[EliticalClient] updateDocket reconciliation started", {
      docketId,
      fields: entries.map(([field]) => field),
      acceptedFields: accepted.map((result) => String(result.field || "")),
      failedFields: failed.map((result) => String(result.field || "")),
      retryMutation: false,
    });

    try {
      const docket = await this.getDocket(docketId);

      return {
        ...docket,
        __eliticalUpdateResult: {
          docketId,
          acceptedFields: accepted,
          failedFields: failed,
          reconciliation: {
            started: true,
            succeeded: true,
          },
        },
      } as unknown as Docket;
    } catch (error) {
      console.warn("[EliticalClient] updateDocket readback reconciliation failed", {
        docketId,
        acceptedFields: accepted.map((result) => String(result.field || "")),
        failedFields: failed.map((result) => String(result.field || "")),
        message: error instanceof Error ? error.message : String(error),
        retryMutation: false,
      });

      return {
        id: docketId,
        title: typeof updates.title === "string" ? updates.title : "",
        descr:
          typeof updates.descr === "string"
            ? updates.descr
            : typeof updates.description === "string"
            ? updates.description
            : "",
        __eliticalUpdateResult: {
          docketId,
          acceptedFields: accepted,
          failedFields: failed,
          reconciliation: {
            started: true,
            succeeded: false,
            error: error instanceof Error ? error.message : String(error),
          },
        },
      } as unknown as Docket;
    }
  }

  async updateTitle(docketId: string, title: string): Promise<Docket> {
    return this.updateDocket(docketId, { title });
  }

  async updateDescription(docketId: string, description: string): Promise<Docket> {
    return this.updateDocket(docketId, { description });
  }

  async updateState(docketId: string, stateId: string): Promise<Docket> {
    return this.updateDocket(docketId, { dktStateId: stateId });
  }

  async updateStoryPoints(docketId: string, storyPoints: number): Promise<Docket> {
    return this.updateDocket(docketId, { storyPointEst: storyPoints });
  }

  async updatePriority(docketId: string, priority: string): Promise<Docket> {
    return this.updateDocket(docketId, { priority });
  }

  async updateCategory(docketId: string, category: string): Promise<Docket> {
    return this.updateDocket(docketId, { category });
  }

  async updateAssignee(docketId: string, assigneeId: string): Promise<Docket> {
    return this.updateDocket(docketId, { assigneeId });
  }

  async updateParent(docketId: string, parentId: string): Promise<Docket> {
    return this.updateDocket(docketId, { epicId: parentId, type: "STORY" });
  }

  async updateSprint(docketId: string, sprintId: string): Promise<Docket> {
    return this.updateDocket(docketId, { sprintId });
  }

  async createWorklog(payload: CreateWorklogPayload): Promise<Worklog> {
    const docketId = String(payload.docketId || "");

    if (!docketId) {
      throw new EliticalClientError(
        "INVALID_RESPONSE",
        "docketId is required to create an Elitical worklog."
      );
    }

    const beforeIds = new Set((await this.getWorklogs(docketId)).map(worklogId));

    const createResponse = await this.request({
      method: "POST",
      path: "/api/1/Worklog",
      body: this.worklogPayload(payload, { create: true }),
    });
    const responseWorklogId = worklogIdFromPayload(createResponse.payload);

    if (responseWorklogId) {
      return {
        ...payload,
        id: responseWorklogId,
        docketId,
      } as Worklog;
    }

    const after = await this.getWorklogs(docketId);
    const newWorklogs = after.filter((worklog) => {
      const id = worklogId(worklog);
      return id && !beforeIds.has(id);
    });
    const created = selectUniqueWorklogReconciliationMatch(
      newWorklogs,
      this.worklogPayload(payload, { create: true })
    );

    return created || {
      __eliticalWorklogCreateAccepted: true,
      __emptyCreateResponse: true,
      docketId,
      worklogDate: payload.worklogDate || payload.date,
      comment: payload.comment || payload.description || payload.note,
      hour: payload.hour,
      min: payload.min,
    } as Worklog;
  }

  async updateWorklog(payload: CreateWorklogPayload): Promise<Worklog> {
    const id = String(payload.id || payload.worklogId || "");
    const docketId = String(payload.docketId || "");

    if (!id || !docketId) {
      throw new EliticalClientError(
        "INVALID_RESPONSE",
        "id and docketId are required to update an Elitical worklog."
      );
    }

    await this.request({
      method: "PUT",
      path: "/api/1/Worklog",
      body: this.worklogPayload(payload, { create: false }),
    });

    const after = await this.getWorklogs(docketId);
    const updated = after.find((worklog) => worklogId(worklog) === id);

    return updated || {
      ...payload,
      id,
      docketId,
    } as Worklog;
  }

  async uploadAttachment(_payload: AttachmentPayload): Promise<unknown> {
    throw new EliticalClientError(
      "UNIMPLEMENTED",
      "Elitical attachment upload endpoint has not been reverse engineered."
    );
  }

  async deleteAttachment(attachmentId: string): Promise<void> {
    await this.request({
      method: "DELETE",
      path: "/api/1/WorklogImageAttachment",
      body: {
        id: attachmentId,
      },
    });
  }

  private docketPayload(payload: CreateDocketPayload) {
    const description = payload.descr ?? payload.description ?? "";
    const storyPointEst = payload.storyPointEst ?? payload.storyPoints ?? 0;

    if (payload.type === "STORY") {
      return this.storyDocketPayload(payload, description, storyPointEst);
    }

    if (payload.type === "JOB") {
      return this.jobDocketPayload(payload, description);
    }

    if (payload.type === "TASK") {
      return this.taskDocketPayload(payload, description);
    }

    if (payload.type === "EPIC") {
      return this.epicDocketPayload(payload, description);
    }

    return {
      ...payload,
      type: payload.type,
      title: payload.title,
      descr: description,
      projectId: payload.projectId || "",
      sprintId: payload.sprintId || "",
      parentId: payload.parentId || "",
      epicId: payload.epicId || "",
      storyId: payload.storyId || "",
      dktStateId: payload.dktStateId || "",
      category: payload.category || "",
      priority: payload.priority || "",
      assigneeId: payload.assigneeId || "",
      storyPointEst,
    };
  }

  private storyDocketPayload(
    payload: CreateDocketPayload,
    description: unknown,
    storyPointEst: unknown
  ) {
    return {
      id: "",
      num: "",
      ...payload,
      type: "STORY",
      title: payload.title,
      descr: String(description || ""),
      projectId: payload.projectId || "",
      projectName: payload.projectName || "",
      epicId: payload.epicId || payload.parentId || "",
      storyId: "",
      sprintId: payload.sprintId || "",
      sprintName: payload.sprintName || payload.sprint || "",
      assigneeId: payload.assigneeId || "",
      dktStateId: payload.dktStateId || "",
      category: upperLookup(payload.category, "ENHANCEMENT"),
      priority: upperLookup(payload.priority, "MINOR"),
      storyPointEst: Number(storyPointEst) || 0,
      hasNoSprint: payload.hasNoSprint ?? false,
      imgAttachmentDtoSet: Array.isArray(payload.imgAttachmentDtoSet)
        ? payload.imgAttachmentDtoSet
        : [],
      videoAttachmentDtoSet: Array.isArray(payload.videoAttachmentDtoSet)
        ? payload.videoAttachmentDtoSet
        : [],
      parentId: payload.parentId || payload.epicId || "",
      sprint: payload.sprint || payload.sprintName || "",
      storyPoints: payload.storyPoints ?? storyPointEst,
      description: payload.description ?? description,
      comments: payload.comments ?? null,
      worklogs: payload.worklogs ?? null,
      employeeIdSet: payload.employeeIdSet ?? null,
      docketIdSet: payload.docketIdSet ?? null,
      sprintIdSet: payload.sprintIdSet ?? null,
      startWorklogDate: payload.startWorklogDate ?? null,
      endWorklogDate: payload.endWorklogDate ?? null,
      imgAttachmentSet: payload.imgAttachmentSet ?? null,
      designation: payload.designation ?? null,
      docketNum: payload.docketNum ?? null,
      empId: payload.empId ?? null,
      profilePic: payload.profilePic ?? null,
      videoAttachmentSet: payload.videoAttachmentSet ?? null,
      docketType: payload.docketType ?? null,
      captchaText: payload.captchaText ?? null,
      randomNumber: payload.randomNumber ?? null,
      updateComment: payload.updateComment ?? null,
      removeComment: payload.removeComment ?? null,
      objState: payload.objState ?? null,
      objStateSet: payload.objStateSet ?? null,
      createdUserId: payload.createdUserId ?? null,
      createdUserName: payload.createdUserName ?? null,
      createdTime: payload.createdTime ?? null,
      updateUserId: payload.updateUserId ?? null,
      updatedUserName: payload.updatedUserName ?? null,
      updatedTime: payload.updatedTime ?? null,
      pagesize: payload.pagesize ?? null,
      currentPage: payload.currentPage ?? null,
      totalPage: payload.totalPage ?? null,
      startItem: payload.startItem ?? null,
      endItem: payload.endItem ?? null,
      totalItem: payload.totalItem ?? null,
    };
  }

  private jobDocketPayload(payload: CreateDocketPayload, description: unknown) {
    const sprintId = String(payload.sprintId || "").startsWith("virtual-orphan-sprint")
      ? ""
      : String(payload.sprintId || "");

    return {
      id: "",
      num: "",
      projectId: payload.projectId || "",
      projectName: payload.projectName || "",
      assigneeId: payload.assigneeId || "",
      assigneeImage: null,
      assigneeName: null,
      captchaText: null,
      category: upperLookup(payload.category, "ENHANCEMENT"),
      categorySet: null,
      check: null,
      createdTime: null,
      createdUserId: null,
      createdUserName: null,
      currentPage: null,
      descr: String(description || ""),
      dktEndDate: null,
      dktStartDate: null,
      dktStateCategory: null,
      dktStateId: payload.dktStateId || "",
      dktStateName: payload.dktStateName || "",
      endItem: null,
      epicId: "",
      epicName: "",
      epicNum: null,
      hasNoSprint: payload.hasNoSprint ?? false,
      imgAttachmentDtoSet: Array.isArray(payload.imgAttachmentDtoSet)
        ? payload.imgAttachmentDtoSet
        : [],
      milestoneId: null,
      milestoneName: null,
      objState: null,
      objStateSet: null,
      pagesize: null,
      priority: upperLookup(payload.priority, "MINOR"),
      prioritySet: null,
      randomNumber: null,
      removeComment: null,
      reporterId: payload.reporterId || "",
      reporterName: null,
      reviewerComment: null,
      reviewerRating: null,
      secndAssigneeName: null,
      secondaryAssigneeId: null,
      sprintId: sprintId || null,
      sprintName: sprintId ? payload.sprintName || payload.sprint || "" : "Select Sprint",
      startItem: null,
      storyId: payload.storyId || payload.parentId || "",
      storyName: null,
      storyNum: null,
      storyPointEst: null,
      tags: null,
      title: payload.title,
      totalItem: null,
      totalPage: null,
      type: "JOB",
      typeSet: null,
      updateComment: null,
      updateUserId: null,
      updatedTime: null,
      updatedUserName: null,
      videoAttachmentDtoSet: Array.isArray(payload.videoAttachmentDtoSet)
        ? payload.videoAttachmentDtoSet
        : [],
    };
  }

  private taskDocketPayload(payload: CreateDocketPayload, description: unknown) {
    const sprintId = String(payload.sprintId || "").startsWith("virtual-orphan-sprint")
      ? ""
      : String(payload.sprintId || "");

    return {
      id: "",
      num: "",
      projectId: payload.projectId || "",
      projectName: payload.projectName || "",
      assigneeId: payload.assigneeId || "",
      assigneeImage: null,
      assigneeName: null,
      captchaText: null,
      category: upperLookup(payload.category, "ENHANCEMENT"),
      categorySet: null,
      check: null,
      createdTime: null,
      createdUserId: null,
      createdUserName: null,
      currentPage: null,
      descr: String(description || ""),
      dktEndDate: null,
      dktStartDate: null,
      dktStateCategory: null,
      dktStateId: payload.dktStateId || "",
      dktStateName: payload.dktStateName || "",
      endItem: null,
      epicId: payload.epicId || payload.parentId || "",
      epicName: "",
      epicNum: null,
      hasNoSprint: payload.hasNoSprint ?? false,
      imgAttachmentDtoSet: Array.isArray(payload.imgAttachmentDtoSet)
        ? payload.imgAttachmentDtoSet
        : [],
      milestoneId: null,
      milestoneName: null,
      objState: null,
      objStateSet: null,
      pagesize: null,
      priority: upperLookup(payload.priority, "MINOR"),
      prioritySet: null,
      randomNumber: null,
      removeComment: null,
      reporterId: payload.reporterId || "",
      reporterName: null,
      reviewerComment: null,
      reviewerRating: null,
      secndAssigneeName: null,
      secondaryAssigneeId: null,
      sprintId: sprintId || null,
      sprintName: sprintId ? payload.sprintName || payload.sprint || "" : "Select Sprint",
      startItem: null,
      storyId: "",
      storyName: null,
      storyNum: null,
      storyPointEst: null,
      tags: null,
      title: payload.title,
      totalItem: null,
      totalPage: null,
      type: "TASK",
      typeSet: null,
      updateComment: null,
      updateUserId: null,
      updatedTime: null,
      updatedUserName: null,
      videoAttachmentDtoSet: Array.isArray(payload.videoAttachmentDtoSet)
        ? payload.videoAttachmentDtoSet
        : [],
    };
  }

  private epicDocketPayload(payload: CreateDocketPayload, description: unknown) {
    const sprintId = String(payload.sprintId || "").startsWith("virtual-orphan-sprint")
      ? ""
      : String(payload.sprintId || "");

    return {
      id: "",
      num: "",
      projectId: payload.projectId || "",
      projectName: payload.projectName || "",
      assigneeId: payload.assigneeId || "",
      assigneeImage: null,
      assigneeName: null,
      captchaText: null,
      category: upperLookup(payload.category, "ENHANCEMENT"),
      categorySet: null,
      check: null,
      createdTime: null,
      createdUserId: null,
      createdUserName: null,
      currentPage: null,
      descr: String(description || ""),
      dktEndDate: null,
      dktStartDate: null,
      dktStateCategory: null,
      dktStateId: payload.dktStateId || "",
      dktStateName: payload.dktStateName || "",
      endItem: null,
      epicId: "",
      epicName: "",
      epicNum: null,
      hasNoSprint: payload.hasNoSprint ?? false,
      imgAttachmentDtoSet: Array.isArray(payload.imgAttachmentDtoSet)
        ? payload.imgAttachmentDtoSet
        : [],
      milestoneId: null,
      milestoneName: null,
      objState: null,
      objStateSet: null,
      pagesize: null,
      priority: upperLookup(payload.priority, "MINOR"),
      prioritySet: null,
      randomNumber: null,
      removeComment: null,
      reporterId: payload.reporterId || "",
      reporterName: null,
      reviewerComment: null,
      reviewerRating: null,
      secndAssigneeName: null,
      secondaryAssigneeId: null,
      sprintId: sprintId || null,
      sprintName: sprintId ? payload.sprintName || payload.sprint || "" : "Select Sprint",
      startItem: null,
      storyId: "",
      storyName: null,
      storyNum: null,
      storyPointEst: null,
      tags: null,
      title: payload.title,
      totalItem: null,
      totalPage: null,
      type: "EPIC",
      typeSet: null,
      updateComment: null,
      updateUserId: null,
      updatedTime: null,
      updatedUserName: null,
      videoAttachmentDtoSet: Array.isArray(payload.videoAttachmentDtoSet)
        ? payload.videoAttachmentDtoSet
        : [],
    };
  }

  private async updateDocketField(
    docketId: string,
    path: string,
    fields: Record<string, unknown>
  ): Promise<Docket> {
    await this.request({
      method: "PUT",
      path,
      body: {
        id: docketId,
        ...fields,
      },
    });

    return this.getDocket(docketId);
  }

  private async mutateDocketUpdateField(
    docketId: string,
    field: string,
    path: string,
    fields: Record<string, unknown>
  ) {
    const body = nativeDocketUpdatePayload(docketId, fields);

    try {
      const response = await this.request({
        method: "PUT",
        path,
        referrerPath: DOCKET_REFERRER_PATH,
        retryOnUnauthorized: false,
        body,
      });
      const responseEmpty =
        response.payload === null ||
        response.payload === undefined ||
        response.payload === "";

      console.info("[EliticalClient] docket update mutation accepted", {
        canonicalDocketId: docketId,
        requestedUpdateField: field,
        endpoint: response.endpoint,
        method: "PUT",
        httpStatus: response.status,
        requestedReferer: DOCKET_REFERRER_PATH,
        responseEmpty,
        mutationAccepted: true,
        outgoingDtoFieldNames: Object.keys(body),
        finalCanonicalDocketId: docketId,
        finalTitle: field === "title" ? String(fields.title || "") : "",
        finalDescription: field === "description" ? String(fields.descr || "") : "",
      });

      return {
        field,
        endpoint: response.endpoint,
        method: "PUT",
        status: response.status,
        requestedReferer: DOCKET_REFERRER_PATH,
        accepted: true,
        responseEmpty,
      };
    } catch (error) {
      const status =
        error instanceof EliticalClientError && error.status
          ? error.status
          : undefined;
      const endpoint =
        error instanceof EliticalClientError && error.endpoint
          ? error.endpoint
          : path;
      const message = error instanceof Error ? error.message : String(error);

      console.error("[EliticalClient] docket update mutation failed", {
        canonicalDocketId: docketId,
        requestedUpdateField: field,
        endpoint,
        method: "PUT",
        httpStatus: status || 0,
        requestedReferer: DOCKET_REFERRER_PATH,
        mutationAccepted: false,
        message,
      });

      return {
        field,
        endpoint,
        method: "PUT",
        status: status || 0,
        requestedReferer: DOCKET_REFERRER_PATH,
        accepted: false,
        message,
      };
    }
  }

  private worklogMatchesPayload(worklog: Worklog, payload: CreateWorklogPayload) {
    const expected = this.worklogPayload(payload, { create: true });

    return worklogMatchesForReconciliation(worklog, {
      ...expected,
      docketId: payload.docketId,
    });
  }

  private worklogPayload(payload: CreateWorklogPayload, { create = true } = {}) {
    const totalMinutes = minutesFromWorklogPayload(payload);
    const hour = payload.hour !== undefined ? Number(payload.hour) : Math.floor(totalMinutes / 60);
    const min = totalMinutes % 60;
    const nativeDate = eliticalWorklogDateMillis(payload.worklogDate ?? payload.date);
    const resolvedMin = payload.min !== undefined && payload.min !== null ? Number(payload.min) : min;

    if (!create) {
      if (!nativeDate) {
        throw new EliticalClientError(
          "INVALID_RESPONSE",
          "worklogDate is required to update an Elitical worklog."
        );
      }

      if (!Number.isFinite(hour) || !Number.isFinite(resolvedMin) || (hour === 0 && resolvedMin === 0)) {
        throw new EliticalClientError(
          "INVALID_RESPONSE",
          "hour and min are required to update an Elitical worklog."
        );
      }
    }

    return {
      id: create ? "" : payload.id || payload.worklogId || "",
      employeeId: payload.employeeId || "",
      employeeName: payload.employeeName || "",
      docketId: payload.docketId || "",
      docketName: payload.docketName || "",
      docketNum: null,
      docketType: null,
      comment: payload.comment || payload.description || payload.note || "",
      hour: create && hour === 0 ? null : hour,
      min: resolvedMin,
      worklogDate: nativeDate,
      startWorklogDate: "null",
      endWorklogDate: "null",
      gitCommitHash: payload.gitCommitHash || "",
      sprintId: payload.sprintId || "",
      sprintName: payload.sprintName || "",
      captchaText: null,
      createdTime: null,
      createdUserId: null,
      createdUserName: null,
      currentPage: null,
      designation: null,
      docketIdSet: null,
      empId: null,
      employeeIdSet: null,
      endItem: null,
      imgAttachmentDtoSet: [],
      imgAttachmentSet: null,
      objState: null,
      objStateSet: null,
      pagesize: null,
      profilePic: null,
      projectId: null,
      randomNumber: null,
      removeComment: null,
      sprintIdSet: null,
      startItem: null,
      storyPointEst: null,
      totalItem: null,
      totalPage: null,
      updateComment: null,
      updateUserId: null,
      updatedTime: null,
      updatedUserName: null,
      videoAttachmentDtoSet: [],
      videoAttachmentSet: null,
    };
  }

  private async request(request: EliticalAuthenticatedRequest) {
    console.info("[EliticalClient] request()", {
      eliticalClientInstanceId: this.instanceId,
      path: request.path,
      method: request.method || "GET",
    });

    try {
      const response = await this.authService.authenticatedRequest(request);

      validateResponse(response);

      return response;
    } catch (error) {
      console.error("[EliticalClient] request() caught", {
        eliticalClientInstanceId: this.instanceId,
        path: request.path,
        method: request.method || "GET",
        name: error instanceof Error ? error.name : "",
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : "",
      });

      if (error instanceof EliticalClientError) throw error;

      if (error instanceof EliticalAuthError) {
        throw new EliticalClientError(
          "AUTHENTICATION_REQUIRED",
          error.message,
          {
            cause: error,
          }
        );
      }

      throw new EliticalClientError(
        "REQUEST_FAILED",
        error instanceof Error
          ? error.message
          : "Unable to complete Elitical request.",
        {
          cause: error,
        }
      );
    }
  }
}
