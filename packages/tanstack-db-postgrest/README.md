# @tspg/tanstack-db-postgrest

TanStack DB collections over a [PostgREST](https://postgrest.org) API: PostgREST itself, Supabase, or any compatible
server. The collections talk to the API over HTTP; only the generator reads the database, to know its tables and keys.

```sh
npm i @tspg/tanstack-db-postgrest @tanstack/db @tanstack/query-db-collection @tanstack/query-core
```

## 1. Generate the module from the database

`tspg-db generate` reads the catalog and writes one module with everything a client needs from the database. It is
required: the primary key and the row types are never written by hand. It is a command line, not an import: nothing
of the generator reaches your code.

```sh
npm i -D pg
npx tspg-db generate --url "$DATABASE_URL" --schemas api --out src/db.ts
```

It reads the connection string from `--url`, or `DATABASE_URL`, and connects with [`pg`](https://node-postgres.com),
which your project installs. Without a database to hand, `--sql schema.sql` builds the schema from a SQL file in a
throwaway [PGlite](https://pglite.dev) database (install `@electric-sql/pglite`) and reads that; it cannot be combined
with `--url`. `tspg-db --help` lists the options and examples. Put the command in a script to run again after a
migration:

```json
{ "scripts": { "gen:db": "tspg-db generate --schemas api --out src/db.ts" } }
```

| option                                        | default                           |                                                                         |
| --------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------- |
| `--url`                                       | `$DATABASE_URL`                   | the connection string                                                   |
| `--sql`                                       |                                   | a SQL file to build the schema from, in PGlite, instead of `--url`      |
| `--schemas`                                   | `public`                          | the schemas to read, comma-separated; the first is the client's default |
| `--out`                                       | `db.generated.ts`                 | the file to write (`-` for the standard output)                         |
| `--name`, `--keys-name`, `--collections-name` | `Database`, `keys`, `collections` | the names of what the module exports                                    |

The module holds:

- a `Database` type: each table's `row` and `insert` shapes, primary key, and whether it can be written;
- `keys`: each table's primary key columns and the code that builds a row's key — the value for one column, a
  composite key's values joined with `_` (`12_3`);
- `collections(env)`: one TanStack DB descriptor (`collectionOptions(id, factory)`) per table with a primary key, the
  same on the server and in the browser. `env` is `{ url, fetch?, headers?, syncMode? }`: what differs between the two.

The command runs on Node, at build time, and is the only part that touches the database. The module holds no schema and
no introspection: only types, keys and descriptors reach the bundle. Regenerate it after a migration. A composite-type
column is typed `unknown`, and relationships are not in it: joins are the live queries'.

### What `insert` takes

`collection.insert()` takes the `insert` shape, and reads are typed by `row`.

- A column with a default, or that accepts NULL, is optional: give it to choose the value, leave it out and the
  database fills it. What is not given is not sent.
- A column the database refuses a value for (a stored generated column, an `ALWAYS` identity) is not in it.
- The primary key is required, even when the database makes its own: the collection keeps rows by key, so the
  optimistic row needs one at once. For a key the database makes up (an identity, a sequence) it is a placeholder, and
  the client keeps it out of the request (`keys` lists those columns as `generated`). A key the client can make (a
  `uuid`) is sent as given.
- An optimistic row holds only what was inserted, with no default filled in: the collection does not know the
  database's defaults. The server's row replaces it when the write returns (no refetch), so a live query that filters on
  a defaulted column does not see the row until then: give that column in the insert.

## 2. Use it

The same code runs on the server and in the browser, and `collections(env)` is what makes that possible. Called with
`env` (the URL, an optional custom `fetch`, optional `headers`: the only things that differ between the two sides), it
returns one descriptor per table. A descriptor is what TanStack DB's SSR needs: it has a stable id that carries the
schema (`"api.orders"`), which `dehydrate()` and `hydrate()` use to find the collection again, and it is wired with the
generated `keys` and the query client of the `DbClient` that materializes it. Without it you would write that
descriptor by hand for every table.

```ts ignore
import { QueryClient } from "@tanstack/query-core";
import { DbClient } from "@tanstack/db";
import { collections } from "./db"; // the generated module

const { api } = collections({
  url: "/api", // where the PostgREST API is served
  headers: async () => ({ Authorization: `Bearer ${await token()}` }),
  // fetch: myFetch, // optional: a custom fetch (in process on a server, for example)
});

const dbClient = new DbClient({ queryClient: new QueryClient() });
const orders = dbClient.collection(api.orders); // rows are typed
const lines = dbClient.collection(api.order_items); // keyed "12_3": nothing to pass
const things = dbClient.collection(collections({ url: "/api" }).v2.things); // schema v2: Accept-Profile
```

Each descriptor has a stable id that carries the schema (`"api.orders"`). A view has no primary key to generate, so it has
no descriptor: use `tspgClient` for it (below).

The compiler checks what the types know:

- the table is one that exists, in the schema chosen (`schema("v2")` for the others), and the row is its `row`;
- the primary key is never given: `keys` holds each table's key columns and the code that builds a row's key, and has
  to match the `Database` (a table's key columns are the ones its type says);
- a relation that cannot take every write (a view) needs `readOnly: true`, and a view, which has no primary key to
  generate, names the columns that identify a row (`keyColumns`);
- `filters` takes column names.

## SSR

TanStack DB's [SSR](https://tanstack.com/db/latest/docs/guides/ssr) is built in, the way its guide shows it: the
descriptors are `collectionOptions(id, factory)` and each `DbClient` gives its own query client, so a server makes a
`QueryClient` and a `DbClient` per request. The only difference between the two sides is `env`.

```ts ignore
// server, per request
const dbClient = new DbClient({ queryClient: new QueryClient() });
const { api } = collections({ url: apiUrl, headers: { Authorization: request.headers.get("authorization")! } });
await dbClient.collection(api.todos).preload();
const state = dbClient.dehydrate(); // serialize it into the page

// browser
const browser = new DbClient({ queryClient: new QueryClient() });
browser.hydrate(state);
const todos = browser.collection(collections({ url: "/api" }).api.todos);
```

Both sync modes work: `eager` rows are dehydrated with the collection, `on-demand` ones with the live queries that
were preloaded (`dbClient.preloadLiveQuery`). Hydrated rows are provisional until the collection syncs, and TanStack DB's
own limits apply (mutation handlers and pending mutations are not serialized; Vue, Solid and Angular have no SSR
provider yet).

## `tspgClient`: views and custom ids

The descriptors are made with `tspgClient`, which is public. Use it for a view (it names its key columns and is
read-only) or to choose a collection's id and options:

```ts ignore
import { createCollection } from "@tanstack/db";
import { tspgClient } from "@tspg/tanstack-db-postgrest";
import { type Database, keys } from "./db";

const tspg = tspgClient<Database>({ url: "/api", queryClient: new QueryClient(), keys });
const totals = createCollection(tspg.collectionOptions("totals", { keyColumns: ["order_id"], readOnly: true }));
```

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
