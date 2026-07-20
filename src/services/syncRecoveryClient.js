import { localBackendOrigin } from "./backendOrigin";

function recoveryEndpoint() {
  return `${localBackendOrigin()}/api/local/sync/recovery/resolve-duplicate`;
}

async function parseRecoveryResponse(response) {
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const error = new Error(
      payload?.message ||
        payload?.error ||
        `Duplicate recovery failed (${response.status}).`
    );
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}

export async function previewDuplicateSyncRecovery(input = {}) {
  const response = await fetch(recoveryEndpoint(), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ...input,
      previewOnly: true,
    }),
  });

  return parseRecoveryResponse(response);
}

export async function resolveDuplicateSyncRecovery(input = {}) {
  const response = await fetch(recoveryEndpoint(), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });

  return parseRecoveryResponse(response);
}
