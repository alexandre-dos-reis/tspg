// Types only, apart from `tspgClient`: nothing here imports `@tspg/query`, so a browser bundle
// takes the generated `Database` as a type (`import type`) and none of the server's code.
import type { QueryClient } from "@tanstack/query-core";
import { tspgCollectionOptions } from "./collection.ts";
import type { TspgCollectionConfig } from "./collection.ts";

/** What `generateTypes()` of `@tspg/query` emits for one relation (a table, a view…). */
export interface RelationShape {
  row: object;
  pk: readonly string[];
  insertable: boolean;
  updatable: boolean;
  deletable: boolean;
}

/** The generated `Database` type, structurally: any of them fits, whatever its name. */
export interface DatabaseShape {
  default: string;
  schemas: Record<string, { relations: Record<string, RelationShape> }>;
}

export type SchemaName<Db extends DatabaseShape> = keyof Db["schemas"] & string;
export type RelationName<
  Db extends DatabaseShape,
  S extends SchemaName<Db> = Db["default"],
> = keyof Db["schemas"][S]["relations"] & string;
type Rel<
  Db extends DatabaseShape,
  S extends SchemaName<Db>,
  T extends RelationName<Db, S>,
> = Db["schemas"][S]["relations"][T];

/**
 * The `id` default holds when the primary key is exactly `["id"]`; any other key has to be named, and
 * must be the table's. A relation without a key (a view) takes whichever columns identify a row.
 */
type PrimaryKeyOption<R extends RelationShape> = R["pk"] extends readonly ["id"]
  ? { primaryKey?: R["pk"] }
  : R["pk"] extends readonly []
    ? { primaryKey: readonly (keyof R["row"] & string)[] }
    : { primaryKey: R["pk"] };

/** A relation `pg_relation_is_updatable` does not accept every write on (a view…) must be `readOnly`. */
type WriteOption<R extends RelationShape> = [R["insertable"], R["updatable"], R["deletable"]] extends [true, true, true]
  ? { readOnly?: boolean }
  : { readOnly: true };

/** Per-collection options of the typed client, checked against the relation's generated type. */
export type TspgTableOptions<R extends RelationShape> = PrimaryKeyOption<R> &
  WriteOption<R> & {
    /** Columns the database generates, left out of the `POST` body. */
    omitOnInsert?: readonly (keyof R["row"] & string)[];
    select?: string;
    filters?: Partial<Record<keyof R["row"] & string, string>>;
    afterWrite?: "refetch" | "direct";
    staleTime?: number;
    gcTime?: number;
    refetchInterval?: number;
    syncMode?: "eager" | "on-demand";
  };

/** What every collection of a client shares. */
export interface TspgClientConfig {
  /** Base URL of the API, as mounted by `createRest` (e.g. `/api` or `https://x.dev/api`). */
  url: string;
  queryClient: QueryClient;
  headers?: TspgCollectionConfig["headers"];
  fetch?: typeof fetch;
  syncMode?: "eager" | "on-demand";
}

export interface TspgSchemaClient<Db extends DatabaseShape, S extends SchemaName<Db>> {
  /**
   * Options for `createCollection(...)`, the row type read from the generated type.
   *
   * ```ts
   * const orders = createCollection(tspg.collectionOptions("orders"));
   * ```
   */
  collectionOptions<T extends RelationName<Db, S>>(
    table: T,
    ...options: {} extends TspgTableOptions<Rel<Db, S, T>>
      ? [options?: TspgTableOptions<Rel<Db, S, T>>]
      : [options: TspgTableOptions<Rel<Db, S, T>>]
  ): ReturnType<typeof tspgCollectionOptions<Rel<Db, S, T>["row"]>>;
}

export interface TspgClient<Db extends DatabaseShape> extends TspgSchemaClient<Db, Db["default"]> {
  /** Another schema of the API: the requests carry `Accept-Profile` / `Content-Profile`. */
  schema<S extends SchemaName<Db>>(name: S): TspgSchemaClient<Db, S>;
}

/**
 * A client typed by the generated `Database`: the tables are the ones that exist, each collection's
 * row is the table's `row`, and the primary key and writability are checked against it.
 *
 * ```ts
 * import type { Database } from "./db.generated"; // a type: nothing of it reaches the bundle
 * const tspg = tspgClient<Database>({ url: "/api", queryClient });
 * const todos = createCollection(tspg.collectionOptions("todos"));
 * const lines = createCollection(tspg.collectionOptions("order_items", { primaryKey: ["order_id", "product_id"] }));
 * ```
 */
export function tspgClient<Db extends DatabaseShape>(config: TspgClientConfig): TspgClient<Db> {
  const forSchema = (schema?: string): TspgSchemaClient<Db, never> => ({
    collectionOptions: ((table: string, options: Record<string, unknown> = {}) =>
      tspgCollectionOptions({ ...config, ...(schema ? { schema } : {}), ...options, table })) as never,
  });
  return { ...forSchema(), schema: (name) => forSchema(name) as never } as TspgClient<Db>;
}
