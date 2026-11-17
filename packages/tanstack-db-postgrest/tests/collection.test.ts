import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/query-core";
import { and, createCollection, createLiveQueryCollection, eq, gt, inArray, length, not, or } from "@tanstack/db";
import { tspgCollectionOptions } from "../src/collection.ts";

/** What `generate()` writes for a table keyed by `id`. */
const byId = { pk: ["id"], key: (row: { id: number }) => row.id } as const;

type Todo = { id: number; title: string; done: boolean; priority: number };
const DB: Todo[] = [
  { id: 1, title: "a", done: false, priority: 3 },
  { id: 2, title: "b", done: true, priority: 1 },
  { id: 3, title: "c, d", done: false, priority: 2 },
];

function setup() {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const fetchMock = (async (url: string, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method: init.method ?? "GET", url: decodeURIComponent(url), body });
    if (init.method === "POST") {
      DB.push(...body);
      return new Response(JSON.stringify(body), { status: 201 });
    }
    if (init.method === "PATCH") {
      // the server answers with the row as it is now (`Prefer: return=representation`)
      const id = Number(/id=eq\.(\d+)/.exec(decodeURIComponent(url))![1]);
      return new Response(JSON.stringify([{ ...DB.find((r) => r.id === id), ...body }]), { status: 200 });
    }
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    return new Response(JSON.stringify(DB), { status: 200 });
  }) as unknown as typeof fetch;
  const todos = createCollection(
    tspgCollectionOptions<Todo>({
      url: "http://x/api/",
      table: "todos",
      key: byId,
      queryClient: new QueryClient(),
      syncMode: "on-demand", // the predicates are pushed to the server: that is what these tests read
      fetch: fetchMock,
    }),
  );
  return { todos, calls };
}

// TanStack DB may issue several loads for one live query (e.g. a tie-breaking page), so match any GET.
const gets = (calls: { method: string; url: string }[]) => calls.filter((c) => c.method === "GET").map((c) => c.url);

test("pushes where / orderBy / limit to PostgREST syntax", async () => {
  const { todos, calls } = setup();
  const live = createLiveQueryCollection((q) =>
    q
      .from({ t: todos })
      .where(({ t }) => and(eq(t.done, false), gt(t.priority, 1)))
      .orderBy(({ t }) => t.priority, "desc")
      .limit(5),
  );
  await live.preload();
  const url = gets(calls).find((u) => u.includes("limit="))!;
  expect(url).toBeTruthy();
  expect(url).toMatch(/^http:\/\/x\/api\/todos\?/);
  expect(url).toMatch(/done=eq\.false/);
  expect(url).toMatch(/priority=gt\.1/);
  expect(url).toMatch(/order=priority\.desc\.nulls(first|last)/);
  expect(url).toMatch(/limit=5/);
});

test("or / not / in", async () => {
  const { todos, calls } = setup();
  const live = createLiveQueryCollection((q) =>
    q.from({ t: todos }).where(({ t }) => or(inArray(t.id, [1, 3]), not(eq(t.title, "x,y")))),
  );
  await live.preload();
  const url = gets(calls)[0]!;
  expect(url).toMatch(/or=\(id\.in\.\(1,3\),or\(title\.not\.eq\."x,y",title\.is\.null\)\)/);
});

test("insert -> POST; update -> PATCH by pk; delete -> DELETE by pk; the returned row is written, nothing is refetched", async () => {
  const { todos, calls } = setup();
  // On-demand: rows are only loaded once a live query asks for them.
  await createLiveQueryCollection((q) => q.from({ t: todos })).preload();
  const tx = todos.insert({ id: 9, title: "n", done: false, priority: 1 });
  await tx.when("settled");
  expect(calls.find((c) => c.method === "POST")!.body).toEqual([{ id: 9, title: "n", done: false, priority: 1 }]);

  const up = todos.update(1, (d) => {
    d.done = true;
  });
  await up.when("settled");
  const patch = calls.find((c) => c.method === "PATCH")!;
  expect(patch.url).toMatch(/todos\?id=eq\.1$/);
  expect(patch.body).toEqual({ done: true });

  const del = todos.delete(2);
  await del.when("settled");
  expect(calls.find((c) => c.method === "DELETE")!.url).toMatch(/todos\?id=eq\.2$/);
  expect(todos.has(2)).toBe(false);
  expect(todos.get(1)?.done).toBe(true);
  expect(todos.get(9)?.title).toBe("n");
  // one GET to load, none after the writes
  expect(calls.filter((c) => c.method === "GET")).toHaveLength(1);
});

test("a write that does not return its row fails and is rolled back", async () => {
  const { todos } = setup();
  await createLiveQueryCollection((q) => q.from({ t: todos })).preload();
  const empty = createCollection(
    tspgCollectionOptions<Todo>({
      url: "http://x/api",
      table: "todos",
      key: byId,
      queryClient: new QueryClient(),
      syncMode: "eager",
      fetch: (async (_u: string, init: RequestInit = {}) =>
        new Response(init.method === "GET" || !init.method ? JSON.stringify(DB) : "[]", {
          status: 200,
        })) as unknown as typeof fetch,
    }),
  );
  await empty.preload();
  const tx = empty.update(1, (d) => {
    d.done = true;
  });
  await tx.when("settled").catch(() => {});
  expect(tx.state).toBe("failed");
  expect(tx.error?.error.message).toMatch(/expected 1 row/);
  expect(empty.get(1)?.done).toBe(false);
});

test("an operator the server cannot run still gives correct results (local refilter)", async () => {
  const { todos, calls } = setup();
  const live = createLiveQueryCollection((q) =>
    q
      .from({ t: todos })
      .where(({ t }) => gt(length(t.title), 1))
      .orderBy(({ t }) => t.id)
      .limit(1),
  );
  await live.preload();
  expect(gets(calls).every((u) => !u.includes("limit="))).toBeTruthy();
  expect(live.toArray.map((r) => r.id)).toEqual([3]); // only "c, d" is longer than 1 char
});

test("eager mode loads the whole table once and filters locally", async () => {
  const calls: string[] = [];
  const fetchMock = (async (url: string) => {
    calls.push(decodeURIComponent(url));
    return new Response(JSON.stringify(DB), { status: 200 });
  }) as unknown as typeof fetch;
  const todos = createCollection(
    tspgCollectionOptions<Todo>({
      url: "http://x/api",
      table: "todos",
      key: byId,
      queryClient: new QueryClient(),
      syncMode: "eager",
      fetch: fetchMock,
    }),
  );
  await todos.preload();
  const live = createLiveQueryCollection((q) => q.from({ t: todos }).where(({ t }) => eq(t.done, false)));
  await live.preload();
  expect(calls).toEqual(["http://x/api/todos?select=*"]); // no predicate was sent
  expect(live.toArray.map((r) => r.id).sort()).toEqual(
    [1, 3, 9].filter((id) => DB.some((r) => r.id === id && !r.done)),
  );
});
