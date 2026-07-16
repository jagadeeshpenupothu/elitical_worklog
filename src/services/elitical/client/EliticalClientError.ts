export type EliticalClientErrorCode =
  | "AUTHENTICATION_REQUIRED"
  | "REQUEST_FAILED"
  | "INVALID_JSON"
  | "INVALID_RESPONSE"
  | "UNIMPLEMENTED";

export class EliticalClientError extends Error {
  code: EliticalClientErrorCode;
  endpoint?: string;
  status?: number;
  payload?: unknown;
  cause?: unknown;

  constructor(
    code: EliticalClientErrorCode,
    message: string,
    options: {
      endpoint?: string;
      status?: number;
      payload?: unknown;
      cause?: unknown;
    } = {}
  ) {
    super(message);
    this.name = "EliticalClientError";
    this.code = code;
    this.endpoint = options.endpoint;
    this.status = options.status;
    this.payload = options.payload;
    this.cause = options.cause;
  }
}
