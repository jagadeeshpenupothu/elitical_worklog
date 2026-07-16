import { eliticalApiClient, endpoints } from "./api.js";

export function getEmployees(projectId, client = eliticalApiClient) {
  return client.get(endpoints.employees(projectId));
}

export function getCurrentEmployee(client = eliticalApiClient) {
  return client.get(endpoints.currentEmployee());
}

export function getAssignedProject(client = eliticalApiClient) {
  return client.get(endpoints.assignedProject());
}

export function getCurrentSprint(client = eliticalApiClient) {
  return client.get(endpoints.currentSprint());
}

export function getAssignedEpics(client = eliticalApiClient) {
  return client.get(endpoints.assignedEpics());
}

export function getAssignedStories(client = eliticalApiClient) {
  return client.get(endpoints.assignedStories());
}

export function getAssignedJobs(client = eliticalApiClient) {
  return client.get(endpoints.assignedJobs());
}

export function getAssignedWorklogs(client = eliticalApiClient) {
  return client.get(endpoints.assignedWorklogs());
}
