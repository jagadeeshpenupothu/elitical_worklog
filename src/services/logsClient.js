import { localBackendOrigin } from "./backendOrigin";

const MAX_LOG_LIMIT = 1000;

function logsEndpoint({ sinceId = 0, limit = MAX_LOG_LIMIT } = {}) {
  const params = new URLSearchParams();

  if (sinceId) params.set("sinceId", String(sinceId));
  params.set("limit", String(limit));

  return `${localBackendOrigin()}/api/logs?${params.toString()}`;
}

export async function loadApplicationLogs({ sinceId = 0, limit = MAX_LOG_LIMIT } = {}) {
  const response = await fetch(logsEndpoint({ sinceId, limit }), {
    headers: {
      Accept: "application/json",
    },
  });
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(payload?.message || payload?.error || "Unable to load application logs.");
  }

  return {
    entries: Array.isArray(payload?.entries) ? payload.entries : [],
    latestId: Number(payload?.latestId || 0),
    limit: Number(payload?.limit || limit),
  };
}
