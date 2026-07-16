import { eliticalApiClient, endpoints } from "./api.js";

export function getWorklogs(docketId, client = eliticalApiClient) {
  return client.get(endpoints.worklogs(docketId));
}

export function createWorklog(docketId, worklog, client = eliticalApiClient) {
  return client.post(endpoints.worklogs(docketId), worklog);
}

export function updateWorklog(worklogId, updates, client = eliticalApiClient) {
  return client.put(endpoints.worklog(worklogId), updates);
}

export function deleteWorklog(worklogId, client = eliticalApiClient) {
  return client.delete(endpoints.worklog(worklogId));
}
