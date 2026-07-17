const PUBLISHED_DATA_ENDPOINT = "/.netlify/functions/data";
const PUBLISHED_WORKLOGS_ENDPOINT = "/.netlify/functions/worklogs";

let publishedWorklogsPromise = null;

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
  };
}

async function parsePublishedWorklogsResponse(response) {
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const error = new Error(
      payload?.message ||
        payload?.error ||
        `Published worklogs request failed (${response.status}).`
    );
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return {
    ...payload,
    worklogs: {
      ...(payload?.worklogs || {}),
      worklogs: Array.isArray(payload?.worklogs?.worklogs)
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

export async function loadPublishedWorklogs() {
  if (!publishedWorklogsPromise) {
    publishedWorklogsPromise = fetch(PUBLISHED_WORKLOGS_ENDPOINT, {
      headers: {
        Accept: "application/json",
      },
    }).then(parsePublishedWorklogsResponse);
  }

  return publishedWorklogsPromise;
}
