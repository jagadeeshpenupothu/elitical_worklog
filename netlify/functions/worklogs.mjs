import { loadPublishedWorklogsFile } from "../../local-backend/services/GitHubDataService.mjs";

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  };
}

export async function handler(event) {
  if (event.httpMethod !== "GET") {
    return json(405, {
      error: "Method not allowed.",
    });
  }

  try {
    return json(200, await loadPublishedWorklogsFile());
  } catch (error) {
    return json(error.statusCode || 500, {
      error: error.message || "Unable to load published worklogs.",
      missing: error.missing || undefined,
    });
  }
}
