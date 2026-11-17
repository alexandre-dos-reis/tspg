import { queryCollectionOptions } from "@tanstack/query-db-collection";
import type { QueryCollectionConfig, QueryCollectionUtils } from "@tanstack/query-db-collection";
import type { CollectionConfig } from "@tanstack/db";
import type { QueryClient } from "@tanstack/query-core";
import { buildQuery, keyFilter, TspgError } from "./postgrest.ts";
import type { BuildQueryOptions } from "./postgrest.ts";
import type { DatabaseShape, RelationName, SchemaName } from "./typed.ts";

/** Row type of a relation, read from the generated `Database` type (a type-only import). */
export type TspgRow<
  Db extends DatabaseShape,
  Table extends RelationName<Db, S>,
  S extends SchemaName<Db> = Db["default"],
> = Db["schemas"][S][Table]["row"];

/**
 * A standard schema (https://standardschema.dev) that checks nothing, to carry the type of what `insert()`
 * takes (`Insert`) apart from the type of what the collection holds (`Row`).
 */
export interface InsertSchema<Insert, Row> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => { readonly value: Row };
    readonly types?: { readonly input: Insert; readonly output: Row } | undefined;
  };
}
/**
 * What `createCollection(...)` takes, spelled out: an explicit type, so that nothing in the published
 * declarations needs a recent TypeScript (an instantiation expression such as `ReturnType<typeof f<T>>`
 * reads as `any` to an older language server).
 */
export type TspgCollectionOptions<Row extends object, Insert extends object = Row> = Omit<
  CollectionConfig<Row, string | number, never, QueryCollectionUtils<Row, string | number, Row, unknown>>,
  "schema" | "getKey" | "utils"
> & {
  getKey: (row: Row) => string | number;
  schema: InsertSchema<Insert, Row>;
  utils: QueryCollectionUtils<Row, string | number, Row, unknown>;
};

const passThrough = {
  "~standard": { version: 1, vendor: "tspg", validate: (value: unknown) => ({ value }) },
};

type HeadersInit_ = Record<string, string>;

/** What identifies a row: its primary key columns, and the collection key made of them. */
export interface TspgKey<Row> {
  readonly pk: readonly string[];
  /** Key columns the database makes up (an identity): the client's value is a placeholder, kept out of the POST. */
  readonly generated?: readonly string[];
  readonly key: (row: Row) => string | number;
}

export interface TspgCollectionConfig<Row extends object = object> extends BuildQueryOptions {
  /** Base URL of the PostgREST API (e.g. `/api` or `https://x.dev/api`). */
  url: string;
  /** Table or view name. */
  table: string;
  queryClient: QueryClient;
  /**
   * The key of a row, as `generate()` (`@tspg/tanstack-db-postgrest/generate`) writes it from the database's
   * primary key: its columns, which the writes filter on, and the function that builds the collection
   * key from a row. Through `tspgClient` it is looked up for you.
   */
  key: TspgKey<Row>;
  /** Schema, sent as `Accept-Profile` / `Content-Profile` (when not the API's default). */
  schema?: string;
  /** Static or per-request headers: `Authorization`, API keys… */
  headers?: HeadersInit_ | (() => HeadersInit_ | Promise<HeadersInit_>);
  fetch?: typeof fetch;
  /**
   * `"eager"` (default, as in TanStack DB) loads the whole table; `"on-demand"` pushes live-query predicates to
   * the server and loads only what they ask for.
   */
  syncMode?: "eager" | "on-demand";
  /** Make the collection read-only. */
  readOnly?: boolean;
  /** Forwarded to TanStack Query / the collection. */
  staleTime?: number;
  gcTime?: number;
  refetchInterval?: number;
}

/**
 * Options for `createCollection(...)`: a TanStack DB collection mapped onto one
 * PostgREST-compatible table. Live-query `where` / `orderBy` / `limit` become
 * `col=op.value`, `order=` and `limit=`; inserts, updates and deletes become
 * POST, PATCH and DELETE keyed by the primary key.
 *
 * Internal: the public entry is `tspgClient`, which supplies `key` from the generated module.
 */
export function tspgCollectionOptions<Row extends object, Insert extends object = Row>(
  config: TspgCollectionConfig<Row>,
) {
  const pk = config.key.pk;
  const base = `${config.url.replace(/\/+$/, "")}/${encodeURIComponent(config.table)}`;
  const doFetch = config.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const syncMode = config.syncMode ?? "eager";

  async function request(
    method: string,
    qs: string,
    opts: { body?: unknown; prefer?: string; signal?: AbortSignal } = {},
  ): Promise<{ status: number; data: unknown }> {
    const extra = typeof config.headers === "function" ? await config.headers() : (config.headers ?? {});
    const headers: HeadersInit_ = { Accept: "application/json", ...extra };
    if (config.schema) headers[method === "GET" ? "Accept-Profile" : "Content-Profile"] = config.schema;
    if (opts.prefer) headers.Prefer = opts.prefer;
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    const res = await doFetch(qs ? `${base}?${qs}` : base, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
    });
    if (!res.ok) {
      const e = (await res.json().catch(() => ({}))) as Record<string, string | null>;
      throw new TspgError(res.status, e.code ?? undefined, e.message ?? res.statusText, e.details, e.hint);
    }
    const text = await res.text();
    return { status: res.status, data: text ? JSON.parse(text) : undefined };
  }

  // A write asks for the row back (`Prefer: return=representation`) and the collection takes that row as it is:
  // there is no refetch. So the row has to come back: a write that returns fewer rows than it made (a PATCH that
  // matched nothing, a row a policy hides) is an error, and the optimistic change is rolled back.
  const columns = config.select ? `select=${encodeURIComponent(config.select)}` : "";
  async function write(method: "POST" | "PATCH", qs: string, body: unknown, expected: number): Promise<Row[]> {
    const { status, data } = await request(method, [qs, columns].filter(Boolean).join("&"), {
      body,
      prefer: "return=representation",
    });
    const rows = Array.isArray(data) ? (data as Row[]) : [];
    if (rows.length !== expected) {
      throw new TspgError(
        status,
        "TSPG_NO_ROW",
        `${method} ${config.table}: expected ${expected} row(s) back, got ${rows.length}`,
        "the write did not return the row: it matched nothing, or the API hides it from the caller",
      );
    }
    return rows;
  }

  const writable = !config.readOnly;

  const options = queryCollectionOptions<Row>({
    queryClient: config.queryClient,
    syncMode,
    staleTime: config.staleTime,
    gcTime: config.gcTime,
    refetchInterval: config.refetchInterval,
    // One cache entry per distinct subset, so predicates never collide.
    // The key of an empty subset is the prefix of every other one, as TanStack DB requires.
    queryKey: (subset) => {
      const root = buildQuery(undefined, config);
      const full = buildQuery(subset, config);
      return full === root
        ? [config.table, config.schema ?? "", root]
        : [config.table, config.schema ?? "", root, full];
    },
    queryFn: async (ctx) => {
      const subset = ctx.meta?.loadSubsetOptions as Parameters<typeof buildQuery>[0];
      return (await request("GET", buildQuery(subset, config), { signal: ctx.signal })).data as Row[];
    },
    getKey: config.key.key,
    ...(writable && {
      onInsert: async ({ transaction, collection }) => {
        const omit = new Set(config.key.generated);
        const rows = transaction.mutations.map((m) =>
          Object.fromEntries(Object.entries(m.modified).filter(([k]) => !omit.has(k))),
        );
        const out = await write("POST", "", rows, rows.length);
        collection.utils.writeBatch(() => out.forEach((r) => collection.utils.writeUpsert(r)));
      },
      onUpdate: async ({ transaction, collection }) => {
        const out = await Promise.all(
          transaction.mutations.map((m) =>
            write("PATCH", keyFilter(pk, m.original as Record<string, unknown>).toString(), m.changes, 1),
          ),
        );
        collection.utils.writeBatch(() => out.flat().forEach((r) => collection.utils.writeUpsert(r)));
      },
      onDelete: async ({ transaction, collection }) => {
        await Promise.all(
          transaction.mutations.map((m) =>
            request("DELETE", keyFilter(pk, m.original as Record<string, unknown>).toString()),
          ),
        );
        collection.utils.writeBatch(() =>
          transaction.mutations.forEach((m) => collection.utils.writeDelete(m.key as string | number)),
        );
      },
    }),
  } as QueryCollectionConfig<Row>);

  // `insert()` is typed by the schema's input, and a collection without a schema takes its row there. The
  // generated `insert` shape (a key to hold the row by, the columns the database fills left out) is what a
  // client may give, so it goes in as the input of a schema that passes everything through.
  return { ...options, schema: passThrough } as unknown as TspgCollectionOptions<Row, Insert>;
}
