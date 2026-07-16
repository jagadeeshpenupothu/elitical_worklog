const LOCAL_BACKEND_ORIGIN =
  import.meta.env.VITE_LOCAL_BACKEND_URL || "http://127.0.0.1:3797";
const CACHE_ENDPOINT = `${LOCAL_BACKEND_ORIGIN}/api/cache`;
const CACHE_EVENTS_ENDPOINT = `${CACHE_ENDPOINT}/events`;
const WORKLOGS_ENDPOINT = `${LOCAL_BACKEND_ORIGIN}/api/worklogs`;

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
    ? `${CACHE_ENDPOINT}?skipBackgroundSync=1`
    : CACHE_ENDPOINT;
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
    },
  });

  return parseCacheResponse(response);
}

export async function loadLocalWorklogsCache() {
  const response = await fetch(WORKLOGS_ENDPOINT, {
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

export function subscribeToLocalCacheEvents({ onUpdated, onFailed } = {}) {
  if (typeof EventSource !== "function") return null;

  const events = new EventSource(CACHE_EVENTS_ENDPOINT);

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

  return events;
}
