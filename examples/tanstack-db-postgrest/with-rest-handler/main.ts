// Step 2: use it. The API runs in this process (PGlite + @tspg/rest), so the example needs no server: `restFetch`
// hands each request straight to `pgRest.handle`. Against a real PostgREST API, drop `fetch` and give `url` its address.
//   node main.ts
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { QueryClient } from "@tanstack/query-core";
import { createLiveQueryCollection, DbClient, eq } from "@tanstack/db";
import { createRest } from "@tspg/rest";
import { pgliteAdapter } from "@tspg/rest/adapters/pglite";
import { restFetch } from "@tspg/tanstack-db-postgrest/rest";
import { collections } from "./db.generated.ts";

const pglite = new PGlite();
await pglite.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
const pgRest = await createRest({
  db: pgliteAdapter(pglite),
  schemas: ["api"],
  anonymousRole: "anon",
  // no JWT here: whoever `X-User` says is `authenticated`, anyone else is `anon` (read-only)
  resolveContext: (req) => {
    const user = req.headers.get("x-user");
    return user ? { role: "authenticated", claims: { sub: user } } : undefined;
  },
});

// db.generated.ts holds `collections(env)`: one TanStack DB descriptor per table. `env` is what differs between the
// server and the browser -- the URL, a `fetch`, headers: here `restFetch` hands each request straight to
// `pgRest.handle`, so there is no network (in a browser: `collections({ url: "/api" })`). The query client comes from
// the `DbClient`, as in TanStack DB's SSR guide. The `DbClient` is the unit of SSR: a server makes one per request and
// `dehydrate()`s it, the browser `hydrate()`s its own.
const queryClient = new QueryClient();
const db = new DbClient({ queryClient });
const { api } = collections({ url: "/", fetch: restFetch(pgRest), headers: { "X-User": "alice" } });

// `eager` (the default) loads the table once. `syncMode: "on-demand"` would load only what a live query asks
// for, its filters sent to the API.
const todos = db.collection(api.todos);
await todos.preload();

// A live query: TanStack DB keeps it up to date as the collection changes.
const open = createLiveQueryCollection((q) =>
  q
    .from({ todo: todos })
    .where(({ todo }) => eq(todo.done, false))
    .orderBy(({ todo }) => todo.id),
);
await open.preload();
console.log("open:", open.toArray.map((t) => t.title).join(", "));

// An insert is optimistic: the row is there at once under a temporary id, and replaced by the server's. The key
// is required (the collection holds rows by it); `todos.id` is an identity, so the client keeps the placeholder
// out of the request. `owner` and `created` are left out: the database fills them.
const tx = todos.insert({ id: -1, title: "Ship it", done: false }); // the generated `insert` shape; `done` is given because the live query reads it
console.log("optimistic:", open.toArray.map((t) => t.title).join(", "));
await tx.when("settled");
console.log("created", todos.toArray.find((t) => t.title === "Ship it")?.id);

// An update sends only what changed: PATCH /todos?id=eq.N
const mine = todos.toArray.find((t) => t.title === "Ship it")!;
await todos.update(mine.id, (draft) => {
  draft.done = true;
}).when("settled");
console.log("open after the update:", open.toArray.map((t) => t.title).join(", "));

await pgRest.close();
await pglite.close();
