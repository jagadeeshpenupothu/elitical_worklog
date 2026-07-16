const LOCAL_BACKEND_ORIGIN =
  import.meta.env.VITE_LOCAL_BACKEND_URL || "http://127.0.0.1:3797";
const ELITICAL_LIVE_SYNC_ENDPOINT = `${LOCAL_BACKEND_ORIGIN}/api/elitical/sync-live`;
const ELITICAL_LIVE_SYNC_EVENTS_ENDPOINT = `${ELITICAL_LIVE_SYNC_ENDPOINT}/events`;

async function parseLiveSyncResponse(response) {
  let payload;

  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const message =
      payload?.message || payload?.error || `Elitical sync failed (${response.status}).`;
    const error = new Error(message);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  if (!payload?.normalized?.appState) {
    throw new Error("The Elitical sync response is malformed.");
  }

  return payload;
}

export async function syncLiveEliticalData({ onProgress } = {}) {
  const events =
    typeof EventSource === "function" && onProgress
      ? new EventSource(ELITICAL_LIVE_SYNC_EVENTS_ENDPOINT)
      : null;

  events?.addEventListener("message", (event) => {
    try {
      onProgress(JSON.parse(event.data));
    } catch {
      // Ignore malformed progress frames and keep the sync request alive.
    }
  });

  const response = await fetch(ELITICAL_LIVE_SYNC_ENDPOINT, {
    method: "POST",
    headers: {
      Accept: "application/json",
    },
  });

  try {
    return await parseLiveSyncResponse(response);
  } finally {
    events?.close();
  }
}
