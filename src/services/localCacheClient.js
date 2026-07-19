import { localBackendOrigin } from "./backendOrigin";

function cacheEndpoint() {
  return `${localBackendOrigin()}/api/cache`;
}

function cacheEventsEndpoint() {
  return `${cacheEndpoint()}/events`;
}

function worklogsEndpoint() {
  return `${localBackendOrigin()}/api/worklogs`;
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

async function parseCacheResponse(response) {
  let payload = null;

  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const error = new Error(
      payload?.message || payload?.error || `Cache request failed (${response.status}).`
    );
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  if (!payload?.normalized?.appState) {
    throw new Error("The local cache response is malformed.");
  }

  return payload;
}

export async function loadLocalGraphCache({ skipBackgroundSync = false } = {}) {
  const url = skipBackgroundSync
    ? `${cacheEndpoint()}?skipBackgroundSync=1`
    : cacheEndpoint();
  const response = await fetchBackend(url, {
    headers: {
      Accept: "application/json",
    },
  });

  return parseCacheResponse(response);
}

export async function loadLocalWorklogsCache() {
  const response = await fetchBackend(worklogsEndpoint(), {
    headers: {
      Accept: "application/json",
    },
  });
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(payload?.message || payload?.error || "Unable to load worklogs.");
  }

  return {
    ...payload,
    worklogs: Array.isArray(payload?.worklogs) ? payload.worklogs : [],
  };
}

export function subscribeToLocalCacheEvents({
  onUpdated,
  onFailed,
  onWarning,
  onSyncStarted,
  onSyncFinished,
} = {}) {
  if (typeof EventSource !== "function") return null;

  const events = new EventSource(cacheEventsEndpoint());

  events.addEventListener("sync-started", (event) => {
    try {
      onSyncStarted?.(JSON.parse(event.data));
    } catch {
      onSyncStarted?.({ message: "Elitical sync started." });
    }
  });

  events.addEventListener("sync-finished", (event) => {
    try {
      onSyncFinished?.(JSON.parse(event.data));
    } catch {
      onSyncFinished?.({ message: "Elitical sync finished." });
    }
  });

  events.addEventListener("cache-updated", (event) => {
    try {
      const payload = JSON.parse(event.data);

      if (payload?.normalized?.appState) onUpdated?.(payload);
    } catch {
      // Ignore malformed cache events.
    }
  });

  events.addEventListener("sync-failed", (event) => {
    try {
      onFailed?.(JSON.parse(event.data));
    } catch {
      onFailed?.({ message: "Background sync failed." });
    }
  });

  events.addEventListener("github-publish-failed", (event) => {
    try {
      onWarning?.(JSON.parse(event.data));
    } catch {
      onWarning?.({ message: "GitHub publish failed." });
    }
  });

  return events;
}
