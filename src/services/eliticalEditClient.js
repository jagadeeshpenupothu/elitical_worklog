import { localBackendOrigin } from "./backendOrigin";

function endpoint(path) {
  return `${localBackendOrigin()}${path}`;
}

async function parseResponse(response, fallbackMessage) {
  let payload;

  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const error = new Error(
      payload?.message || payload?.error || fallbackMessage || `Request failed (${response.status}).`
    );
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}

async function fetchBackend(url, options, fallbackMessage) {
  let response;

  try {
    response = await fetch(url, options);
  } catch (error) {
    throw new Error(
      `Desktop backend request failed for ${url}: ${error?.message || "Unable to connect."}`,
      { cause: error }
    );
  }

  return parseResponse(response, fallbackMessage);
}

export async function loadEliticalLookups(projectId) {
  if (!projectId) {
    return {
      users: [],
      states: [],
      priorities: [],
      categories: [],
      sprints: [],
    };
  }

  return fetchBackend(
    endpoint(`/api/elitical/lookups?projectId=${encodeURIComponent(projectId)}`),
    {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    },
    "Unable to load Elitical lookup values."
  );
}

export async function updateEliticalDocket(docketId, updates) {
  return fetchBackend(
    endpoint(`/api/elitical/dockets/${encodeURIComponent(docketId)}`),
    {
      method: "PUT",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(updates || {}),
    },
    "Unable to update Elitical docket."
  );
}

export async function createEliticalDocket(payload) {
  return fetchBackend(
    endpoint("/api/elitical/dockets"),
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload || {}),
    },
    "Unable to create Elitical docket."
  );
}
