import type {
  Docket,
  Issue,
  Project,
  Sprint,
  Worklog,
} from "../models";
import type { EliticalUser } from "./session";

export interface CreateWorklogPayload {
  docketId?: string;
  worklogDate?: string;
  date?: string;
  minutes?: number;
  loggedMinutes?: number;
  hours?: number;
  loggedHours?: number;
  duration?: number;
  comment?: string;
  note?: string;
  description?: string;
}

export interface EliticalAuthenticatedRequest {
  method?: "GET" | "POST";
  path: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  referrerPath?: string;
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
  getCurrentUser(): Promise<EliticalUser>;
  getProjects(): Promise<Project[]>;
  getSprints(projectId: string): Promise<Sprint[]>;
  getIssues(projectId: string): Promise<Issue[]>;
  getDocket(docketId: string): Promise<Docket>;
  getWorklogs(docketId: string): Promise<Worklog[]>;
  createWorklog(payload: CreateWorklogPayload): Promise<Worklog>;
}
