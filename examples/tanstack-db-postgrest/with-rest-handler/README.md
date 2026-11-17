# @tspg/tanstack-db-postgrest + PGlite

A TanStack DB collection over a PostgREST-compatible API, on **Node.js**. The API (`@tspg/rest` on PGlite, Postgres in
WebAssembly) runs in the same process, so there is no server and no Docker to start. This folder is self-contained:
copy it anywhere.

```sh
npm install
node gen-types.ts   # step 1: read the database, write db.generated.ts
node main.ts        # step 2: use it (Node >= 22.18 runs TypeScript natively)
```

The packages are ordinary versioned dependencies, so once this folder is copied out of the repository the install
above is all you need. Inside the repository those versions are not on the registry yet, so link the local build
instead -- from the repository root:

```sh
bun run link:examples tanstack-db-postgrest/with-rest-handler
```

## What it shows

- `gen-types.ts` — `generate()` reads the catalog and writes `db.generated.ts`: the `Database` type, `keys` (the
  primary key of each table and the code that builds a row's collection key). Run it again after a migration. The primary key is never written by hand.
- `main.ts` — `tspgClient<Database>({ url, queryClient, keys, fetch })`. The `fetch` hands each request to
  `pgRest.handle` in process: no server, no network. `createCollection(tspg.collectionOptions("todos"))` gives a typed
  collection; a live query reads it; an insert shows up at once (optimistic) and is replaced by the server's row; an
  update sends only what changed (`PATCH /todos?id=eq.N`).
- The collection is `eager` (TanStack DB's default): it loads the table once. Pass `syncMode: "on-demand"` to load only
  what live queries ask for, their filters sent to the API.

Against a real PostgREST API, drop `fetch` and give `url` its address. On a server that renders (SSR), `dehydrate()` the
`DbClient` and `hydrate()` it in the browser: see the package README.
