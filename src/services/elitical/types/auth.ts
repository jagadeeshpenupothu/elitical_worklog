import type { EliticalSession } from "./session.js";

export interface EliticalAuthServiceContract {
  initialize(): Promise<void>;
  login(): Promise<EliticalSession | null>;
  logout(): Promise<void>;
  restoreSession(): Promise<EliticalSession | null>;
  hasValidSession(): Promise<boolean>;
  close(): Promise<void>;
}
