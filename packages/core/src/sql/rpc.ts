import { ALIAS } from "../constants";
import { EngineError } from "../errors";
import { quoteIdent, quoteQualified } from "../quote";
import { fuzzyGetOne } from "../fuzzy";
import { type FunctionDef, type Relation, type SchemaCache, relKey } from "../schema";

export type RpcShape =
  /** Rows of a table-like result: SETOF composite / TABLE(...). */
  | "rows"
  /** A single composite row. */
  | "object"
  /** SETOF scalar. */
  | "scalar-set"
  /** A single scalar value. */
  | "scalar"
  | "void";

export interface RpcCall {
  readonly fn: FunctionDef;
  readonly shape: RpcShape;
  /** A SELECT that yields the function result as a relation. Uses `$1` for arguments when `hasBody`. */
  readonly source: string;
  /**
   * The function call as a `FROM` item, to be aliased by the reader, for a function returning rows:
   * aliasing the call itself (rather than a subquery over it) keeps the row typed, so a computed field
   * or a computed relationship of the table it returns can be resolved on it.
   */
  readonly fromItem?: string | undefined;
  /** True when the SQL references `$1` (a JSON text with the arguments). */
  readonly usesBody: boolean;
  /** Table the result rows belong to, when known (enables embedding) — or a synthetic one. */
  readonly relation: Relation;
}

/** What a body is read as: JSON, or a raw body (`text/plain`, `text/xml`, `application/octet-stream`). */
export type BodyType = "json" | "text" | "xml" | "bytea";

const BODY_TYPES: Record<BodyType, ReadonlySet<string>> = {
  json: new Set(["json", "jsonb"]),
  text: new Set(["text"]),
  xml: new Set(["xml"]),
  bytea: new Set(["bytea"]),
};

/** A function that takes the whole body as its only, unnamed parameter. */
export const isSingleUnnamedParam = (fn: FunctionDef, as: BodyType = "json"): boolean =>
  fn.args.length === 1 && fn.args[0]!.name === "" && BODY_TYPES[as].has(fn.args[0]!.type);

/** PostgREST's spelling used when more than one function fits: `schema.fn(a => integer, b => text)`. */
const arrowSignature = (fn: FunctionDef): string =>
  `${fn.schema}.${fn.name}(${fn.args.map((a) => `${a.name} => ${a.type}`).join(", ")})`;

/**
 * Whether a function can be called over HTTP at all (PostgREST's `callable`): every parameter has a
 * name, or the one that has none takes a body (`bytea`, `json`, `jsonb`, `text`, `xml`). A function of
 * a table row, say, is a computed field or relationship and nothing else.
 */
const callable = (fn: FunctionDef): boolean => {
  // a trigger function is no RPC either (PostgREST's schema cache leaves them out)
  if (fn.returnType === "trigger") return false;
  const unnamed = fn.args.filter((a) => a.name === "");
  return (
    unnamed.length === 0 ||
    (unnamed.length === 1 && ["bytea", "json", "jsonb", "text", "xml"].includes(unnamed[0]!.type))
  );
};

/**
 * The "Perhaps you meant ..." hint of `function_not_found`, as PostgREST's `noRpcHint` makes it: with
 * no function of that name, the closest name in the schema; otherwise the closest parameter list
 * among its overloads, compared as text, `(a, b)`.
 */
const functionHint = (
  cache: SchemaCache,
  schema: string,
  name: string,
  candidates: ReadonlyArray<FunctionDef>,
  provided: ReadonlySet<string>,
): string | null => {
  const list = (names: ReadonlyArray<string>) => `(${names.join(", ")})`;
  if (candidates.length > 0) {
    const lists = candidates.map((fn) => list(fn.args.map((a) => a.name).sort()));
    const best = fuzzyGetOne(lists, list([...provided].sort()), 0.33);
    return best === undefined ? null : `Perhaps you meant to call the function ${schema}.${name}${best}`;
  }
  const names: string[] = [];
  for (const fns of cache.functions.values())
    for (const fn of fns) if (fn.schema === schema && callable(fn)) names.push(fn.name);
  // a function's name is only suggested when it is close (PostgREST's `getFuzzyHint`, 0.75)
  const best = fuzzyGetOne(names, name, 0.75);
  return best === undefined ? null : `Perhaps you meant to call the function ${schema}.${best}`;
};

/**
 * Pick the function to call from the argument names the client supplied, as PostgREST's `findProc`
 * does: the overloads whose parameters the names match, and failing those, the ones that take the
 * body whole through a single unnamed parameter of the body's type.
 *
 * `jsonBody` is true when a POST carries JSON (the only body a `json`/`jsonb` parameter takes whole);
 * `post` tells whether the function was invoked with POST; `bodyType` is the type of a raw body.
 */
export const resolveFunction = (
  cache: SchemaCache,
  schema: string,
  name: string,
  provided: ReadonlySet<string>,
  jsonBody: boolean,
  post = true,
  bodyType: BodyType = "json",
): FunctionDef => {
  const candidates = (cache.functions.get(relKey(schema, name)) ?? []).filter(callable);
  const names = [...provided].sort();
  const raw = post && bodyType !== "json";
  const params =
    names.length === 0 ? "without parameters" : `with parameter${names.length === 1 ? "" : "s"} ${names.join(", ")}`;
  const notFound = () =>
    new EngineError(
      "function_not_found",
      raw
        ? `Could not find the function ${schema}.${name} in the schema cache`
        : names.length === 0
          ? `Could not find the function ${schema}.${name} without parameters in the schema cache`
          : `Could not find the function ${schema}.${name}(${names.join(", ")}) in the schema cache`,
      `Searched for the function ${schema}.${name} ${
        raw
          ? `with a single unnamed ${bodyType} parameter`
          : `${params}${post && jsonBody ? " or with a single unnamed json/jsonb parameter" : ""}`
      }, but no matches were found in the schema cache.`,
      // a raw body names no parameter to suggest
      raw ? null : functionHint(cache, schema, name, candidates, provided),
    );

  const matchesParams = (fn: FunctionDef): boolean => {
    if (fn.args.length === 0) return provided.size === 0 && !raw;
    const required = fn.args.filter((a) => !a.hasDefault).map((a) => a.name);
    const optional = new Set(fn.args.filter((a) => a.hasDefault).map((a) => a.name));
    const rest = [...provided].filter((p) => !optional.has(p));
    return rest.length === required.length && required.every((r) => provided.has(r));
  };
  const takesBody = (fn: FunctionDef): boolean =>
    post && (raw ? isSingleUnnamedParam(fn, bodyType) : jsonBody && isSingleUnnamedParam(fn, "json"));

  const named = candidates.filter(matchesParams);
  const single = candidates.filter((fn) => !named.includes(fn) && takesBody(fn));
  const matches = named.length > 0 ? named : single;
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) throw notFound();
  throw new EngineError(
    "ambiguous_function",
    // PostgREST lists the candidates in the order it read them; the fewest parameters first is that order here
    `Could not choose the best candidate function between: ${[...matches]
      .sort((a, b) => a.args.length - b.args.length || (arrowSignature(a) < arrowSignature(b) ? -1 : 1))
      .map(arrowSignature)
      .join(", ")}`,
    null,
    "Try renaming the parameters or the function itself in the database so function overloading can be resolved",
  );
};

const stripQuotes = (s: string) => s.replace(/^"|"$/g, "");

/** Find the table a composite return type refers to, if it is an exposed relation. */
const relationOfReturnType = (cache: SchemaCache, fn: FunctionDef): Relation | undefined => {
  if (!fn.returnsComposite) return undefined;
  if (fn.returnRelation) {
    const r = cache.relations.get(relKey(fn.returnRelation.schema, fn.returnRelation.name));
    if (r) return r;
  }
  const t = fn.returnType.replace(/\[\]$/, "");
  const dot = t.indexOf(".");
  if (dot > 0) return cache.relations.get(relKey(stripQuotes(t.slice(0, dot)), stripQuotes(t.slice(dot + 1))));
  const bare = stripQuotes(t);
  const inOwn = cache.relations.get(relKey(fn.schema, bare));
  if (inOwn) return inOwn;
  for (const r of cache.relations.values()) if (r.name === bare) return r;
  return undefined;
};

const syntheticRelation = (fn: FunctionDef): Relation => ({
  schema: fn.schema,
  name: fn.name,
  kind: "view",
  columns: [],
  pk: [],
  uniques: [],
  insertable: false,
  updatable: false,
  deletable: false,
  comment: null,
});

/**
 * The type an argument is read as. A function's signature carries no length, and `character` or `bit`
 * spelled without one is a length of 1: PostgREST reads them as `character varying` and `bit varying`,
 * and the function's own parameter (or the column it is written to) decides.
 */
const unbounded = (type: string): string =>
  type.replace(/^character(?=\[|$)/, "character varying").replace(/^bit(?=\[|$)/, "bit varying");

/**
 * Build the SQL that calls `fn`. Arguments travel as one JSON text (`$1`) and
 * are converted by `json_to_record` using the declared types, so values are
 * never interpolated into SQL.
 */
export const buildRpc = (
  cache: SchemaCache,
  fn: FunctionDef,
  provided: ReadonlyArray<string>,
  rawBody: boolean,
  bodyType: BodyType = "json",
): RpcCall => {
  const fnRef = quoteQualified(fn.schema, fn.name);
  let args: string;
  let usesBody = false;
  let from = "";

  if (rawBody && isSingleUnnamedParam(fn, bodyType)) {
    const t = fn.args[0]!.type;
    // a binary body travels as hex: a text parameter would read its backslashes
    args = bodyType === "bytea" ? `decode($1::text, 'hex')` : `($1::text)::${t}`;
    usesBody = true;
  } else {
    const used = fn.args.filter((a) => provided.includes(a.name));
    args = used
      .map((a) => `${a.variadic ? "VARIADIC " : ""}${quoteIdent(a.name)} := _args.${quoteIdent(a.name)}`)
      .join(", ");
    if (used.length > 0) {
      usesBody = true;
      from = `json_to_record(($1::text)::json) AS _args(${used.map((a) => `${quoteIdent(a.name)} ${unbounded(a.type)}`).join(", ")}) CROSS JOIN LATERAL `;
    }
  }

  const call = `${from}${fnRef}(${args}) AS _f`;
  // A bare `record` is called in the select list, as PostgREST does: there its columns are the ones
  // the call returns, where a `FROM` would need them spelled out. Its value is the body, an object
  // (or a list of them).
  if (fn.returnsAnonymousRecord) {
    const fromArgs = from ? ` FROM ${from.replace(/ CROSS JOIN LATERAL $/, "")}` : "";
    return {
      fn,
      shape: fn.returnsSet ? "scalar-set" : "scalar",
      source: `SELECT ${fnRef}(${args}) AS ${ALIAS}_scalar${fromArgs}`,
      usesBody,
      relation: syntheticRelation(fn),
    };
  }
  const base = fn.returnsVoid
    ? `SELECT 1 AS ${ALIAS}_scalar FROM ${call}`
    : fn.returnsComposite
      ? `SELECT _f.* FROM ${call}`
      : `SELECT _f AS ${ALIAS}_scalar FROM ${call}`;

  const shape: RpcShape = fn.returnsVoid
    ? "void"
    : fn.returnsComposite
      ? fn.returnsSet
        ? "rows"
        : "object"
      : fn.returnsSet
        ? "scalar-set"
        : "scalar";

  const relation = relationOfReturnType(cache, fn) ?? syntheticRelation(fn);
  const fromItem = fn.returnsComposite ? `${from}${fnRef}(${args})` : undefined;
  return { fn, shape, source: base, fromItem, usesBody, relation };
};
