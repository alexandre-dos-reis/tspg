import { queryCollectionOptions } from "@tanstack/query-db-collection";
import type { QueryCollectionConfig } from "@tanstack/query-db-collection";
import type { QueryClient } from "@tanstack/query-core";
import { buildQuery, keyFilter, TspgRestError } from "./postgrest.ts";
import type { BuildQueryOptions } from "./postgrest.ts";

export { buildQuery, keyFilter, TspgRestError } from "./postgrest.ts";

/** Row type of a relation, read from a `@tspg/query` generated `Database` type. */
export type TspgRow<
  Db extends { default: string; schemas: Record<string, { relations: Record<string, { row: object }> }> },
  Table extends keyof Db["schemas"][Db["default"]]["relations"],
> = Db["schemas"][Db["default"]]["relations"][Table]["row"];

type HeadersInit_ = Record<string, string>;

export interface TspgCollectionConfig extends BuildQueryOptions {
  /** Base URL of the API, as mounted by `createRest` (e.g. `/api` or `https://x.dev/api`). */
  url: string;
  /** Table or view name. */
  table: string;
  queryClient: QueryClient;
  /** Primary key column(s). Default `"id"`. */
  primaryKey?: string | readonly string[];
  /** Schema, sent as `Accept-Profile` / `Content-Profile` (when not the API's default). */
  schema?: string;
  /** Static or per-request headers: `Authorization`, API keys… */
  headers?: HeadersInit_ | (() => HeadersInit_ | Promise<HeadersInit_>);
  fetch?: typeof fetch;
  /**
   * `"on-demand"` (default) pushes live-query predicates to the server; `"eager"` loads the whole table.
   * (TanStack DB's own default is `"eager"`. `"progressive"` is not offered by the Query collection.)
   */
  syncMode?: "eager" | "on-demand";
  /**
   * Columns left out of the `POST` body, for ones the database generates
   * (`GENERATED ALWAYS AS IDENTITY`, a trigger…). TanStack DB still needs a
   * key for the optimistic row: give it a temporary one, and the refetch that
   * follows the write replaces it with the server's.
   */
  omitOnInsert?: readonly string[];
  /** Make the collection read-only. */
  readOnly?: boolean;
  /**
   * After a write: `"refetch"` (default) re-reads from the server, `"direct"`
   * writes the representation the server returned (saves a round trip, but
   * needs the row to still match the collection's active subsets).
   */
  afterWrite?: "refetch" | "direct";
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
 * ```ts
 * const todos = createCollection(
 *   tspgCollectionOptions<TspgRow<Database, "todos">>({
 *     url: "/api", table: "todos", queryClient,
 *   }),
 * );
 * ```
 */
export function tspgCollectionOptions<Row extends object>(config: TspgCollectionConfig) {
  const pk = typeof config.primaryKey === "string" ? [config.primaryKey] : (config.primaryKey ?? ["id"]);
  const base = `${config.url.replace(/\/+$/, "")}/${encodeURIComponent(config.table)}`;
  const doFetch = config.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const syncMode = config.syncMode ?? "on-demand";

  async function request(
    method: string,
    qs: string,
    opts: { body?: unknown; prefer?: string; signal?: AbortSignal } = {},
  ): Promise<unknown> {
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
      throw new TspgRestError(res.status, e.code ?? undefined, e.message ?? res.statusText, e.details, e.hint);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : undefined;
  }

  const direct = config.afterWrite === "direct";
  const writable = !config.readOnly;

  return queryCollectionOptions<Row>({
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
      return (await request("GET", buildQuery(subset, config), { signal: ctx.signal })) as Row[];
    },
    getKey: (row) => {
      const r = row as Record<string, unknown>;
      return (pk.length === 1 ? r[pk[0]!] : JSON.stringify(pk.map((k) => r[k]))) as string | number;
    },
    ...(writable && {
      onInsert: async ({ transaction, collection }) => {
        const omit = new Set(config.omitOnInsert);
        const rows = transaction.mutations.map((m) =>
          Object.fromEntries(Object.entries(m.modified).filter(([k]) => !omit.has(k))),
        );
        const out = (await request("POST", "", { body: rows, prefer: "return=representation" })) as Row[];
        if (direct) await collection.utils.writeBatch(() => out.forEach((r) => collection.utils.writeUpsert(r)));
        else await collection.utils.refetch();
      },
      onUpdate: async ({ transaction, collection }) => {
        const out = await Promise.all(
          transaction.mutations.map((m) =>
            request("PATCH", keyFilter(pk, m.original as Record<string, unknown>).toString(), {
              body: m.changes,
              prefer: "return=representation",
            }),
          ),
        );
        if (direct)
          await collection.utils.writeBatch(() => out.flat().forEach((r) => collection.utils.writeUpsert(r as Row)));
        else await collection.utils.refetch();
      },
      onDelete: async ({ transaction, collection }) => {
        await Promise.all(
          transaction.mutations.map((m) =>
            request("DELETE", keyFilter(pk, m.original as Record<string, unknown>).toString()),
          ),
        );
        if (direct) {
          await collection.utils.writeBatch(() =>
            transaction.mutations.forEach((m) => collection.utils.writeDelete(m.key as string | number)),
          );
        } else await collection.utils.refetch();
      },
    }),
  } as QueryCollectionConfig<Row>);
}
