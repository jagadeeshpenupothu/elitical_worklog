import { localBackendOrigin } from "./backendOrigin";

async function parseResponse(response) {
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error || payload.message || "Worklog request failed.");
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

function worklogUrl(docketId, suffix = "") {
  return `${localBackendOrigin()}/api/worklogs/${encodeURIComponent(docketId)}${suffix}`;
}

export async function loadJobWorklogState(docketId) {
  const url = worklogUrl(docketId);

  return parseResponse(await fetchBackend(url));
}

export async function saveJobWorklogDraft(docketId, draft) {
  const url = worklogUrl(docketId, "/draft");

  return parseResponse(
    await fetchBackend(url, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(draft),
    })
  );
}

export async function clearJobWorklogDraft(docketId) {
  const url = worklogUrl(docketId, "/draft");

  return parseResponse(
    await fetchBackend(url, {
      method: "DELETE",
    })
  );
}

export async function submitJobWorklog(docketId, payload) {
  const url = worklogUrl(docketId, "/submit");

  return parseResponse(
    await fetchBackend(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    })
  );
}
