# @tspg/tanstack-db

TanStack DB collections over a PostgREST-compatible API (`@tspg/rest`, PostgREST, Supabase).

```sh
npm i @tspg/tanstack-db @tanstack/db @tanstack/query-db-collection @tanstack/query-core
```

```ts
import { QueryClient } from "@tanstack/query-core";
import { createCollection } from "@tanstack/db";
import { tspgCollectionOptions, type TspgRow } from "@tspg/tanstack-db";
import type { Database } from "./db.generated"; // from @tspg/query generateTypes (optional)

const queryClient = new QueryClient();

export const todos = createCollection(
  tspgCollectionOptions<TspgRow<Database, "todos">>({
    url: "/api", // where createRest's handle() is mounted
    table: "todos",
    queryClient,
    primaryKey: "id", // or ["order_id", "line"]: the key is then "12_3"
    headers: async () => ({ Authorization: `Bearer ${await token()}` }),
  }),
);
```

## Types and keys from the database

`@tspg/query` generates two modules from the catalog, and neither carries anything but what the client needs: a
`Database` type ([`generateTypes`](../../docs/types.md)) and the key construction ([`generateKeys`](../../docs/types.md#keys-for-a-client-that-keeps-rows-by-key)),
which holds each table's primary key columns and the code that builds a row's key, a composite one's values joined with `_`.

```ts
import { createCollection } from "@tanstack/db";
import { tspgClient } from "@tspg/tanstack-db";
import type { Database } from "./db.generated"; // types only: erased at build time
import { keys } from "./db.keys"; //                 the generated key construction

const tspg = tspgClient<Database>({ url: "/api", queryClient, keys });

const orders = createCollection(tspg.collectionOptions("orders")); // rows are typed
const lines = createCollection(tspg.collectionOptions("order_items")); // keyed "12_3": nothing to pass
const things = createCollection(tspg.schema("v2").collectionOptions("things")); // Accept-Profile: v2
```

The compiler checks what the types know:

- the table is one that exists, in the schema chosen (`schema("v2")` for the others), and the row is its `row`;
- `keys` has to match the `Database`: a table's key columns are the ones its type says;
- without `keys`, the key is `"id"` unless the table's says otherwise, and then it has to be named (`primaryKey`) and to
  be that key; the key is built by joining the columns with `_`, as the generated code does;
- a relation that cannot take every write (a view) needs `readOnly: true`, and a view, which has no key, names the
  columns that identify a row;
- `omitOnInsert` and `filters` take column names.

Without generated modules, `tspgCollectionOptions<Row>({ url, table, queryClient, primaryKey })` takes the row type by
hand, and `getKey` replaces the key construction.

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
