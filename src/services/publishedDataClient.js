const PUBLISHED_DATA_ENDPOINT = "/.netlify/functions/data";

async function parsePublishedDataResponse(response) {
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const error = new Error(
      payload?.message ||
        payload?.error ||
        `Published data request failed (${response.status}).`
    );
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  if (!payload?.normalized?.appState) {
    throw new Error("The published data response is malformed.");
  }

  return {
    ...payload,
    worklogs: {
      ...(payload.worklogs || {}),
      worklogs: Array.isArray(payload.worklogs?.worklogs)
        ? payload.worklogs.worklogs
        : [],
    },
  };
}

export async function loadPublishedData() {
  const response = await fetch(PUBLISHED_DATA_ENDPOINT, {
    headers: {
      Accept: "application/json",
    },
  });

  return parsePublishedDataResponse(response);
}
