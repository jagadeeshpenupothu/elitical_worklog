const LOCAL_BACKEND_ORIGIN =
  import.meta.env.VITE_LOCAL_BACKEND_URL || "http://127.0.0.1:3797";

async function parseResponse(response) {
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error || payload.message || "Worklog request failed.");
  }

  return payload;
}

function worklogUrl(docketId, suffix = "") {
  return `${LOCAL_BACKEND_ORIGIN}/api/worklogs/${encodeURIComponent(docketId)}${suffix}`;
}

export async function loadJobWorklogState(docketId) {
  return parseResponse(await fetch(worklogUrl(docketId)));
}

export async function saveJobWorklogDraft(docketId, draft) {
  return parseResponse(
    await fetch(worklogUrl(docketId, "/draft"), {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(draft),
    })
  );
}

export async function clearJobWorklogDraft(docketId) {
  return parseResponse(
    await fetch(worklogUrl(docketId, "/draft"), {
      method: "DELETE",
    })
  );
}

export async function submitJobWorklog(docketId, payload) {
  return parseResponse(
    await fetch(worklogUrl(docketId, "/submit"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    })
  );
}
