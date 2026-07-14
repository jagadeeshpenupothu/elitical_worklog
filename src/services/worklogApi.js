const WORKLOG_ENDPOINT = "/.netlify/functions/worklog";

async function parseJsonResponse(response) {
  let payload;

  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const message =
      payload?.error || payload?.message || `Request failed (${response.status}).`;
    const error = new Error(message);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  if (!payload || typeof payload !== "object") {
    throw new Error("The worklog service returned an invalid response.");
  }

  return payload;
}

export async function loadWorklogSnapshot() {
  const response = await fetch(WORKLOG_ENDPOINT, {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
  });
  const payload = await parseJsonResponse(response);

  if (!payload.snapshot || typeof payload.sha !== "string") {
    throw new Error("The worklog snapshot response is malformed.");
  }

  return {
    snapshot: payload.snapshot,
    baseSha: payload.sha,
  };
}

export async function saveWorklogSnapshot({
  snapshot,
  baseSha,
  commitMessage,
}) {
  const response = await fetch(WORKLOG_ENDPOINT, {
    method: "PUT",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      snapshot,
      baseSha,
      commitMessage,
    }),
  });
  const payload = await parseJsonResponse(response);

  if (!payload.snapshot || typeof payload.sha !== "string") {
    throw new Error("The worklog save response is malformed.");
  }

  return {
    snapshot: payload.snapshot,
    baseSha: payload.sha,
  };
}
