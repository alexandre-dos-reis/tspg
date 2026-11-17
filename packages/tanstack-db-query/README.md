# @tspg/tanstack-db-query

TanStack DB collections over a PostgREST-compatible API (`@tspg/rest`, PostgREST, Supabase).

```sh
npm i @tspg/tanstack-db-query @tanstack/db @tanstack/query-db-collection @tanstack/query-core
```

```ts
import { QueryClient } from "@tanstack/query-core";
import { createCollection } from "@tanstack/db";
import { tspgClient } from "@tspg/tanstack-db-query";
import { type Database, keys } from "./db"; // written by `@tspg/tanstack-db-query/generate`, below

const queryClient = new QueryClient();

const tspg = tspgClient<Database>({
  url: "/api", // where createRest's handle() is mounted
  queryClient,
  keys,
  headers: async () => ({ Authorization: `Bearer ${await token()}` }),
});

export const todos = createCollection(tspg.collectionOptions("todos")); // the row type and the key come from the database
```

## Types and keys from the database

`@tspg/tanstack-db-query/generate` reads the catalog and writes one module with nothing but what a client needs: a
`Database` type (each table's `row`, `insert` and `update` shapes, primary key, and whether it can be written) and
`keys`, which holds each table's primary key columns and the code that builds a row's key — the value for one column,
a composite key's values joined with `_` (`12_3`). It has no imports of its own: the type is erased from the bundle
and `keys` is a few functions. The generator runs on Node, at build time, and is the only part that touches the
database; it is built on [`@tspg/introspect`](../introspect/README.md), so it needs no other `@tspg` package.

```ts ignore
import { writeFileSync } from "node:fs";
import { Pool } from "pg";
import { generate } from "@tspg/tanstack-db-query/generate";
import { nodePostgresAdapter } from "@tspg/introspect/adapters/node-postgres"; // or …/pglite, …/postgres-js, …/bun

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
writeFileSync("src/db.ts", await generate({ db: nodePostgresAdapter(pool), schemas: ["api"] }));
await pool.end();
```

Regenerate it after a migration. `name`, `keysName` and `header` are options; a composite-type column is typed
`unknown`. Relationships are not in it: joins are the live queries'.

```ts
import { createCollection } from "@tanstack/db";
import { tspgClient } from "@tspg/tanstack-db-query";
import { type Database, keys } from "./db"; // the type is erased at build time; keys is the key construction

const tspg = tspgClient<Database>({ url: "/api", queryClient, keys });

const orders = createCollection(tspg.collectionOptions("orders")); // rows are typed
const lines = createCollection(tspg.collectionOptions("order_items")); // keyed "12_3": nothing to pass
const things = createCollection(tspg.schema("v2").collectionOptions("things")); // Accept-Profile: v2
```

The compiler checks what the types know:

- the table is one that exists, in the schema chosen (`schema("v2")` for the others), and the row is its `row`;
- the primary key is never given: `keys` holds each table's key columns and the code that builds a row's key, and has
  to match the `Database` (a table's key columns are the ones its type says);
- a relation that cannot take every write (a view) needs `readOnly: true`, and a view, which has no primary key to
  generate, names the columns that identify a row (`keyColumns`);
- `omitOnInsert` and `filters` take column names.

## SSR

TanStack DB's [SSR](https://tanstack.com/db/latest/docs/guides/ssr) (`DbClient`, `dehydrate()` / `hydrate()`) works with these collections: wrap the options in `collectionOptions(id, factory)`, and the server preloads while the browser hydrates the rows.

```ts ignore
import { QueryClient } from "@tanstack/query-core";
import { collectionOptions } from "@tanstack/db";
import { tspgClient } from "@tspg/tanstack-db-query";
import { type Database, keys } from "./db";

export const todos = collectionOptions("todos", () =>
  tspgClient<Database>({
    url: process.env.API_URL!, // absolute on the server: there is no page to resolve `/api` against
    queryClient: new QueryClient(), // inside the factory: one per `DbClient`, so one per request
    keys,
  }).collectionOptions("todos"),
);
```

- Give the collection a stable `id` that carries every dynamic parameter (a schema, a tenant, a filter in `filters`).
- Build the `QueryClient` inside the factory, and `headers` / `fetch` too when they depend on the request (a cookie, a token).
- Both sync modes are tested: `eager` rows are dehydrated with the collection, `on-demand` ones with the live queries that were preloaded (`dbClient.preloadLiveQuery`).
- Hydrated rows are provisional: the collection still syncs once in the browser. TanStack DB's own limits apply
  (mutation handlers and pending mutations are not serialized; Vue, Solid and Angular have no SSR provider yet).

## Sync modes

The package is built on TanStack DB's Query collection (`@tanstack/query-db-collection`), so it offers the modes
that collection has:

| `syncMode`                   |                                                                                           |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| `"on-demand"` (default here) | loads only what live queries ask for; their predicates are pushed to the server, as below |
| `"eager"`                    | loads the whole table once and filters in memory: for small, mostly static tables         |

TanStack DB's own default is `eager`; this package defaults to `on-demand`, which is what a PostgREST API is good at.
`"progressive"` (a subset first, the full table in the background) is not offered by the Query collection, so it is not
available here.

In `on-demand` mode, live-query predicates are pushed to the server. Every TanStack DB operator is
handled: either translated, or left to TanStack DB, which always re-applies the full `where` locally.

| TanStack DB                                                                                           | PostgREST                                                                  |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `eq gt gte lt lte` (column vs value, either way round)                                                | `col=eq.x`, `col=gt.x`…                                                    |
| `in`                                                                                                  | `col=in.(1,2)`                                                             |
| `like`, `ilike`                                                                                       | `col=like.x`, `col=ilike.x`                                                |
| `isNull`, `isUndefined`, `eq(col, null)`                                                              | `col=is.null`                                                              |
| boolean column as predicate                                                                           | `col=is.true`                                                              |
| `and` / `or` / `not`                                                                                  | repeated params / `or=(…)` / negation pushed down, keeping NULL rows       |
| `eq(lower(col), "x")`, `eq(upper(col), "X")`                                                          | `col=ilike.x` (escaped)                                                    |
| `coalesce(col, d)` compared to a constant                                                             | `col=op.x`, plus `col=is.null` when `d` satisfies it                       |
| `orderBy` on columns                                                                                  | `order=col.desc.nullsfirst`                                                |
| `limit`, `offset`, cursor `whereFrom`                                                                 | `limit`, `offset`, extra filter                                            |
| `length`, `concat`, `add`, `subtract`, `multiply`, `divide`, `caseWhen`, aggregates, column-to-column | not expressible: the predicate is dropped (superset), filtered client-side |

When any part of `where` is dropped, or `orderBy` is an expression, a custom comparator or an explicit locale,
`limit`/`offset` are **not** sent either (a page of a wider set is not the page asked for); TanStack DB then
paginates locally. String order otherwise follows your database collation.

Writes: `insert` → `POST` (array body; `omitOnInsert: ["id"]` for database-generated columns), `update` → `PATCH ?pk=eq.x` (changed columns only),
`delete` → `DELETE ?pk=eq.x`, then a refetch (`afterWrite: "direct"` writes the returned representation instead).
Errors surface as `TspgRestError` (`status`, `code`, `message`, `details`, `hint`).

Relations are not mapped: join collections with TanStack DB live queries instead of PostgREST embeds.
Cursor ties are not re-fetched (only `cursor.whereFrom` is used). PostgREST-only operators (FTS, `cs`, `ov`…) have no TanStack DB counterpart.
