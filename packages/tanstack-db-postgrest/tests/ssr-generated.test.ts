import { afterAll, beforeAll, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { QueryClient } from "@tanstack/query-core";
import { DbClient } from "@tanstack/db";
import { createRest, type RestInstance } from "../../rest/src/index";
import { pgliteAdapter } from "../../adapters/src/pglite";
import { generate } from "../src/generate";

/**
 * The module `generate()` writes holds the SSR integration: one descriptor per table, materialized by each
 * `DbClient`, and what differs between the server and the browser comes in with the client. This writes the
 * module, imports it, and runs the whole path: a server client reads through `handle` (no network), its state
 * is dehydrated, and a browser client hydrates it without requesting anything.
 */
const file = new URL("./zz-generated-ssr.ts", import.meta.url);
let db: PGlite;
let rest: RestInstance;
let mod: any;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
    END $$;
    GRANT anon TO CURRENT_USER;
    CREATE SCHEMA api;  GRANT USAGE ON SCHEMA api TO anon;
    CREATE TABLE api.notes (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, body text NOT NULL);
    CREATE TABLE api.lines (order_id int, line int, qty int NOT NULL, PRIMARY KEY (order_id, line));
    CREATE VIEW api.summary AS SELECT order_id, sum(qty)::int AS total FROM api.lines GROUP BY order_id;
    CREATE SCHEMA v2;  GRANT USAGE ON SCHEMA v2 TO anon;
    CREATE TABLE v2.things (id int PRIMARY KEY);
    GRANT SELECT ON api.notes, api.lines, api.summary, v2.things TO anon;
    INSERT INTO api.notes (body) VALUES ('a'), ('b');
    INSERT INTO api.lines VALUES (12, 3, 1);
    INSERT INTO v2.things VALUES (1);
  `);
  rest = await createRest({ db: pgliteAdapter(db), schemas: ["api", "v2"], anonymousRole: "anon" });
  writeFileSync(
    file,
    (await generate({ db: pgliteAdapter(db), schemas: ["api", "v2"] })).replaceAll(
      '"@tspg/tanstack-db-postgrest"',
      '"../src/index.ts"',
    ),
  );
  mod = await import(file.href);
  globalThis.fetch = (() => {
    throw new Error("network");
  }) as unknown as typeof fetch;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  rmSync(file, { force: true });
  await rest.close();
  await db.close();
});

test("a descriptor for each table with a primary key, the schema in the id", () => {
  const collections = mod.collections({ url: "/" });
  expect(Object.keys(collections.api).sort()).toEqual(["lines", "notes"]); // the view has no key: no descriptor
  expect(collections.api.notes.id).toBe("api.notes");
  expect(collections.v2.things.id).toBe("v2.things");
});

test("server: reads through handle, no network; the browser hydrates what was dehydrated", async () => {
  const onServer = mod.collections({
    url: "/",
    fetch: ((url: string, init?: RequestInit) =>
      rest.handle(new Request(new URL(url, "http://app").toString(), init))) as typeof fetch,
  });
  const server = new DbClient({ queryClient: new QueryClient() });
  await server.collection(onServer.api.notes).preload();
  await server.collection(onServer.api.lines).preload();
  await server.collection(onServer.v2.things).preload(); // another schema: sent as Accept-Profile
  const state = JSON.parse(JSON.stringify(server.dehydrate()));
  expect(state.collections.map((c: { collectionId: string }) => c.collectionId).sort()).toEqual([
    "api.lines",
    "api.notes",
    "v2.things",
  ]);

  // the browser: its `fetch` is the real one, which fails here: the rows have to come from the state
  const inBrowser = mod.collections({ url: "/api" });
  const browser = new DbClient({ queryClient: new QueryClient() });
  browser.hydrate(state);
  expect([...browser.collection(inBrowser.api.notes).keys()]).toEqual([1, 2]);
  expect([...browser.collection(inBrowser.api.lines).keys()]).toEqual(["12_3"]); // a composite key
  expect([...browser.collection(inBrowser.v2.things).keys()]).toEqual([1]);
});

test("a DbClient without a queryClient says so", () => {
  expect(() => new DbClient().collection(mod.collections({ url: "/" }).api.notes)).toThrow();
});
