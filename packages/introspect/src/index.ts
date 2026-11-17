import type { DbSession } from "@tspg/adapters";
import { readCatalog } from "./catalog";
import type { SchemaCache } from "./model";

export { readCatalog } from "./catalog";
export { compositeOf, fromDescriptor, relKey, toDescriptor } from "./model";
export type {
  Column,
  CompositeAttribute,
  CompositeRef,
  CompositeType,
  ForeignKey,
  FunctionArg,
  FunctionDef,
  MediaHandler,
  Relation,
  RelationKind,
  SchemaCache,
  SchemaDescriptor,
} from "./model";
export { cString, literal } from "./quote";
export { columnType, IDENTIFIER, tsKey } from "./types";
export type { CompositeNamer } from "./types";
export type { DbAdapter, DbSession, Row } from "@tspg/adapters";

/** What {@link introspect} reads the catalog through. */
export interface IntrospectOptions {
  /** A driver adapter: `@tspg/introspect/adapters/node-postgres`, `…/pglite`, `…/postgres-js`, `…/bun`. */
  readonly db: DbSession;
  /** The schemas to read. Default `["public"]`. */
  readonly schemas?: ReadonlyArray<string> | undefined;
}

/**
 * Read the database catalog -- tables, views, columns, keys, enums, composite types, functions -- into
 * a {@link SchemaCache}: the structured description a code generator turns into types, keys, a
 * schema descriptor, or whatever a library needs from the database. A generator takes it, along
 * with {@link columnType} for the SQL type → TypeScript type mapping.
 *
 * ```ts
 * import { introspect } from "@tspg/introspect";
 * import { nodePostgresAdapter } from "@tspg/introspect/adapters/node-postgres";
 * const cache = await introspect({ db: nodePostgresAdapter(pool), schemas: ["api"] });
 * ```
 */
export const introspect = (options: IntrospectOptions): Promise<SchemaCache> =>
  readCatalog(options.db, options.schemas?.length ? options.schemas : ["public"]);
