import {
  type Column,
  type FunctionDef,
  type Relation,
  type SchemaCache,
  pgrstKey,
  relationshipsOf,
} from "@tspg/core/schema";

// The Swagger 2.0 document PostgREST serves at the root, ported from its `Response/OpenAPI.hs`: the
// same definitions, parameters and paths, built from the same parts of the schema cache.

type Json = Record<string, unknown>;

/** The media types the document advertises. RPC paths cannot answer CSV, so they list the first three. */
const MEDIA_TYPES = [
  "application/json",
  "application/vnd.pgrst.object+json;nulls=stripped",
  "application/vnd.pgrst.object+json",
  "text/csv",
] as const;
const RPC_MEDIA_TYPES = MEDIA_TYPES.slice(0, 3);

/** PostgREST's version, which the document carries as its own. */
const VERSION = "16.5";

/** `toSwaggerType`: `undefined` for json, which carries no type. */
const swaggerType = (t: string): string | undefined => {
  switch (t) {
    case "character varying":
    case "character":
    case "text":
      return "string";
    case "boolean":
      return "boolean";
    case "smallint":
    case "integer":
    case "bigint":
      return "integer";
    case "numeric":
    case "real":
    case "double precision":
      return "number";
    case "json":
    case "jsonb":
      return undefined;
    default:
      return t.endsWith("[]") ? "array" : "string";
  }
};

/** `toSwaggerFormat`. */
const swaggerFormat = (t: string): string =>
  t === "smallint" || t === "integer" ? "int32" : t === "bigint" ? "int64" : t;

/** `makePropertyItems`: the items of an array. */
const items = (t: string): Json | undefined => {
  if (swaggerType(t) !== "array") return undefined;
  const inner = swaggerType(t.slice(0, -2));
  return inner === undefined ? {} : { type: inner };
};

/**
 * The type PostgREST's schema cache names a column by (`data_type`): a type of `pg_catalog` without
 * its modifier, a domain by its base type when that is one of `pg_catalog`'s.
 */
const CATALOG_TYPES = new Set([
  "character varying",
  "character",
  "text",
  "boolean",
  "smallint",
  "integer",
  "bigint",
  "numeric",
  "real",
  "double precision",
  "json",
  "jsonb",
  "uuid",
  "date",
  "bytea",
  "money",
  "interval",
  "timestamp with time zone",
  "timestamp without time zone",
  "time with time zone",
  "time without time zone",
  "inet",
  "cidr",
  "macaddr",
  "tsvector",
  "tsquery",
  "xml",
  "oid",
  "name",
  "bit",
  "bit varying",
  "point",
  "int4range",
  "int8range",
  "numrange",
  "tsrange",
  "tstzrange",
  "daterange",
]);
const dataType = (c: Column): string => {
  const strip = (t: string) => {
    const arr = t.endsWith("[]");
    const bare = (arr ? t.slice(0, -2) : t)
      .replace(/\(.*?\)/, "")
      .replace(/\s+/g, " ")
      .trim();
    return CATALOG_TYPES.has(bare) ? `${bare}${arr ? "[]" : ""}` : undefined;
  };
  if (c.baseType && strip(c.baseType)) return strip(c.baseType)!;
  return strip(c.type) ?? c.type;
};

/** `character_maximum_length`, read off the type's modifier. */
const maxLength = (c: Column): number | undefined => {
  const m = /^(?:character varying|character|bit varying|bit)\((\d+)\)$/.exec((c.baseType ?? c.type).trim());
  return m ? Number(m[1]) : undefined;
};

/** `parseDefault`: a default that is JSON once a string's literal is unwrapped, and nothing otherwise. */
const parsedDefault = (type: string, expr: string | null): unknown => {
  if (expr === null) return undefined;
  let text = expr;
  if (swaggerType(type) === "string") {
    const suffix = `::${type}`;
    const bare = text.endsWith(suffix) ? text.slice(0, -suffix.length).replace(/^'+|'+$/g, "") : text;
    text = `"${bare}"`;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** The first line of a comment, and the rest without the newlines that lead it (PostgREST's summary and description). */
const split = (comment: string | null): { summary?: string; description?: string } => {
  if (comment === null) return {};
  const at = comment.indexOf("\n");
  if (at < 0) return { summary: comment };
  const rest = comment.slice(at).replace(/^\n+/, "");
  return { summary: comment.slice(0, at), ...(rest ? { description: rest } : {}) };
};

/** `makeProperty`. */
const property = (cache: SchemaCache, rel: Relation, c: Column): Json => {
  const t = dataType(c);
  // the first single-column foreign key from this column, tables before views
  const fk = relationshipsOf(cache, rel)
    .filter(
      (r) =>
        !r.computed &&
        !r.junction &&
        (r.kind === "m2o" || r.kind === "o2o") &&
        r.fk.schema === rel.schema &&
        r.fk.table === rel.name &&
        r.fromCols.length === 1 &&
        r.fromCols[0] === c.name,
    )
    .sort((a, b) => Number(isView(a.to)) - Number(isView(b.to)))[0];
  const notes = [
    "Note:",
    ...(pgrstKey(rel).includes(c.name) ? ["This is a Primary Key.<pk/>"] : []),
    ...(fk
      ? [
          `This is a Foreign Key to \`${fk.to.name}.${fk.toCols[0]}\`.<fk table='${fk.to.name}' column='${fk.toCols[0]}'/>`,
        ]
      : []),
  ];
  const description =
    notes.length > 1 ? `${c.comment ? `${c.comment}\n\n` : ""}${notes.join("\n")}` : (c.comment ?? undefined);
  const dflt = parsedDefault(t, c.defaultExpr);
  const type = swaggerType(t);
  const it = items(t);
  const len = maxLength(c);
  return {
    ...(dflt !== undefined ? { default: dflt } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(c.enumLabels?.length ? { enum: c.enumLabels } : {}),
    format: swaggerFormat(t),
    ...(len !== undefined ? { maxLength: len } : {}),
    ...(type ? { type } : {}),
    ...(it ? { items: it } : {}),
  };
};

const isView = (r: Relation) => r.kind === "view" || r.kind === "matview";

/** A `Prefer` header parameter (`makePreferParam`). */
const preferParam = (values: ReadonlyArray<string>): Json => ({
  name: "Prefer",
  description: "Preference",
  required: false,
  in: "header",
  type: "string",
  ...(values.length ? { enum: values } : {}),
});

const queryParam = (name: string, description: string): Json => ({
  name,
  description,
  required: false,
  in: "query",
  type: "string",
});

/** What the document is made of beyond the schema cache: read per request, as PostgREST does. */
export interface OpenApiContext {
  /** The relations of the schema the role can reach (`accessibleTables`). */
  readonly accessible?: ReadonlySet<string> | undefined;
  /** The schema's comment (`schemaDescription`): its first line is the title. */
  readonly schemaDescription?: string | null | undefined;
}

export interface OpenApiOptions {
  readonly serverUrl: string;
  readonly basePath: string;
  /** The schemas a request runs with on its search path: a type of theirs is named without them, as PostgREST's `regtype` prints it. */
  readonly searchPath?: ReadonlyArray<string> | undefined;
}

/** A type as `regtype` prints it on the request's search path: without the schema of one on it. */
const unqualified = (type: string, searchPath: ReadonlyArray<string>): string => {
  for (const s of searchPath) {
    for (const prefix of [`${s}.`, `"${s}".`]) if (type.startsWith(prefix)) return type.slice(prefix.length);
  }
  return type;
};

/** Whether a function can be called over HTTP (PostgREST's `callable`). */
const callable = (fn: FunctionDef): boolean => {
  if (fn.returnType === "trigger") return false;
  const unnamed = fn.args.filter((a) => a.name === "");
  return (
    unnamed.length === 0 ||
    (unnamed.length === 1 && ["bytea", "json", "jsonb", "text", "xml"].includes(unnamed[0]!.type))
  );
};

/** The input parameters of a function, as its document lists them. */
const procParam = (t: string): Json => {
  const type = swaggerType(t);
  const it = items(t);
  return { ...(type ? { type } : {}), ...(it ? { items: it } : {}), format: swaggerFormat(t) };
};

/** `makeProcPathItem`. */
const procPath = (fn: FunctionDef, searchPath: ReadonlyArray<string>): Json => {
  const typeOf = (a: FunctionDef["args"][number]) => unqualified(a.type, searchPath);
  const base = {
    ...split(fn.comment),
    tags: [`(rpc) ${fn.name}`],
    produces: RPC_MEDIA_TYPES,
    responses: { "200": { description: "OK" } },
  };
  const required = fn.args.filter((a) => !a.hasDefault).map((a) => a.name);
  const post = {
    ...base,
    parameters: [
      {
        name: "args",
        required: true,
        in: "body",
        schema: {
          ...(fn.comment ? { description: fn.comment } : {}),
          type: "object",
          ...(fn.args.length
            ? { properties: Object.fromEntries(fn.args.map((a) => [a.name, procParam(typeOf(a))])) }
            : {}),
          ...(required.length ? { required } : {}),
        },
      },
      { $ref: "#/parameters/preferParams" },
    ],
  };
  if (fn.volatility === "volatile") return { post };
  const params = fn.args.map((a) => {
    const t = typeOf(a);
    const type = swaggerType(t);
    if (a.variadic) {
      const inner = t.endsWith("[]") ? t.slice(0, -2) : t;
      const innerType = swaggerType(inner);
      return {
        name: a.name,
        required: !a.hasDefault,
        in: "query",
        type: type ?? "string",
        collectionFormat: "multi",
        items: { ...(innerType ? { type: innerType } : {}), format: swaggerFormat(inner) },
      };
    }
    return {
      name: a.name,
      required: !a.hasDefault,
      in: "query",
      format: swaggerFormat(t),
      // a query string has no array nor untyped value: they are strings there
      type: type === undefined || type === "array" ? "string" : type,
    };
  });
  const get = { ...base, ...(params.length ? { parameters: params } : {}) };
  return { get, post };
};

/** Build the Swagger 2.0 document PostgREST serves at `/`. */
export const buildOpenApi = (
  cache: SchemaCache,
  schema: string,
  opts: OpenApiOptions,
  context: OpenApiContext = {},
): Json => {
  let host = "localhost";
  let scheme = "http";
  try {
    const u = new URL(opts.serverUrl);
    host = u.host;
    scheme = u.protocol.replace(":", "");
  } catch {
    /* keep defaults */
  }

  const relations = [...cache.relations.values()]
    .filter((r) => r.schema === schema && (!context.accessible || context.accessible.has(r.name)))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const functions = [...cache.functions.values()].flat().filter((f) => f.schema === schema && callable(f));

  const parameters: Json = {
    preferParams: preferParam([]),
    preferReturn: preferParam(["return=representation", "return=minimal", "return=none"]),
    preferCount: preferParam(["count=none"]),
    preferPost: preferParam([
      "return=representation",
      "return=minimal",
      "return=none",
      "resolution=ignore-duplicates",
      "resolution=merge-duplicates",
    ]),
    select: queryParam("select", "Filtering Columns"),
    on_conflict: queryParam("on_conflict", "On Conflict"),
    order: queryParam("order", "Ordering"),
    range: { name: "Range", description: "Limiting and Pagination", required: false, in: "header", type: "string" },
    rangeUnit: {
      name: "Range-Unit",
      description: "Limiting and Pagination",
      required: false,
      in: "header",
      type: "string",
      default: "items",
    },
    offset: queryParam("offset", "Limiting and Pagination"),
    limit: queryParam("limit", "Limiting and Pagination"),
  };
  const paths: Json = {
    "/": {
      get: {
        tags: ["Introspection"],
        summary: "OpenAPI description (this document)",
        produces: ["application/openapi+json", "application/json"],
        responses: { "200": { description: "OK" } },
      },
    },
  };
  const definitions: Json = {};

  for (const rel of relations) {
    // the catalog's own nullability: a view's columns carry none, whatever the table behind it says
    const required = isView(rel) ? [] : rel.columns.filter((c) => !c.nullable).map((c) => c.name);
    definitions[rel.name] = {
      ...(rel.comment ? { description: rel.comment } : {}),
      type: "object",
      ...(rel.columns.length
        ? { properties: Object.fromEntries(rel.columns.map((c) => [c.name, property(cache, rel, c)])) }
        : {}),
      ...(required.length ? { required } : {}),
    };

    parameters[`body.${rel.name}`] = {
      name: rel.name,
      description: rel.name,
      required: false,
      in: "body",
      schema: { $ref: `#/definitions/${rel.name}` },
    };
    const filters = rel.columns.map((c) => {
      const key = `rowFilter.${rel.name}.${c.name}`;
      parameters[key] = {
        name: c.name,
        ...(c.comment ? { description: c.comment } : {}),
        required: false,
        in: "query",
        type: "string",
      };
      return { $ref: `#/parameters/${key}` };
    });
    const ref = (k: string) => ({ $ref: `#/parameters/${k}` });

    const op = { tags: [rel.name], ...split(rel.comment) };
    const item: Json = {
      get: {
        ...op,
        parameters: [
          ...filters,
          ...["select", "order", "range", "rangeUnit", "offset", "limit", "preferCount"].map(ref),
        ],
        responses: {
          "200": { description: "OK", schema: { type: "array", items: { $ref: `#/definitions/${rel.name}` } } },
          "206": { description: "Partial Content" },
        },
      },
    };
    // a relation that can be written at all documents every write (`makePathItem`)
    if (rel.insertable || rel.updatable || rel.deletable) {
      item["post"] = {
        ...op,
        parameters: [ref(`body.${rel.name}`), ref("select"), ref("preferPost")],
        responses: { "201": { description: "Created" } },
      };
      item["patch"] = {
        ...op,
        parameters: [...filters, ref(`body.${rel.name}`), ref("preferReturn")],
        responses: { "204": { description: "No Content" } },
      };
      item["delete"] = {
        ...op,
        parameters: [...filters, ref("preferReturn")],
        responses: { "204": { description: "No Content" } },
      };
    }
    paths[`/${rel.name}`] = item;
  }

  // overloads share a path: the last one read is documented, as in PostgREST's `fromList`
  for (const fn of functions) paths[`/rpc/${fn.name}`] = procPath(fn, opts.searchPath ?? [schema]);

  const { summary: title, description } = split(context.schemaDescription ?? null);
  return {
    swagger: "2.0",
    info: {
      version: VERSION,
      title: title ?? "PostgREST API",
      description: description ?? "This is a dynamic API generated by PostgREST",
    },
    externalDocs: { description: "PostgREST Documentation", url: "https://postgrest.org/en/v16/references/api.html" },
    host,
    basePath: opts.basePath || "/",
    schemes: [scheme],
    consumes: MEDIA_TYPES,
    produces: MEDIA_TYPES,
    paths,
    definitions,
    parameters,
  };
};

/** The SQL of what the document needs per request: the relations the role reaches, and the schema's comment. */
export const ACCESSIBLE_SQL = `SELECT c.relname AS name
  FROM pg_class c
 WHERE c.relkind IN ('v','r','m','f','p') AND c.relnamespace = quote_ident($1::text)::regnamespace
   AND (pg_has_role(c.relowner, 'USAGE')
        OR has_table_privilege(c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
        OR has_any_column_privilege(c.oid, 'SELECT, INSERT, UPDATE, REFERENCES'))
   AND NOT c.relispartition`;
export const SCHEMA_DESCRIPTION_SQL = `SELECT pg_catalog.obj_description(quote_ident($1::text)::regnamespace, 'pg_namespace') AS d`;
