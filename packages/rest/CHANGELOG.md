# @tspg/rest

## 0.3.0

### Features

- 3d893d3: `close()` closes the database driver, a new `onClose` option takes that over, and the `db`
  option is now `adapter`

  **Breaking**: the adapter is passed as `adapter`, not `db` -- it is a `DbAdapter`, which is also
  what `onClose` is handed and what the docs call it:

  ```ts
  const api = await createRest({ adapter: nodePostgresAdapter(pool), schemas: ["api"] });
  ```

  `@tspg/tanstack-db-postgrest`'s `generate()` takes its catalog source the same way --
  `generate({ adapter, schemas })`, not `{ db, schemas }`. `tspg-db generate` is unaffected: it is a
  command line.

  `rest.close()` and `db.close()` now call the adapter's own `close()` — `pool.end()`, `sql.end()`,
  `pglite.close()`; nothing for an adapter that has none — so the driver created for an instance no
  longer has to be ended beside it. Closing twice closes once, and a driver something else has already
  closed is not an error.

  **Breaking** for a driver that must outlive the instance, or is shared: pass `onClose`, which is
  handed the adapter and decides the whole of what closing does.

  ```ts
  const adapter = nodePostgresAdapter(pool);
  const api = await createRest({ adapter, onClose: () => {} }); // leaves the pool alone
  const query = createQuery({ adapter }); // this one ends it
  ```

### Bug Fixes

- 9d2c8e8: an upsert counts the rows it inserted instead of reading `xmax`, so views work

  A `Prefer: resolution=merge-duplicates` upsert used to return `(relation.xmax = 0)` alongside the
  rows, to tell an inserted tuple from an updated one and answer `200` rather than `201` when nothing
  was inserted. `xmax` is a **table** system column: through a view -- the usual PostgREST arrangement,
  an exposed view over a table in a schema that is not exposed -- every upsert failed with
  `42703 column <name>.xmax does not exist`. Partitioned and foreign tables have no usable `xmax`
  either, and the marker was not optional: no combination of preferences could turn it off.

  The rows really inserted are now counted the way PostgREST counts them: a predicate that is always
  true, on the `WHERE` of the insert's source and on the `WHERE` of `DO UPDATE`, moving a
  transaction-local `set_config('pgrst.inserted', …)` up once per candidate row and down once per row
  that turned out to exist. No system column is read, so an upsert works on any relation that can be
  inserted into.

  Two statuses move with it, both towards PostgREST (pinned by the differential suite):

  - a `merge-duplicates` upsert whose payload has nothing to insert -- `[]` -- answers `200`, where it
    used to answer `201`;
  - a `PUT` that **inserts** its row answers `201` with `Prefer: return=representation`, where it used
    to answer `200`. Replacing an existing row still answers `200`, and without a representation it is
    `204` either way.

- 6aed184: introspection reads constraints and view columns in a stable order

  The `pg_constraint` query had no `ORDER BY`, unlike every other query introspection runs, so the
  order of `foreignKeys` -- and of the `hints` on an ambiguous embed, which are built from it -- was
  whatever the heap returned. A generated descriptor is committed by the app, so the same database
  could regenerate a different file; `examples/query/with-transactions` flaked on exactly that. They
  are now ordered by schema, table and constraint name.

  The view-column query was ordered by `oid`, which is creation order: two databases built from the
  same SQL in a different sequence disagreed on the order of the foreign keys views add, and on which
  column of a view that exposes one table column twice a key is built from. It is now ordered by
  schema, view and column position, so the same SQL gives the same schema whatever order it was run
  in.

## 0.2.0

### Features

- 5c4b0e9: view columns take their nullability and primary key from the table they read

  The catalog holds no constraint for a view: `attnotnull` is always false and there is no
  `pg_constraint` row, so every view column was typed `| null` and every view had `pk: []`. A view
  column read straight from a table column now answers like that column, and a view that exposes
  every column of its table's primary key borrows it -- including when the table's schema is not one
  of the exposed `schemas`, which is the usual PostgREST arrangement (views in `api` over tables in
  `core`).

  Columns of a view whose query has a `LEFT`, `RIGHT` or `FULL` join are left alone: an unmatched row
  yields null there whatever the source column says.

  **Breaking:** the `views: "nullable" | "like-source"` option of `generateTypes` is gone. It existed
  because provenance alone could not tell a projection from an outer join; now that it can, the
  resolution happens during introspection and the generated types follow. Drop the option -- its
  `"like-source"` behaviour is what you get, and soundly.

## 0.1.0

### Minor Changes

- 2bd1d98: **Breaking:** `@adrdp/pg-rest` is split in two, along the line that was already in the code.

  - **`@tspg/rest`** is the PostgREST-compatible handler: `createRest(options)` gives `handle(Request) => Response`, with PostgREST's status codes, headers and error bodies. Nothing in it is an extension of PostgREST.
  - **`@tspg/query`** is the in-process API: `createQuery({ db, schema })` gives `query()`, `transaction()` and `setContextQuery()`, with the `$` filters and the computed `set` that PostgREST does not have. It has no HTTP in it, and nothing of PostgREST: its errors are its own (see below). The build-time generators are `@tspg/query/types`.

  They share one core (parsing, SQL, the schema cache, errors, adapters), which each package bundles: there is no third package to install. The adapters are in both, as `@tspg/rest/adapters/*` and `@tspg/query/adapters/*`.

  `createRest` reads the catalog itself and has `reloadSchema()`. `createQuery` never reads it: it runs on a **schema descriptor** generated at build time, together with the types, and does no runtime check of it — the compiler is what holds a query to it. `reloadSchema()`, `schemaCache()` and `generateTypes()` leave the query instance; `introspect`, `generateTypes`, `generateSchema` and `generateModule` are exported by `@tspg/query/types`.

  ```ts
  // build time
  writeFileSync("src/db.generated.ts", generateModule(await introspect(adapter, ["api"]), { name: "Database" }));

  // runtime
  import { schema } from "./db.generated";
  const rest = await createRest({ db, schemas: ["api"] });
  const query = createQuery<Database>({ db, schema });
  ```

  `createPgRest` is gone. The options both share (`db`, `schemas`, `anonymousRole`, `maxRows`, `extraSearchPath`, `preRequest`) are the same in both; `resolveContext`, `basePath`, `allowTxOverride`, `planEnabled`, `openApi`, `requestSettings` and `serverUrl` are `createRest`'s. `query()` no longer sets `request.method`, `request.path`, `request.headers` and `request.cookies` in SQL: they are PostgREST's HTTP contract, and there is no request.

  **Errors in `@tspg/query`.** A `QueryError` is no longer an `ApiError`: it has a `kind` (the string union), `message`, `details`, `hint`, the `sqlState` of a database error, and the `input`. There are no `PGRSTxxx` codes, no `status` and no `body` on it, and `QueryResult` has no `status` any more. `ApiError`, `DbQueryError`, `PgRestError`, `ErrorBody` and `errorKind` are no longer exported by `@tspg/query` (they stay in `@tspg/rest`). A transaction scope that rolled back, and a bound query with no context, are `rolled_back` and `no_context` errors.

### Patch Changes

- ef9a407: The engine no longer knows `preRequest` or the `request.*` settings: each package builds what it adds to a call (`@tspg/rest` from the HTTP request, `@tspg/query` from its own options). `preRequest` behaves as before; `PreRequestInfo.request` of `@tspg/query` is gone, since a query has no request.
- a9b8c23: The engine no longer has anything HTTP in it. `execute` returns a neutral `Result` (body, rows, total, the settings it was asked to read); `@tspg/rest` turns it into the status and headers (`Content-Range`, `Location`, `Preference-Applied`, `response.*`), and `planTable` takes an operation instead of an HTTP method. `@tspg/query` reads `total` directly instead of the `Content-Range` header. `PreRequestInfo.method` of `@tspg/query` is now `operation`.
- 4480352: Close an SQL injection and read hostile names the way PostgREST does.

  - `@tspg/query`: the `nulls` of an `order` object was written into the statement as it came, so a value that did not go through the type (a JSON body, say) could add SQL after `NULLS`. It now has to be `"first"` or `"last"`. `table`, `rpc` and `schema` must be strings: an object with its own `toString` is refused instead of being turned into a name.
  - `@tspg/rest`: the key of a filter, an embedded filter, a function argument read from the query string, `columns` and `on_conflict` go through PostgREST's grammar. What is not a name answers `PGRST100 failed to parse tree path (…)` (or `columns parameter`, `on_conflict parameter`) and what follows a name is ignored, as PostgREST does, instead of being looked for as a column (`42703`/`PGRST108`/`PGRST202`).
  - `@tspg/rest`: closer to PostgREST on malformed requests. `;` separates query parameters like `&`; `/table/` and `/rpc/` are read the way PostgREST reads them; an unsupported `Content-Type` is `400 PGRST102` (not 415) and an unsupported `Accept` is `406 PGRST107` listing the raw entries; function bodies that are not objects are read as PostgREST reads them (a scalar is no arguments, a single unnamed `json`/`text`/`xml`/`bytea` parameter takes the raw body); an empty `timezone` preference and an unknown `on_conflict` column answer with the PostgreSQL error. A NUL in a value is cut at the database boundary like libpq does, and embedded tables are aliased `<table>_<n>` so PostgreSQL error messages read like PostgREST's.

- 42f7660: The query-string parser does less work on the way to a successful parse: error messages are built only when one is reported, and combinators no longer allocate on every step. `parseQuery` on a typical query takes about a quarter less time; messages and results are unchanged.
- c8b433b: The query-string grammar (`parsec`, PostgREST's grammars and `parseQuery`) moves from the core into `@tspg/rest`, the only package that reads a query string. The engine now takes a `ParsedQuery`; `@tspg/query` builds it from its object for every shape -- JSON paths, casts, aggregates, embedded filters and null tests included -- and no longer renders a query string to have it parsed again, so the parser is no longer in its bundle. Two names a query string reserves (`order`, `limit`, `select`, `and`, `or`, `columns`) can now be columns in a `where`; an `$in` without a list, an unknown `$is` value and the like are refused in `query`'s own words.
