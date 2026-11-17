# @tspg/tanstack-db-postgrest

TanStack DB collections over a [PostgREST](https://postgrest.org) API: PostgREST itself, Supabase, or any compatible
server. The collections talk to the API over HTTP; only the generator reads the database, to know its tables and keys.

```sh
npm i @tspg/tanstack-db-postgrest @tanstack/db @tanstack/query-db-collection @tanstack/query-core
```

## 1. Generate the module from the database

`@tspg/tanstack-db-postgrest/generate` reads the catalog and writes one module with everything a client needs from the
database. It is required: the primary key and the row types are never written by hand.

```ts ignore
import { writeFileSync } from "node:fs";
import { Pool } from "pg";
import { generate } from "@tspg/tanstack-db-postgrest/generate";
import { nodePostgresAdapter } from "@tspg/introspect/adapters/node-postgres"; // or …/pglite, …/postgres-js, …/bun

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
writeFileSync("src/db.ts", await generate({ db: nodePostgresAdapter(pool), schemas: ["api"] }));
await pool.end();
```

The module holds:

- a `Database` type: each table's `row` and `insert` shapes, primary key, and whether it can be written;
- `keys`: each table's primary key columns and the code that builds a row's key — the value for one column, a
  composite key's values joined with `_` (`12_3`);

The generator runs on Node, at build time, and is the only part that touches the database; it is built on
[`@tspg/introspect`](../introspect/README.md), so it needs no other `@tspg` package. The module imports nothing and holds
no schema: only types and keys reach the bundle. Regenerate it after a
migration. `name`, `keysName` and `header` are options. A composite-type column is typed `unknown`, and relationships are not in it: joins
are the live queries'.

### What `insert` takes

`collection.insert()` takes the `insert` shape, and reads are typed by `row`.

- A column with a default, or that accepts NULL, is optional: give it to choose the value, leave it out and the
  database fills it. What is not given is not sent.
- A column the database refuses a value for (a stored generated column, an `ALWAYS` identity) is not in it.
- The primary key is required, even when the database makes its own: the collection keeps rows by key, so the
  optimistic row needs one at once. For a key the database makes up (an identity, a sequence) it is a placeholder, and
  the client keeps it out of the request (`keys` lists those columns as `generated`). A key the client can make (a
  `uuid`) is sent as given.
- An optimistic row holds only what was inserted until the server's row comes back (it replaces the optimistic one, no refetch) with the database's own columns, so a live query
  that filters on a defaulted column does not see the row until then: give that column in the insert.

## 2. Use it

```ts
import { QueryClient } from "@tanstack/query-core";
import { createCollection } from "@tanstack/db";
import { tspgClient } from "@tspg/tanstack-db-postgrest";
import { type Database, keys } from "./db"; // the type is erased at build time; keys is the key construction

const tspg = tspgClient<Database>({
  url: "https://api.example.com", // where the PostgREST API is served
  queryClient: new QueryClient(),
  keys,
  headers: async () => ({ Authorization: `Bearer ${await token()}` }),
});

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
- `filters` takes column names.

## SSR

TanStack DB's [SSR](https://tanstack.com/db/latest/docs/guides/ssr) works as its guide shows it: a descriptor is
`collectionOptions(id, factory)`, and the factory takes the query client from the `DbClient`
(`new DbClient({ queryClient })`). Build the client inside the factory with `tspgClient` and the generated `keys`; the id
carries every dynamic parameter. What differs between the server and the browser (the URL, a `fetch`, headers) is yours.

```ts ignore
import type { QueryClient } from "@tanstack/query-core";
import { collectionOptions, DbClient } from "@tanstack/db";
import { tspgClient } from "@tspg/tanstack-db-postgrest";
import { keys, type Database } from "./db"; // the generated module

export const todos = (env: { url: string; fetch?: typeof fetch }) =>
  collectionOptions("api.todos", (client) =>
    tspgClient<Database>({
      ...env,
      queryClient: client.requireDependency<QueryClient>("queryClient"),
      keys,
    }).collectionOptions("todos"),
  );

// browser
const dbClient = new DbClient({ queryClient: new QueryClient() });
const collection = dbClient.collection(todos({ url: "/api" }));
```

On the server, make a `QueryClient` and a `DbClient` per request, preload, and `dehydrate()` the `DbClient`; the browser
`hydrate()`s it. Both sync modes work: `eager` rows are dehydrated with the collection, `on-demand` ones with the live
queries that were preloaded (`dbClient.preloadLiveQuery`). Hydrated rows are provisional, and TanStack DB's own limits
apply (mutation handlers and pending mutations are not serialized; Vue, Solid and Angular have no SSR provider yet).

## Sync modes

The package is built on TanStack DB's Query collection (`@tanstack/query-db-collection`), so it offers the modes
that collection has:

| `syncMode`          |                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------- |
| `"eager"` (default) | loads the whole table once and filters in memory: for small, mostly static tables         |
| `"on-demand"`       | loads only what live queries ask for; their predicates are pushed to the server, as below |

The default is TanStack DB's own, `eager`. Choose `on-demand` for large tables, which is what a PostgREST API is good at.

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

Writes: `insert` → `POST` (array body, what the insert gives and nothing more), `update` → `PATCH ?pk=eq.x` (changed columns only),
`delete` → `DELETE ?pk=eq.x`. `POST` and `PATCH` send `Prefer: return=representation` and the collection writes the row the
server returned straight into its store: there is no refetch. A write that does not return its row (a `PATCH` matching nothing, a
row hidden by a policy) fails with a `TspgError` (`TSPG_NO_ROW`) and the optimistic change is rolled back.
Errors surface as `TspgError` (`status`, `code`, `message`, `details`, `hint`).

Relations are not mapped: join collections with TanStack DB live queries instead of PostgREST embeds.
Cursor ties are not re-fetched (only `cursor.whereFrom` is used). PostgREST-only operators (FTS, `cs`, `ov`…) have no TanStack DB counterpart.
