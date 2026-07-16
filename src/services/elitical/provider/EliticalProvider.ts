import type { EliticalClient } from "../client/index";
import type {
  Docket,
  Issue,
  Project,
  Sprint,
  Worklog,
} from "../models/index";

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
  const minutes = firstNumber(worklog.min, worklog.minutes, worklog.loggedMinutes);
  const hours = firstNumber(worklog.hour, worklog.hours, worklog.loggedHours, worklog.duration);

  return Math.round(hours * 60) + minutes;
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

  async getIssues(projectId: string): Promise<EliticalProviderIssue[]> {
    console.info("[EliticalProvider] getIssues() called", {
      eliticalProviderInstanceId: this.instanceId,
      projectId,
    });

    const issues = await this.client.getIssues(projectId);

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

  private toIssue(issue: Docket | Issue): EliticalProviderIssue {
    const id = issueId(issue);
    const type = normalizeIssueType(issue);

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
      docketState: firstString(issue.docketState, issue.dktState, issue.status, "concept"),
      status: firstString(issue.status, issue.docketState, issue.dktState, "concept"),
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

    return {
      ...worklog,
      id,
      eliticalId: id,
      docketId,
      employeeId: worklogEmployeeId(worklog),
      projectId: worklogProjectId(worklog),
      date: firstString(worklog.worklogDate, worklog.date, worklog.createdDate),
      description: firstString(worklog.description, worklog.comment, worklog.note),
      timeMinutes: worklogMinutes(worklog),
    };
  }
}
