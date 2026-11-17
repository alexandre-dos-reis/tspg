# @tspg/introspect

Read a Postgres catalog into a structured description — tables, views, columns, primary and foreign keys, enums,
composite types, functions — for code generators. It is **read-only** (it only queries the catalog) and has no
generator of its own: each library writes the output it needs on top of it. `@tspg/rest` and `@tspg/query` use it, and so
does [`@tspg/tanstack-db-postgrest/generate`](../tanstack-db-postgrest/README.md).

```sh
npm i @tspg/introspect pg
```

```ts ignore
import { Pool } from "pg";
import { columnType, introspect } from "@tspg/introspect";
import { nodePostgresAdapter } from "@tspg/introspect/adapters/node-postgres"; // or …/pglite, …/postgres-js, …/bun

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const cache = await introspect({ db: nodePostgresAdapter(pool), schemas: ["api"] }); // default ["public"]

for (const rel of cache.relations.values()) {
  console.log(rel.schema, rel.name, rel.kind, "pk:", rel.pk);
  for (const col of rel.columns) console.log(" ", col.name, columnType(col), col.nullable ? "| null" : "");
}
```

## What it gives

- `introspect({ db, schemas? })` → a `SchemaCache`: `relations` (columns, `pk`, `uniques`, `kind`, whether it is
  insertable / updatable / deletable), `foreignKeys`, `composites`, `functions`, the `schemas` read (enum labels sit on their columns).
- `columnType(column, compositeName?)`: the SQL type → TypeScript type mapping (enum labels, arrays and composites
  included; anything unknown is `unknown`). `tsKey(name)` quotes an object key when it has to be, `IDENTIFIER` tests one.
- `toDescriptor` / `fromDescriptor`: a `SchemaCache` as plain JSON and back, to ship it instead of reading it.
- `relKey(schema, name)`, `compositeOf(...)`, `cString`, `literal`: the small helpers the above are built from.
- Adapters for `pg`, `postgres`, `@electric-sql/pglite` and Bun's SQL: `@tspg/introspect/adapters/*`. The drivers are
  optional peer dependencies: install the one you use. Any object with the `DbSession` shape works as `db`.

Nothing here connects on its own, writes to the database, or imports another `@tspg` package at runtime.
