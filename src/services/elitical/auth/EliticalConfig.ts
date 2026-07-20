import path from "node:path";
import process from "node:process";
import { getStoragePaths } from "../../../../local-backend/services/StoragePathService.mjs";
import type {
  EliticalConfig,
  EliticalConfigInput,
} from "../types/index.js";
import { EliticalAuthError } from "./EliticalAuthError.js";

const DEFAULT_STORAGE_STATE_FILE = "storage-state.json";
const DEFAULT_BROWSER_TYPE = "chromium";
const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_VERIFICATION_TIMEOUT_MS = 15 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30 * 1000;
const DEFAULT_MUTATION_REQUEST_TIMEOUT_MS = 60 * 1000;
const DEFAULT_VERIFICATION_PATH = "/api/1/UserSessionDto";
const DEFAULT_BASE_URL = "https://elitical.sayukth.com";

function envBoolean(value: string | undefined, fallback: boolean) {
  if (value === undefined) return fallback;
  return value === "true";
}

function configuredBaseUrl(input?: EliticalConfigInput) {
  return input?.baseUrl || process.env.ELITICAL_BASE_URL || DEFAULT_BASE_URL;
}

function configuredStorageStatePath(input?: EliticalConfigInput) {
  if (input?.storageStatePath) return input.storageStatePath;
  if (process.env.ELITICAL_STORAGE_STATE_PATH) {
    return process.env.ELITICAL_STORAGE_STATE_PATH;
  }

  const dataDir =
    input?.dataDir ||
    process.env.ELITICAL_DATA_DIR ||
    getStoragePaths().authDir;

  return path.join(dataDir, DEFAULT_STORAGE_STATE_FILE);
}

export function resolveEliticalConfig(
  input: EliticalConfigInput = {}
): EliticalConfig {
  const baseUrl = configuredBaseUrl(input).replace(/\/$/, "");

  if (!baseUrl) {
    throw new EliticalAuthError(
      "CONFIGURATION_ERROR",
      "Elitical baseUrl is required."
    );
  }

  return {
    baseUrl,
    storageStatePath: configuredStorageStatePath(input),
    browserType:
      input.browserType ||
      (process.env.ELITICAL_BROWSER_TYPE as EliticalConfig["browserType"]) ||
      DEFAULT_BROWSER_TYPE,
    headless: input.headless ?? envBoolean(process.env.ELITICAL_HEADLESS, false),
    loginTimeoutMs:
      input.loginTimeoutMs ||
      Number(process.env.ELITICAL_LOGIN_TIMEOUT_MS) ||
      DEFAULT_LOGIN_TIMEOUT_MS,
    verificationTimeoutMs:
      input.verificationTimeoutMs ||
      Number(process.env.ELITICAL_VERIFICATION_TIMEOUT_MS) ||
      DEFAULT_VERIFICATION_TIMEOUT_MS,
    requestTimeoutMs:
      input.requestTimeoutMs ||
      Number(process.env.ELITICAL_REQUEST_TIMEOUT_MS) ||
      DEFAULT_REQUEST_TIMEOUT_MS,
    mutationRequestTimeoutMs:
      input.mutationRequestTimeoutMs ||
      Number(process.env.ELITICAL_MUTATION_REQUEST_TIMEOUT_MS) ||
      DEFAULT_MUTATION_REQUEST_TIMEOUT_MS,
    verificationPath:
      input.verificationPath ||
      process.env.ELITICAL_VERIFICATION_PATH ||
      DEFAULT_VERIFICATION_PATH,
  };
}
