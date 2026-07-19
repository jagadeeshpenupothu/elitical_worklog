export type EliticalBrowserType = "chromium" | "firefox" | "webkit";

export interface EliticalConfig {
  baseUrl: string;
  storageStatePath: string;
  browserType: EliticalBrowserType;
  headless: boolean;
  loginTimeoutMs: number;
  verificationTimeoutMs: number;
  requestTimeoutMs: number;
  mutationRequestTimeoutMs: number;
  verificationPath: string;
}

export interface EliticalConfigInput {
  baseUrl?: string;
  dataDir?: string;
  storageStatePath?: string;
  browserType?: EliticalBrowserType;
  headless?: boolean;
  loginTimeoutMs?: number;
  verificationTimeoutMs?: number;
  requestTimeoutMs?: number;
  mutationRequestTimeoutMs?: number;
  verificationPath?: string;
}
