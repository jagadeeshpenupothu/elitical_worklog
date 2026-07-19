import { syncProviderData } from "../syncClient";

export async function syncLiveEliticalData({ onProgress } = {}) {
  return syncProviderData({ provider: "elitical", onProgress });
}
