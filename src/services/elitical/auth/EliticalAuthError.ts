export type EliticalAuthErrorCode =
  | "CONFIGURATION_ERROR"
  | "INITIALIZATION_FAILED"
  | "LOGIN_FAILED"
  | "LOGOUT_FAILED"
  | "SESSION_RESTORE_FAILED"
  | "SESSION_INVALID"
  | "SESSION_STORAGE_FAILED";

export class EliticalAuthError extends Error {
  code: EliticalAuthErrorCode;
  cause?: unknown;

  constructor(
    code: EliticalAuthErrorCode,
    message: string,
    options: { cause?: unknown } = {}
  ) {
    super(message);
    this.name = "EliticalAuthError";
    this.code = code;
    this.cause = options.cause;
  }
}
