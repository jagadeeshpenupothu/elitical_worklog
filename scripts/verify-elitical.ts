import { EliticalAuthService } from "../src/services/elitical/auth/index";
import { EliticalClient } from "../src/services/elitical/client/index";
import type { Issue, Project } from "../src/services/elitical/models/index";

function entityId(entity: Pick<Project, "id" | "projectId" | "cx">): string {
  return String(entity.id || entity.projectId || entity.cx || "");
}

function issueId(issue: Pick<Issue, "id" | "docketId" | "dktId" | "cx">): string {
  return String(issue.id || issue.docketId || issue.dktId || issue.cx || "");
}

async function main() {
  const baseUrl = process.env.ELITICAL_BASE_URL || "";
  const dataDir = process.env.ELITICAL_DATA_DIR || "";

  console.log("Base URL:", baseUrl || "(not configured)");
  console.log("Data Directory:", dataDir || "(default)");

  const authService = new EliticalAuthService({
    baseUrl,
    dataDir: dataDir || undefined,
  });

  await authService.initialize();

  const session = await authService.restoreSession();

  if (!session) {
    await authService.login();
  }

  const client = new EliticalClient(authService);
  const currentUser = await client.getCurrentUser();
  const projects = await client.getProjects();
  const firstProject = projects[0];
  const projectId = firstProject ? entityId(firstProject) : "";

  if (!projectId) {
    throw new Error("No Elitical project was available for the authenticated user.");
  }

  const sprints = await client.getSprints(projectId);
  const issues = await client.getIssues(projectId);
  const firstIssue = issues[0];
  const firstIssueId = firstIssue ? issueId(firstIssue) : "";
  let docketLoaded = false;
  let worklogsCount = 0;

  if (firstIssueId) {
    await client.getDocket(firstIssueId);
    docketLoaded = true;
    worklogsCount = (await client.getWorklogs(firstIssueId)).length;
  }

  console.log("✔ Current User", currentUser.id || currentUser.employeeId || currentUser.empId || "loaded");
  console.log("✔ Project Count", projects.length);
  console.log("✔ Sprint Count", sprints.length);
  console.log("✔ Issue Count", issues.length);
  console.log("✔ Docket Loaded", docketLoaded ? "yes" : "skipped");
  console.log("✔ Worklog Count", worklogsCount);
  console.log("Production Elitical client verified.");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
