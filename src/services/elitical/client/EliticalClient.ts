import { EliticalAuthError, EliticalAuthService } from "../auth/index";
import type {
  CreateWorklogPayload,
  EliticalAuthenticatedRequest,
  EliticalAuthenticatedResponse,
  EliticalClientContract,
  EliticalUser,
} from "../types";
import type {
  Docket,
  Issue,
  Project,
  Sprint,
  Worklog,
} from "../models";
import { EliticalClientError } from "./EliticalClientError";

let nextEliticalClientId = 1;

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

function validateResponse(response: EliticalAuthenticatedResponse) {
  if (!response.ok) {
    console.error("[EliticalClient] validateResponse() throwing", {
      endpoint: response.endpoint,
      status: response.status,
      statusText: response.statusText,
      callStack: new Error().stack,
    });

    throw new EliticalClientError(
      response.status === 401 || response.status === 403
        ? "AUTHENTICATION_REQUIRED"
        : "REQUEST_FAILED",
      `Elitical request failed (${response.status}).`,
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

  async createWorklog(_payload: CreateWorklogPayload): Promise<Worklog> {
    throw new EliticalClientError(
      "UNIMPLEMENTED",
      "Elitical worklog creation is not implemented."
    );
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
        "Unable to complete Elitical request.",
        {
          cause: error,
        }
      );
    }
  }
}
