import { DbQueryError, type DbErrorInfo, EngineError, type Reason, isConnectionError } from "@tspg/core/errors";

/**
 * Error body, in the exact shape PostgREST returns:
 * `{ code, message, details, hint }`.
 */
export interface ErrorBody {
  readonly code: string;
  readonly message: string;
  /** A string, or -- for an ambiguous embed (PGRST201) -- the relationships it could mean, as PostgREST lists them. */
  readonly details: string | null | ReadonlyArray<Readonly<Record<string, string>>>;
  readonly hint: string | null;
}

/**
 * Thrown by the pure parts of the library (parsers, SQL builders). It is
 * converted into an {@link ApiError} at the request boundary.
 */
export class PgRestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: string | null = null,
    readonly hint: string | null = null,
    readonly headers: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = "PgRestError";
  }

  get body(): ErrorBody {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
      hint: this.hint,
    };
  }
}

/**
 * A one-line summary for stack traces and logs. The wire format is `body`, which this never
 * touches: PostgREST clients read `message` from the JSON, while a program that catches the
 * error reads it from `Error.message` and wants the code and hint with it.
 */
const describe = (b: ErrorBody): string =>
  [
    `${b.code}:`,
    b.message,
    b.details ? `(${typeof b.details === "string" ? b.details : JSON.stringify(b.details)})` : "",
    b.hint ? `hint: ${b.hint}` : "",
  ]
    .filter(Boolean)
    .join(" ");

/** An error that has already been mapped to an HTTP response. */
export class ApiError extends Error {
  readonly _tag = "ApiError";
  readonly status: number;
  readonly body: ErrorBody;
  readonly headers: Readonly<Record<string, string>>;
  constructor(fields: {
    readonly status: number;
    readonly body: ErrorBody;
    readonly headers: Readonly<Record<string, string>>;
  }) {
    super(describe(fields.body));
    this.name = "ApiError";
    this.status = fields.status;
    this.body = fields.body;
    this.headers = fields.headers;
  }
}

/**
 * SQLSTATE → HTTP status, following the PostgREST 16 table
 * (https://docs.postgrest.org/en/v16/references/errors.html).
 */
const statusFromSqlState = (
  state: string,
  message: string,
  role: string | undefined,
  anon: string | undefined,
): number => {
  // `PTxyz` is status xyz, when xyz is a number (PostgREST's `mapSQLtoHTTP`); `PT40A` is a 500
  if (state.startsWith("PT")) return /^\d+$/.test(state.slice(2)) ? Number(state.slice(2)) : 500;
  switch (state) {
    case "23503":
    case "23505":
      return 409;
    case "25006":
      return 405;
    case "21000":
      // cardinality_violation: pg-safeupdate's refusal is the client's, anything else the server's
      return message.endsWith("requires a WHERE clause") ? 400 : 500;
    case "22023":
      // a role that does not exist is an authentication failure
      return message.startsWith("role") && message.endsWith("does not exist") ? 401 : 400;
    case "42883":
      return message.startsWith("function xmlagg(") ? 406 : 404;
    case "42P01":
      return 404;
    case "42P17":
      return 500;
    case "42501":
      return role === anon ? 401 : 403;
    case "P0001":
      return 400;
    case "53400":
      return 500;
    case "57P01":
      return 503;
  }
  switch (state.slice(0, 2)) {
    case "08":
    case "53":
      return 503;
    case "0L":
    case "0P":
    case "28":
      return 403;
    case "09":
    case "25":
    case "2D":
    case "38":
    case "39":
    case "3B":
    case "40":
    case "54":
    case "55":
    case "57":
    case "58":
    case "F0":
    case "HV":
    case "P0":
    case "XX":
      return 500;
    default:
      return 400;
  }
};

const isText = (v: unknown): v is string => typeof v === "string";
const isOptionalText = (v: unknown): boolean => v === undefined || v === null || typeof v === "string";
const parseJsonObject = (text: string): Record<string, unknown> | undefined => {
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

/** PostgREST's PGRST121, for a `RAISE SQLSTATE 'PGRST'` whose MESSAGE or DETAIL is not what the convention asks. */
const pgrstParseError = (details: string, hint: string): ApiError =>
  new ApiError({
    status: 500,
    headers: {},
    body: { code: "PGRST121", message: `Could not parse JSON in the "RAISE SQLSTATE 'PGRST'" error`, details, hint },
  });
const MESSAGE_HINT =
  "MESSAGE must be a JSON object with obligatory keys: 'code', 'message' and optional keys: 'details', 'hint'.";
const DETAIL_HINT =
  "DETAIL must be a JSON object with obligatory keys: 'status', 'headers' and optional key: 'status_text'.";

/**
 * `RAISE SQLSTATE 'PGRST'`, as PostgREST's `parseRaisePGRST` reads it: MESSAGE is the body
 * (`code` and `message`, `details` and `hint` optional), DETAIL the status and the headers.
 */
const raisedPgrst = (err: DbErrorInfo): ApiError => {
  const msg = parseJsonObject(err.message);
  if (
    !msg ||
    !isText(msg["code"]) ||
    !isText(msg["message"]) ||
    !isOptionalText(msg["details"]) ||
    !isOptionalText(msg["hint"])
  ) {
    return pgrstParseError(`Invalid JSON value for MESSAGE: '${err.message}'`, MESSAGE_HINT);
  }
  if (err.detail === undefined || err.detail === null || err.detail === "") {
    return pgrstParseError("DETAIL is missing in the RAISE statement", DETAIL_HINT);
  }
  const det = parseJsonObject(err.detail);
  const headers = det?.["headers"];
  if (
    !det ||
    typeof det["status"] !== "number" ||
    !Number.isInteger(det["status"]) ||
    !isOptionalText(det["status_text"]) ||
    headers === null ||
    typeof headers !== "object" ||
    Array.isArray(headers) ||
    !Object.values(headers).every(isText)
  ) {
    return pgrstParseError(`Invalid JSON value for DETAIL: '${err.detail}'`, DETAIL_HINT);
  }
  return new ApiError({
    status: det["status"],
    headers: headers as Record<string, string>,
    body: {
      code: msg["code"],
      message: msg["message"],
      details: (msg["details"] as string | null | undefined) ?? null,
      hint: (msg["hint"] as string | null | undefined) ?? null,
    },
  });
};

/**
 * Map a Postgres error to a PostgREST-style API error.
 *
 * Supports PostgREST's custom error conventions:
 * - `RAISE ... USING ERRCODE = 'PTxyz'` → HTTP status xyz
 * - `RAISE SQLSTATE 'PGRST'` with a JSON message/detail
 */
export const dbErrorToApiError = (
  err: DbErrorInfo,
  role: string | undefined,
  anonymousRole: string | undefined,
): ApiError => {
  if (err.sqlState === "PGRST") return raisedPgrst(err);
  return new ApiError({
    status: statusFromSqlState(err.sqlState, err.message, role, anonymousRole),
    headers: {},
    body: {
      code: err.sqlState,
      message: err.message,
      details: err.detail ?? null,
      hint: err.hint ?? null,
    },
  });
};

/** What a reason answers with over HTTP: PostgREST's status and code. */
const REASONS: Readonly<Record<Reason, readonly [status: number, code: string]>> = {
  invalid_input: [400, "PGRST100"],
  invalid_setting: [500, "PGRST100"],
  invalid_body: [400, "PGRST102"],
  not_embedded: [400, "PGRST108"],
  limit_offset_on_put: [400, "PGRST114"],
  payload_key_mismatch: [400, "PGRST115"],
  invalid_related_order: [400, "PGRST118"],
  invalid_embed_filter: [400, "PGRST120"],
  too_many_affected: [400, "PGRST124"],
  not_implemented: [400, "PGRST127"],
  max_affected_unsupported: [400, "PGRST128"],
  no_relationship: [400, "PGRST200"],
  ambiguous_relationship: [300, "PGRST201"],
  unknown_column: [400, "PGRST204"],
  undefined_column: [400, "42703"],
  anonymous_disabled: [401, "PGRST302"],
  function_not_found: [404, "PGRST202"],
  ambiguous_function: [300, "PGRST203"],
  table_not_found: [404, "PGRST205"],
  put_requires_pk: [405, "PGRST105"],
  schema_not_exposed: [406, "PGRST106"],
  not_single_row: [406, "PGRST116"],
  range_not_satisfiable: [416, "PGRST103"],
};

/** An engine error as the PostgREST error it answers with. */
const fromEngineError = (e: EngineError): ApiError => {
  const [status, code] = REASONS[e.reason];
  const headers: Record<string, string> = {};
  if (e.data.total !== undefined) headers["Content-Range"] = `*/${e.data.total}`;
  if (e.data.applied) headers["Preference-Applied"] = e.data.applied;
  const details = e.data.json && e.details !== null ? (JSON.parse(e.details) as ErrorBody["details"]) : e.details;
  return new ApiError({ status, body: { code, message: e.message, details, hint: e.hint }, headers });
};

/** Map anything thrown while handling a request to an {@link ApiError}. */
export const toApiError = (e: unknown, role: string | undefined, anonymousRole: string | undefined): ApiError => {
  if (e instanceof ApiError) return e;
  if (e instanceof PgRestError) return new ApiError({ status: e.status, body: e.body, headers: e.headers });
  if (e instanceof EngineError) return fromEngineError(e);
  if (e instanceof DbQueryError) return dbErrorToApiError(e, role, anonymousRole);
  if (isConnectionError(e)) {
    return new ApiError({
      status: 503,
      headers: {},
      body: {
        code: "PGRST001",
        message: "Database connection failed",
        details: e instanceof Error ? e.message : null,
        hint: null,
      },
    });
  }
  return new ApiError({
    status: 500,
    headers: {},
    body: { code: "PGRSTX00", message: "Internal error", details: null, hint: null },
  });
};
