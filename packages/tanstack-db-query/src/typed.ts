// Types only, apart from `tspgClient`: nothing here imports `@tspg/query`, so a browser bundle
// takes the generated `Database` as a type (`import type`) and none of the server's code.
import type { QueryClient } from "@tanstack/query-core";
import { tspgCollectionOptions } from "./collection.ts";
import type { TspgCollectionConfig } from "./collection.ts";

/** What the generated `Database` holds for one table or view (a table, a view…). */
export interface RelationShape {
  row: object;
  pk: readonly string[];
  insertable: boolean;
  updatable: boolean;
  deletable: boolean;
}

/** The generated `Database` type, structurally: schemas, each a map of its tables and views. Relationships are not in it: they are the live queries' joins. */
export interface DatabaseShape {
  default: string;
  schemas: Record<string, Record<string, RelationShape>>;
}

export type SchemaName<Db extends DatabaseShape> = keyof Db["schemas"] & string;
export type RelationName<Db extends DatabaseShape, S extends SchemaName<Db> = Db["default"]> = keyof Db["schemas"][S] &
  string;
type Rel<Db extends DatabaseShape, S extends SchemaName<Db>, T extends RelationName<Db, S>> = Db["schemas"][S][T];

/**
 * The `id` default holds when the primary key is exactly `["id"]`. Any other key has to be named, and
 * must be the table's, unless the client was given the generated `keys`, which know it. A relation
 * without a key (a view) takes whichever columns identify a row.
 */
type PrimaryKeyOption<R extends RelationShape, Keyed extends boolean> = R["pk"] extends readonly ["id"]
  ? { primaryKey?: R["pk"] }
  : R["pk"] extends readonly []
    ? { primaryKey: readonly (keyof R["row"] & string)[] }
    : Keyed extends true
      ? { primaryKey?: R["pk"] }
      : { primaryKey: R["pk"] };

/** A relation `pg_relation_is_updatable` does not accept every write on (a view…) must be `readOnly`. */
type WriteOption<R extends RelationShape> = [R["insertable"], R["updatable"], R["deletable"]] extends [true, true, true]
  ? { readOnly?: boolean }
  : { readOnly: true };

/** Per-collection options of the typed client, checked against the relation's generated type. */
export type TspgTableOptions<R extends RelationShape, Keyed extends boolean = false> = PrimaryKeyOption<R, Keyed> &
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

/**
 * What `generate()` of `@tspg/tanstack-db-query/generate` emits, checked against the generated `Database`: each
 * relation's key columns, and the function that builds a row's key (a composite key's values joined
 * with `_`).
 */
export interface GeneratedKeys<Db extends DatabaseShape> {
  readonly default: Db["default"];
  readonly schemas: {
    readonly [S in SchemaName<Db>]?: {
      readonly [T in RelationName<Db, S>]?: {
        readonly pk: Readonly<Db["schemas"][S][T]["pk"]>;
        readonly key: (row: Db["schemas"][S][T]["row"]) => string | number;
      };
    };
  };
}

/** What every collection of a client shares. */
export interface TspgClientConfig {
  /** Base URL of the API, as mounted by `createRest` (e.g. `/api` or `https://x.dev/api`). */
  url: string;
  queryClient: QueryClient;
  headers?: TspgCollectionConfig["headers"];
  fetch?: typeof fetch;
  syncMode?: "eager" | "on-demand";
}

export interface TspgSchemaClient<Db extends DatabaseShape, S extends SchemaName<Db>, Keyed extends boolean = false> {
  /**
   * Options for `createCollection(...)`, the row type read from the generated type.
   *
   * ```ts
   * const orders = createCollection(tspg.collectionOptions("orders"));
   * ```
   */
  collectionOptions<T extends RelationName<Db, S>>(
    table: T,
    ...options: {} extends TspgTableOptions<Rel<Db, S, T>, Keyed>
      ? [options?: TspgTableOptions<Rel<Db, S, T>, Keyed>]
      : [options: TspgTableOptions<Rel<Db, S, T>, Keyed>]
  ): ReturnType<typeof tspgCollectionOptions<Rel<Db, S, T>["row"]>>;
}

export interface TspgClient<Db extends DatabaseShape, Keyed extends boolean = false> extends TspgSchemaClient<
  Db,
  Db["default"],
  Keyed
> {
  /** Another schema of the API: the requests carry `Accept-Profile` / `Content-Profile`. */
  schema<S extends SchemaName<Db>>(name: S): TspgSchemaClient<Db, S, Keyed>;
}

/**
 * A client typed by the generated `Database`: the tables are the ones that exist, each collection's
 * row is the table's `row`, and the primary key and writability are checked against it.
 *
 * Give it the `keys` that `generate()` (`@tspg/tanstack-db-query/generate`) emits and the key columns, and the code
 * that builds a composite key, come from there instead of being written by hand.
 *
 * ```ts
 * import type { Database } from "./db.generated"; // a type: nothing of it reaches the bundle
 * import { keys } from "./db.keys"; //                the generated key construction
 * const tspg = tspgClient<Database>({ url: "/api", queryClient, keys });
 * const lines = createCollection(tspg.collectionOptions("order_items")); // keyed "12_3", nothing to pass
 * ```
 */
export function tspgClient<Db extends DatabaseShape>(
  config: TspgClientConfig & { keys: GeneratedKeys<Db> },
): TspgClient<Db, true>;
export function tspgClient<Db extends DatabaseShape>(config: TspgClientConfig): TspgClient<Db, false>;
export function tspgClient<Db extends DatabaseShape>(
  config: TspgClientConfig & { keys?: GeneratedKeys<Db> },
): TspgClient<Db, boolean> {
  const { keys, ...shared } = config;
  const forSchema = (schema?: string): TspgSchemaClient<Db, never> => ({
    collectionOptions: ((table: string, options: Record<string, unknown> = {}) => {
      // the generated key construction, unless the caller names the key columns themselves
      const generated =
        options.primaryKey === undefined
          ? (keys?.schemas as Record<string, Record<string, { pk: readonly string[]; key: never }>> | undefined)?.[
              schema ?? keys?.default ?? ""
            ]?.[table]
          : undefined;
      return tspgCollectionOptions({
        ...shared,
        ...(schema ? { schema } : {}),
        ...(generated ? { primaryKey: generated.pk, getKey: generated.key } : {}),
        ...options,
        table,
      });
    }) as never,
  });
  return { ...forSchema(), schema: (name) => forSchema(name) as never } as TspgClient<Db, boolean>;
}
