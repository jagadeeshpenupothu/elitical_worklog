import { eliticalApiClient, endpoints } from "./api.js";

export function getSprints(projectId, client = eliticalApiClient) {
  return client.get(endpoints.sprints(projectId));
}

export function getSprint(sprintId, client = eliticalApiClient) {
  return client.get(endpoints.sprint(sprintId));
}

export function updateSprint(sprintId, updates, client = eliticalApiClient) {
  return client.put(endpoints.sprint(sprintId), updates);
}
