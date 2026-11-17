// Types only, apart from `tspgClient`: nothing here imports the database or any server code, so a browser bundle
// takes the generated `Database` as a type (`import type`) and none of the server's code.
import type { QueryClient } from "@tanstack/query-core";
import { tspgCollectionOptions } from "./collection.ts";
import type { TspgCollectionConfig, TspgCollectionOptions } from "./collection.ts";
import { compositeKey } from "./postgrest.ts";

/** What the generated `Database` holds for one table or view (a table, a view…). */
export interface RelationShape {
  row: object;
  insert: object;
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
 * The key comes from the generated `keys`, so there is nothing to give. A relation without a primary key
 * (a view) has none to generate: it names the columns that identify a row.
 */
type KeyOption<R extends RelationShape> = R["pk"] extends readonly []
  ? { keyColumns: readonly (keyof R["row"] & string)[] }
  : {};

/** A relation `pg_relation_is_updatable` does not accept every write on (a view…) must be `readOnly`. */
type WriteOption<R extends RelationShape> = [R["insertable"], R["updatable"], R["deletable"]] extends [true, true, true]
  ? { readOnly?: boolean }
  : { readOnly: true };

/** Per-collection options of the typed client, checked against the relation's generated type. */
export type TspgTableOptions<R extends RelationShape> = KeyOption<R> &
  WriteOption<R> & {
    select?: string;
    filters?: Partial<Record<keyof R["row"] & string, string>>;
    afterWrite?: "refetch" | "direct";
    staleTime?: number;
    gcTime?: number;
    refetchInterval?: number;
    syncMode?: "eager" | "on-demand";
  };

/**
 * What `generate()` of `@tspg/tanstack-db-postgrest/generate` emits, checked against the generated `Database`: each
 * relation's key columns, and the function that builds a row's key (a composite key's values joined
 * with `_`).
 */
export interface GeneratedKeys<Db extends DatabaseShape> {
  readonly default: Db["default"];
  readonly schemas: {
    readonly [S in SchemaName<Db>]: {
      // a relation without a primary key (a view) has none to generate
      readonly [T in RelationName<Db, S> as Db["schemas"][S][T]["pk"] extends readonly [] ? never : T]: {
        readonly pk: Readonly<Db["schemas"][S][T]["pk"]>;
        readonly generated: readonly string[];
        readonly key: (row: Db["schemas"][S][T]["row"]) => string | number;
      };
    };
  };
}

/** What every collection of a client shares. */
export interface TspgClientConfig {
  /** Base URL of the PostgREST API (e.g. `/api` or `https://x.dev/api`). */
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
  ): TspgCollectionOptions<Rel<Db, S, T>["row"], Rel<Db, S, T>["insert"]>;
}

export interface TspgClient<Db extends DatabaseShape> extends TspgSchemaClient<Db, Db["default"]> {
  /** Another schema of the API: the requests carry `Accept-Profile` / `Content-Profile`. */
  schema<S extends SchemaName<Db>>(name: S): TspgSchemaClient<Db, S>;
}

/**
 * A client typed by the generated `Database`: the tables are the ones that exist, each collection's
 * row is the table's `row`, and writability is checked against it. The primary key is not given: the
 * generated `keys` hold each table's key columns and the code that builds a row's key (a composite
 * key's values joined with `_`), and are checked against the `Database`.
 *
 * ```ts
 * import { type Database, keys } from "./db"; // what `generate()` wrote: the type is erased from the bundle
 * const tspg = tspgClient<Database>({ url: "/api", queryClient, keys });
 * const lines = createCollection(tspg.collectionOptions("order_items")); // keyed "12_3", nothing to pass
 * ```
 */
export function tspgClient<Db extends DatabaseShape>(
  config: TspgClientConfig & { keys: GeneratedKeys<Db> },
): TspgClient<Db> {
  const { keys, ...shared } = config;
  const forSchema = (schema?: string): TspgSchemaClient<Db, never> => ({
    collectionOptions: ((table: string, options: Record<string, unknown> = {}) => {
      const { keyColumns, ...rest } = options as { keyColumns?: readonly string[] } & Record<string, unknown>;
      const entry = (
        keys.schemas as Record<string, Record<string, { pk: readonly string[]; key: (row: never) => string | number }>>
      )[schema ?? keys.default]?.[table];
      // a relation without a primary key (a view) names the columns that identify a row
      const key =
        entry ??
        (keyColumns
          ? { pk: keyColumns, key: (row: Record<string, unknown>) => compositeKey(keyColumns, row) }
          : undefined);
      if (!key) throw new Error(`tspg: no key for "${table}": regenerate the keys, or give keyColumns`);
      return tspgCollectionOptions({
        ...shared,
        ...(schema ? { schema } : {}),
        ...rest,
        key: key as never,
        table,
      });
    }) as never,
  });
  return { ...forSchema(), schema: (name) => forSchema(name) as never } as TspgClient<Db>;
}
