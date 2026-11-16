import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/query-core";
import { and, createCollection, createLiveQueryCollection, eq, gt, inArray, length, not, or } from "@tanstack/db";
import { tspgCollectionOptions } from "../src/index.ts";

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
    if (init.method === "PATCH") return new Response("[]", { status: 200 });
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    return new Response(JSON.stringify(DB), { status: 200 });
  }) as unknown as typeof fetch;
  const todos = createCollection(
    tspgCollectionOptions<Todo>({
      url: "http://x/api/",
      table: "todos",
      queryClient: new QueryClient(),
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

test("insert -> POST then refetch; update -> PATCH by pk; delete -> DELETE by pk", async () => {
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
