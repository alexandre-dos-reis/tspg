import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/query-core";
import { DbClient, collectionOptions, eq } from "@tanstack/db";
import { tspgCollectionOptions } from "../src/index";

/**
 * TanStack DB's SSR: a descriptor (`collectionOptions(id, factory)`) is materialized per `DbClient`, the
 * server preloads and `dehydrate()`s, the browser `hydrate()`s. The query client goes *inside* the
 * factory, so each client (each request) has its own, and the id carries every dynamic parameter.
 */
const seen: string[] = [];
const fetchImpl = (async (url: string) => {
  seen.push(decodeURIComponent(url));
  return new Response(
    JSON.stringify([
      { id: 1, title: "a", done: false },
      { id: 2, title: "b", done: true },
    ]),
  );
}) as unknown as typeof fetch;

type Todo = { id: number; title: string; done: boolean };
const todos = (syncMode: "eager" | "on-demand") =>
  collectionOptions(`todos-${syncMode}`, () =>
    tspgCollectionOptions<Todo>({
      url: "http://x/api",
      table: "todos",
      queryClient: new QueryClient(),
      key: { pk: ["id"], key: (row: Todo) => row.id },
      fetch: fetchImpl,
      syncMode,
    }),
  );

test("an eager collection: preloaded on the server, hydrated in the browser", async () => {
  const descriptor = todos("eager");
  const server = new DbClient();
  await server.collection(descriptor).preload();
  const state = JSON.parse(JSON.stringify(server.dehydrate())); // what crosses the wire
  expect(state.collections[0].collectionId).toBe("todos-eager");

  const calls = seen.length;
  const browser = new DbClient();
  browser.hydrate(state);
  expect([...browser.collection(descriptor).keys()]).toEqual([1, 2]);
  expect(seen.length).toBe(calls); // rows came from the state, not a request
});

test("an on-demand collection: a preloaded live query is dehydrated with its rows", async () => {
  const descriptor = todos("on-demand");
  const server = new DbClient();
  const query = {
    query: (q: any) => q.from({ t: server.collection(descriptor) }).where(({ t }: any) => eq(t.done, true)),
  };
  await server.preloadLiveQuery(query as never);
  const state = JSON.parse(JSON.stringify(server.dehydrate()));
  expect(state.liveQueries?.length).toBe(1);
  expect(seen.some((u) => u.includes("done=is.true") || u.includes("done=eq.true"))).toBe(true);
});
