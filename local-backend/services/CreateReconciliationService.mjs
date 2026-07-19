function firstString(...values) {
  const match = values.find(
    (value) => value !== undefined && value !== null && String(value).trim()
  );

  return match === undefined ? "" : String(match).trim();
}

function normalizeDocketType(value) {
  const normalized = String(value || "").trim().toLowerCase();

  if (["epic", "story", "task", "job"].includes(normalized)) return normalized;
  if (normalized.includes("epic")) return "epic";
  if (normalized.includes("story")) return "story";
  if (normalized.includes("job")) return "job";
  if (normalized.includes("task")) return "task";

  return "";
}

function normalizeComparable(value) {
  return String(value || "").trim().toLowerCase();
}

export function canonicalSprintIdForPayload(payload) {
  const sprintId = firstString(payload?.sprintId);

  return sprintId.startsWith("virtual-orphan-sprint") ? "" : sprintId;
}

function issueId(issue) {
  return firstString(issue?.id, issue?.eliticalId, issue?.docketId, issue?.dktId, issue?.cx);
}

function issueProjectId(issue) {
  return firstString(issue?.elitical?.projectId, issue?.projectId);
}

function issueSprintId(issue) {
  return firstString(issue?.elitical?.sprintId, issue?.sprintId);
}

function issueParentId(issue) {
  return firstString(issue?.parentId, issue?.parentDocketId);
}

function issueEpicId(issue) {
  return firstString(issue?.elitical?.epicId, issue?.epicId);
}

function issueStoryId(issue) {
  return firstString(issue?.elitical?.storyId, issue?.storyId);
}

function issueAssigneeId(issue) {
  return firstString(issue?.elitical?.assigneeId, issue?.assigneeId);
}

export function candidateItemFromIssue(issue) {
  const id = issueId(issue);

  return {
    ...issue,
    id,
    title: firstString(issue?.title, issue?.name, issue?.docketTitle, id),
    description: firstString(issue?.description, issue?.descr),
    type: normalizeDocketType(issue?.type),
    parentId: issueParentId(issue),
    sprintId: firstString(issue?.sprintId),
    projectId: firstString(issue?.projectId),
    epicId: firstString(issue?.epicId),
    storyId: firstString(issue?.storyId),
    assigneeId: firstString(issue?.assigneeId),
    elitical: {
      ...(issue?.elitical || {}),
      projectId: issueProjectId(issue),
      sprintId: issueSprintId(issue),
      epicId: issueEpicId(issue),
      storyId: issueStoryId(issue),
      assigneeId: issueAssigneeId(issue),
      num: firstString(issue?.elitical?.num, issue?.num),
      remoteId: id,
    },
  };
}

export function createdDocketCandidates(issuesOrGraph, payload, { projectScoped = true } = {}) {
  const type = normalizeDocketType(payload?.type);
  const title = firstString(payload?.title);
  const parentId = firstString(payload?.parentId);
  const projectId = firstString(payload?.projectId);
  const sprintId = canonicalSprintIdForPayload(payload);
  const assigneeId = firstString(payload?.assigneeId);
  const expectedEpicId =
    type === "story" || type === "task"
      ? firstString(payload?.epicId, parentId)
      : firstString(payload?.epicId);
  const expectedStoryId =
    type === "job" ? firstString(payload?.storyId, parentId) : firstString(payload?.storyId);
  const items = Array.isArray(issuesOrGraph)
    ? issuesOrGraph.map(candidateItemFromIssue)
    : issuesOrGraph?.appState?.workItems || [];

  return items
    .filter((item) => normalizeDocketType(item?.type) === type)
    .map((item) => {
      const itemProjectId = issueProjectId(item);
      const itemSprintId = issueSprintId(item);
      const itemAssigneeId = issueAssigneeId(item);
      const itemEpicId = issueEpicId(item);
      const itemStoryId = issueStoryId(item);
      const itemParentId = issueParentId(item);
      const checks = {
        title: normalizeComparable(item?.title) === normalizeComparable(title),
        project: !projectId || !itemProjectId ? Boolean(projectScoped) : itemProjectId === projectId,
        sprint: !sprintId || !itemSprintId ? "unavailable" : itemSprintId === sprintId,
        parent: !parentId || !itemParentId ? "unavailable" : itemParentId === parentId,
        epic: !expectedEpicId || !itemEpicId ? "unavailable" : itemEpicId === expectedEpicId || itemParentId === expectedEpicId,
        story: !expectedStoryId || !itemStoryId ? "unavailable" : itemStoryId === expectedStoryId || itemParentId === expectedStoryId,
        assignee: !assigneeId || !itemAssigneeId ? "unavailable" : itemAssigneeId === assigneeId,
      };
      const required = {
        type: normalizeDocketType(item?.type) === type,
        title: checks.title,
        project: checks.project === true,
      };
      const reliableMatches = ["sprint", "parent", "epic", "story", "assignee"].filter(
        (field) => checks[field] === true
      );
      const reliableMismatches = ["sprint", "parent", "epic", "story"].filter(
        (field) => checks[field] === false
      );
      const score =
        Number(required.type) * 10 +
        Number(required.title) * 10 +
        Number(required.project) * 5 +
        reliableMatches.length;

      return {
        item,
        score,
        checks,
        required,
        reliableMatches,
        reliableMismatches,
        diagnostics: {
          id: item.id,
          num: firstString(item?.elitical?.num, item?.num),
          title: item.title,
          type: item.type,
          parentId: itemParentId,
          epicId: itemEpicId,
          storyId: itemStoryId,
          projectId: itemProjectId,
          sprintId: itemSprintId,
          assigneeId: itemAssigneeId,
          score,
          checks,
        },
      };
    })
    .filter((candidate) => {
      if (!candidate.required.title || !candidate.required.project) return false;
      if (candidate.reliableMismatches.length) return false;

      return true;
    })
    .sort((first, second) => second.score - first.score);
}

export function chooseCreatedDocketCandidate(candidates) {
  const best = candidates[0] || null;

  if (!best) return null;

  const tiedBest = candidates.filter((candidate) => candidate.score === best.score);

  return tiedBest.length === 1 ? best : null;
}
