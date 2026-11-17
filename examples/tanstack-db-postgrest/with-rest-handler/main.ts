// Step 2: use it. The API runs in this process (PGlite + @tspg/rest) so the example needs no server:
// the client's `fetch` hands each request straight to `pgRest.handle`. Against a real API, drop `fetch`
// and give `url` the address where it is mounted.
//   node main.ts
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { QueryClient } from "@tanstack/query-core";
import { createCollection, createLiveQueryCollection, eq } from "@tanstack/db";
import { createRest } from "@tspg/rest";
import { pgliteAdapter } from "@tspg/rest/adapters/pglite";
import { tspgClient } from "@tspg/tanstack-db-postgrest";
import { type Database, keys } from "./db.generated.ts";

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

// The client: typed by the generated `Database`, with the keys it generated. Nothing says what a table's
// primary key is -- the database did.
const tspg = tspgClient<Database>({
  url: "http://localhost",
  queryClient: new QueryClient(),
  keys,
  headers: { "X-User": "alice" },
  fetch: ((url: string, init?: RequestInit) => pgRest.handle(new Request(url, init))) as typeof fetch,
});

// `eager` (the default) loads the table once. `syncMode: "on-demand"` would load only what a live query asks
// for, its filters sent to the API. The columns the database fills are left out of the POST.
const todos = createCollection(tspg.collectionOptions("todos", { omitOnInsert: ["id", "owner", "created"] }));
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

// An insert is optimistic: the row is there at once under a temporary id, and replaced by the server's.
const tx = todos.insert({ id: -1, owner: "alice", title: "Ship it", done: false, created: new Date().toISOString() });
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
