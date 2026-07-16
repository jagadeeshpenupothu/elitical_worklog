import { eliticalApiClient, endpoints } from "./api.js";

export function getProjects(client = eliticalApiClient) {
  return client.get(endpoints.projects());
}

export function getDocket(id, client = eliticalApiClient) {
  return client.get(endpoints.docket(id));
}

export function getChildDockets(id, client = eliticalApiClient) {
  return client.get(endpoints.childDockets(id));
}

export function updateDocketState(id, state, client = eliticalApiClient) {
  return client.put(endpoints.docketState(id), {
    state,
  });
}

export function updateDocket(id, updates, client = eliticalApiClient) {
  return client.put(endpoints.docket(id), updates);
}
