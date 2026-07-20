import type { EliticalClient } from "../client/index.js";
import type {
  Docket,
  Issue,
  Project,
  Sprint,
  Worklog,
} from "../models/index.js";
import type {
  AttachmentPayload,
  CreateDocketPayload,
  CreateWorklogPayload,
  EliticalEmployee,
  EliticalLookupValue,
  EliticalUser,
  UpdateDocketPayload,
} from "../types/index.js";
import { normalizeDocketState } from "../../../utils/docketStates.js";

let nextEliticalProviderId = 1;

export interface EliticalProviderProject extends Project {
  id: string;
  name: string;
  eliticalId: string;
}

export interface EliticalProviderSprint extends Sprint {
  id: string;
  name: string;
  eliticalId: string;
}

export interface EliticalProviderWorklog extends Worklog {
  id: string;
  docketId: string;
  date: string;
  description: string;
  timeMinutes: number;
  eliticalId: string;
}

export interface EliticalProviderIssue extends Docket {
  id: string;
  title: string;
  description: string;
  type: string;
  eliticalId: string;
  worklogs: EliticalProviderWorklog[];
}

export interface EliticalProviderUser extends EliticalEmployee {
  id: string;
  name: string;
  eliticalId: string;
}

export interface EliticalProviderLookupValue extends EliticalLookupValue {
  id: string;
  name: string;
}

function firstString(...values: unknown[]): string {
  const match = values.find(
    (value) => value !== undefined && value !== null && String(value).trim()
  );

  return match === undefined ? "" : String(match).trim();
}

function firstNumber(...values: unknown[]): number {
  const match = values.find((value) => Number.isFinite(Number(value)));

  return match === undefined ? 0 : Number(match);
}

function normalizeIssueType(issue: Issue): string {
  const rawType = firstString(
    issue.type,
    issue.docketType,
    issue.dktType,
    issue.docketTypeName,
    issue.dktTypeName,
    issue.issueType,
    issue.workItemType
  ).toLowerCase();

  if (rawType.includes("epic")) return "epic";
  if (rawType.includes("story")) return "story";
  if (rawType.includes("job")) return "job";
  if (rawType.includes("task")) return "task";

  return "job";
}

function projectId(project: Project): string {
  return firstString(project.id, project.projectId, project.cx);
}

function sprintId(sprint: Sprint): string {
  return firstString(sprint.id, sprint.sprintId, sprint.cx);
}

function issueId(issue: Issue): string {
  return firstString(issue.id, issue.docketId, issue.dktId, issue.cx);
}

function worklogId(worklog: Worklog): string {
  return firstString(worklog.id, worklog.worklogId, worklog.cx);
}

function worklogDocketId(worklog: Worklog): string {
  return firstString(worklog.docketId, worklog.docket?.id);
}

function worklogEmployeeId(worklog: Worklog): string {
  return firstString(worklog.employeeId, worklog.empId, worklog.employee?.id, worklog.employee?.employeeId);
}

function worklogProjectId(worklog: Worklog): string {
  return firstString(worklog.projectId, worklog.project?.id);
}

function worklogMinutes(worklog: Worklog): number {
  const explicitMinutes = firstNumber(
    worklog.timeMinutes,
    worklog.durationMinutes,
    worklog.loggedMinutes
  );

  if (explicitMinutes > 0) return Math.round(explicitMinutes);

  const minutes = firstNumber(worklog.min, worklog.minutes);
  const hours = firstNumber(worklog.hour, worklog.hours, worklog.loggedHours, worklog.duration);

  return Math.round(hours * 60) + minutes;
}

function lookupId(value: EliticalLookupValue): string {
  return firstString(value.id, value.code, value.name, value.title);
}

function lookupName(value: EliticalLookupValue): string {
  return firstString(value.name, value.title, value.code, value.id);
}

function userId(user: EliticalEmployee): string {
  return firstString(user.id, user.employeeId);
}

function userName(user: EliticalEmployee): string {
  return firstString(user.name, user.employeeName, user.userName, user.displayName, user.fullName, userId(user));
}

export class EliticalProvider {
  private client: EliticalClient;
  private readonly instanceId = nextEliticalProviderId++;

  constructor(client: EliticalClient) {
    this.client = client;
    console.info("[EliticalProvider] constructed", {
      eliticalProviderInstanceId: this.instanceId,
    });
  }

  async login(): Promise<unknown> {
    return this.client.login();
  }

  async logout(): Promise<void> {
    return this.client.logout();
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  async currentUser(): Promise<EliticalUser> {
    return this.client.currentUser();
  }

  async getProjects(): Promise<EliticalProviderProject[]> {
    console.info("[EliticalProvider] getProjects() called", {
      eliticalProviderInstanceId: this.instanceId,
    });

    const projects = await this.client.getProjects();

    return projects.map((project) => {
      const id = projectId(project);

      return {
        ...project,
        id,
        eliticalId: id,
        name: firstString(project.name, project.projectName, project.title, id),
      };
    });
  }

  async getSprints(projectId: string): Promise<EliticalProviderSprint[]> {
    console.info("[EliticalProvider] getSprints() called", {
      eliticalProviderInstanceId: this.instanceId,
      projectId,
    });

    const sprints = await this.client.getSprints(projectId);

    return sprints.map((sprint) => {
      const id = sprintId(sprint);

      return {
        ...sprint,
        id,
        eliticalId: id,
        name: firstString(sprint.name, sprint.sprintName, sprint.title, id),
      };
    });
  }

  async getUsers(projectId: string): Promise<EliticalProviderUser[]> {
    console.info("[EliticalProvider] getUsers() called", {
      eliticalProviderInstanceId: this.instanceId,
      projectId,
    });

    const users = await this.client.getUsers(projectId);

    return users.map((user) => {
      const id = userId(user);

      return {
        ...user,
        id,
        eliticalId: id,
        name: userName(user),
      };
    });
  }

  async getStates(projectId: string): Promise<EliticalProviderLookupValue[]> {
    return this.normalizeLookupValues(await this.client.getStates(projectId));
  }

  async getPriorities(): Promise<EliticalProviderLookupValue[]> {
    return this.normalizeLookupValues(await this.client.getPriorities());
  }

  async getCategories(): Promise<EliticalProviderLookupValue[]> {
    return this.normalizeLookupValues(await this.client.getCategories());
  }

  async getDockets(projectId: string): Promise<EliticalProviderIssue[]> {
    return this.getIssues(projectId);
  }

  async getIssues(
    projectId: string,
    options: {
      onProgress?: (progress: {
        current: number;
        total: number;
        unit: string;
      }) => void;
    } = {}
  ): Promise<EliticalProviderIssue[]> {
    console.info("[EliticalProvider] getIssues() called", {
      eliticalProviderInstanceId: this.instanceId,
      projectId,
    });

    const issues = await this.client.getIssues(projectId, options);

    return issues.map((issue) => this.toIssue(issue));
  }

  async getDocket(docketId: string): Promise<EliticalProviderIssue> {
    console.info("[EliticalProvider] getDocket() called", {
      eliticalProviderInstanceId: this.instanceId,
      docketId,
    });

    const docket = await this.client.getDocket(docketId);

    return this.toIssue(docket);
  }

  async getWorklogs(docketId: string): Promise<EliticalProviderWorklog[]> {
    console.info("[EliticalProvider] getWorklogs() called", {
      eliticalProviderInstanceId: this.instanceId,
      docketId,
    });

    const worklogs = await this.client.getWorklogs(docketId);

    return worklogs.map((worklog) => this.toWorklog(worklog, docketId));
  }

  async createEpic(payload: Omit<CreateDocketPayload, "type">): Promise<EliticalProviderIssue> {
    return this.toIssue(await this.client.createEpic(payload));
  }

  async createStory(payload: Omit<CreateDocketPayload, "type">): Promise<EliticalProviderIssue> {
    return this.toIssue(await this.client.createStory(payload));
  }

  async createTask(payload: Omit<CreateDocketPayload, "type">): Promise<EliticalProviderIssue> {
    return this.toIssue(await this.client.createTask(payload));
  }

  async createJob(payload: Omit<CreateDocketPayload, "type">): Promise<EliticalProviderIssue> {
    return this.toIssue(await this.client.createJob(payload));
  }

  async updateDocket(docketId: string, updates: UpdateDocketPayload): Promise<EliticalProviderIssue> {
    return this.toIssue(await this.client.updateDocket(docketId, updates));
  }

  async updateTitle(docketId: string, title: string): Promise<EliticalProviderIssue> {
    return this.toIssue(await this.client.updateTitle(docketId, title));
  }

  async updateDescription(docketId: string, description: string): Promise<EliticalProviderIssue> {
    return this.toIssue(await this.client.updateDescription(docketId, description));
  }

  async updateState(docketId: string, stateId: string): Promise<EliticalProviderIssue> {
    return this.toIssue(await this.client.updateState(docketId, stateId));
  }

  async updateStoryPoints(docketId: string, storyPoints: number): Promise<EliticalProviderIssue> {
    return this.toIssue(await this.client.updateStoryPoints(docketId, storyPoints));
  }

  async updatePriority(docketId: string, priority: string): Promise<EliticalProviderIssue> {
    return this.toIssue(await this.client.updatePriority(docketId, priority));
  }

  async updateCategory(docketId: string, category: string): Promise<EliticalProviderIssue> {
    return this.toIssue(await this.client.updateCategory(docketId, category));
  }

  async updateAssignee(docketId: string, assigneeId: string): Promise<EliticalProviderIssue> {
    return this.toIssue(await this.client.updateAssignee(docketId, assigneeId));
  }

  async updateParent(docketId: string, parentId: string): Promise<EliticalProviderIssue> {
    return this.toIssue(await this.client.updateParent(docketId, parentId));
  }

  async updateSprint(docketId: string, sprintId: string): Promise<EliticalProviderIssue> {
    return this.toIssue(await this.client.updateSprint(docketId, sprintId));
  }

  async createWorklog(payload: CreateWorklogPayload): Promise<EliticalProviderWorklog> {
    return this.toWorklog(
      await this.client.createWorklog(payload),
      String(payload.docketId || "")
    );
  }

  async updateWorklog(payload: CreateWorklogPayload): Promise<EliticalProviderWorklog> {
    return this.toWorklog(
      await this.client.updateWorklog(payload),
      String(payload.docketId || "")
    );
  }

  async uploadAttachment(payload: AttachmentPayload): Promise<unknown> {
    return this.client.uploadAttachment(payload);
  }

  async deleteAttachment(attachmentId: string): Promise<void> {
    return this.client.deleteAttachment(attachmentId);
  }

  private normalizeLookupValues(values: EliticalLookupValue[]): EliticalProviderLookupValue[] {
    return values.map((value) => ({
      ...value,
      id: lookupId(value),
      name: lookupName(value),
    }));
  }

  private toIssue(issue: Docket | Issue): EliticalProviderIssue {
    const id = issueId(issue);
    const type = normalizeIssueType(issue);
    const record = issue as Record<string, unknown>;
    const docketState = normalizeDocketState(
      firstString(issue.docketState, issue.dktState, issue.status, record.dktStateName, "concept")
    );

    return {
      ...issue,
      id,
      eliticalId: id,
      title: firstString(issue.title, issue.name, issue.docketTitle, id),
      description: firstString(issue.description, issue.descr),
      type,
      parentId: firstString(issue.parentId, issue.parentDocketId),
      category: firstString(issue.category, "feature"),
      priority: firstString(issue.priority, "info"),
      docketState,
      status: docketState,
      sprint: firstString("sprint" in issue ? issue.sprint : "", issue.sprintName, issue.sprintId),
      storyPoints: firstNumber(issue.storyPoints, issue.estimatedStoryPoints),
      updatedAt: firstString(issue.updatedAt, issue.updatedTime),
      worklogs: Array.isArray((issue as Docket).worklogs)
        ? (issue as Docket).worklogs!.map((worklog) => this.toWorklog(worklog, id))
        : [],
    };
  }

  private toWorklog(worklog: Worklog, fallbackDocketId: string): EliticalProviderWorklog {
    const id = worklogId(worklog);
    const docketId = worklogDocketId(worklog) || fallbackDocketId;
    const timeMinutes = worklogMinutes(worklog);
    const hour = timeMinutes > 0 && firstNumber(worklog.hour, worklog.hours, worklog.loggedHours, worklog.duration) === 0
      ? Math.floor(timeMinutes / 60)
      : firstNumber(worklog.hour, worklog.hours, worklog.loggedHours, worklog.duration);
    const min = timeMinutes > 0 && firstNumber(worklog.min, worklog.minutes) === 0
      ? timeMinutes % 60
      : firstNumber(worklog.min, worklog.minutes);

    return {
      ...worklog,
      id,
      eliticalId: id,
      docketId,
      employeeId: worklogEmployeeId(worklog),
      projectId: worklogProjectId(worklog),
      date: firstString(worklog.worklogDate, worklog.date, worklog.createdDate),
      description: firstString(worklog.description, worklog.comment, worklog.note),
      hour,
      min,
      timeMinutes,
      durationMinutes: timeMinutes,
    };
  }
}
