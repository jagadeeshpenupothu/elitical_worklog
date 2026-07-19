import type {
  Docket,
  Issue,
  Project,
  Sprint,
  Worklog,
} from "../models/index.js";
import type { EliticalUser } from "./session.js";

export type EliticalRequestMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type EliticalDocketType = "EPIC" | "STORY" | "TASK" | "JOB";

export interface EliticalLookupValue {
  id?: string;
  code?: string;
  name?: string;
  title?: string;
  category?: string;
  [key: string]: unknown;
}

export interface EliticalEmployee {
  id?: string;
  employeeId?: string;
  name?: string;
  userId?: string;
  email?: string;
  [key: string]: unknown;
}

export interface CreateDocketPayload {
  projectId?: string;
  sprintId?: string;
  parentId?: string;
  epicId?: string;
  storyId?: string;
  type: EliticalDocketType;
  title: string;
  description?: string;
  descr?: string;
  dktStateId?: string;
  docketState?: string;
  priority?: string;
  category?: string;
  assigneeId?: string;
  storyPointEst?: number;
  storyPoints?: number;
  [key: string]: unknown;
}

export interface UpdateDocketPayload {
  id?: string;
  title?: string;
  description?: string;
  descr?: string;
  dktStateId?: string;
  docketState?: string;
  priority?: string;
  category?: string;
  assigneeId?: string;
  parentId?: string;
  epicId?: string;
  storyId?: string;
  sprintId?: string;
  storyPointEst?: number;
  storyPoints?: number;
  [key: string]: unknown;
}

export interface CreateWorklogPayload {
  docketId?: string;
  docketName?: string;
  sprintId?: string;
  sprintName?: string;
  worklogDate?: string;
  date?: string;
  minutes?: number;
  timeMinutes?: number;
  durationMinutes?: number;
  loggedMinutes?: number;
  hours?: number;
  hour?: number;
  min?: number | null;
  loggedHours?: number;
  duration?: number;
  comment?: string;
  note?: string;
  description?: string;
  gitCommitHash?: string;
  [key: string]: unknown;
}

export interface AttachmentPayload {
  docketId?: string;
  worklogId?: string;
  fileName?: string;
  contentType?: string;
  data?: unknown;
  file?: unknown;
  [key: string]: unknown;
}

export interface EliticalAuthenticatedRequest {
  method?: EliticalRequestMethod;
  path: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  referrerPath?: string;
  retryOnUnauthorized?: boolean;
  timeoutMs?: number;
}

export interface EliticalAuthenticatedResponse {
  endpoint: string;
  ok: boolean;
  status: number;
  statusText: string;
  payload: unknown;
}

export interface EliticalClientContract {
  login(): Promise<unknown>;
  logout(): Promise<void>;
  currentUser(): Promise<EliticalUser>;
  getCurrentUser(): Promise<EliticalUser>;
  getProjects(): Promise<Project[]>;
  getSprints(projectId: string): Promise<Sprint[]>;
  getUsers(projectId: string): Promise<EliticalEmployee[]>;
  getStates(projectId: string): Promise<EliticalLookupValue[]>;
  getPriorities(): Promise<EliticalLookupValue[]>;
  getCategories(): Promise<EliticalLookupValue[]>;
  getDockets(projectId: string): Promise<Issue[]>;
  getIssues(projectId: string): Promise<Issue[]>;
  getDocket(docketId: string): Promise<Docket>;
  getWorklogs(docketId: string): Promise<Worklog[]>;
  createEpic(payload: Omit<CreateDocketPayload, "type">): Promise<Docket>;
  createStory(payload: Omit<CreateDocketPayload, "type">): Promise<Docket>;
  createTask(payload: Omit<CreateDocketPayload, "type">): Promise<Docket>;
  createJob(payload: Omit<CreateDocketPayload, "type">): Promise<Docket>;
  updateDocket(docketId: string, updates: UpdateDocketPayload): Promise<Docket>;
  updateTitle(docketId: string, title: string): Promise<Docket>;
  updateDescription(docketId: string, description: string): Promise<Docket>;
  updateState(docketId: string, stateId: string): Promise<Docket>;
  updateStoryPoints(docketId: string, storyPoints: number): Promise<Docket>;
  updatePriority(docketId: string, priority: string): Promise<Docket>;
  updateCategory(docketId: string, category: string): Promise<Docket>;
  updateAssignee(docketId: string, assigneeId: string): Promise<Docket>;
  updateParent(docketId: string, parentId: string): Promise<Docket>;
  updateSprint(docketId: string, sprintId: string): Promise<Docket>;
  createWorklog(payload: CreateWorklogPayload): Promise<Worklog>;
  updateWorklog(payload: CreateWorklogPayload): Promise<Worklog>;
  uploadAttachment(payload: AttachmentPayload): Promise<unknown>;
  deleteAttachment(attachmentId: string): Promise<void>;
}
