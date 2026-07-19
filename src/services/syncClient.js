import { localBackendOrigin } from "./backendOrigin";

function syncEndpoint() {
  return `${localBackendOrigin()}/api/sync`;
}

function syncEventsEndpoint() {
  return `${syncEndpoint()}/events`;
}

async function parseSyncResponse(response) {
  let payload;

  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const message =
      payload?.message || payload?.error || `Sync failed (${response.status}).`;
    const error = new Error(message);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  if (!payload?.normalized?.appState) {
    throw new Error("The sync response is malformed.");
  }

  return payload;
}

async function fetchBackend(url, options) {
  try {
    return await fetch(url, options);
  } catch (error) {
    throw new Error(
      `Desktop backend request failed for ${url}: ${error?.message || "Unable to connect."}`
    );
  }
}

export async function syncProviderData({ provider = "elitical", onProgress } = {}) {
  const events =
    typeof EventSource === "function" && onProgress
      ? new EventSource(syncEventsEndpoint())
      : null;

  events?.addEventListener("message", (event) => {
    try {
      onProgress(JSON.parse(event.data));
    } catch {
      // Ignore malformed progress frames and keep the sync request alive.
    }
  });

  const response = await fetchBackend(syncEndpoint(), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ provider }),
  });

  try {
    return await parseSyncResponse(response);
  } finally {
    events?.close();
  }
}

export async function syncPendingToElitical({ onProgress } = {}) {
  const events =
    typeof EventSource === "function" && onProgress
      ? new EventSource(syncEventsEndpoint())
      : null;

  events?.addEventListener("message", (event) => {
    try {
      onProgress(JSON.parse(event.data));
    } catch {
      // Ignore malformed progress frames and keep the sync request alive.
    }
  });

  const response = await fetchBackend(syncEndpoint(), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      provider: "elitical",
      direction: "to-elitical",
    }),
  });

  try {
    return await parseSyncResponse(response);
  } finally {
    events?.close();
  }
}
