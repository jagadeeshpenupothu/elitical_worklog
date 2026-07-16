import type { EliticalSession } from "./session";

export interface EliticalAuthServiceContract {
  initialize(): Promise<void>;
  login(): Promise<EliticalSession | null>;
  logout(): Promise<void>;
  restoreSession(): Promise<EliticalSession | null>;
  hasValidSession(): Promise<boolean>;
}
