import { afterAll, beforeAll, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { QueryClient } from "@tanstack/query-core";
import { createCollection } from "@tanstack/db";
import { createRest, type RestInstance } from "../../rest/src/index";
import { pgliteAdapter } from "../../adapters/src/pglite";
import { restFetch } from "../src/rest";
import { tspgClient } from "../src/index";

/** The API runs in this process: `restFetch` hands each request to `handle`, and nothing goes on the network. */
type Row = { id: number; owner: string };
type Database = {
  default: "api";
  schemas: {
    api: {
      notes: {
        row: Row;
        insert: Row;
        pk: ["id"];
        insertable: true;
        updatable: true;
        deletable: true;
      };
    };
  };
};
const keys = {
  default: "api",
  schemas: { api: { notes: { pk: ["id"], generated: [], key: (r: Row) => r.id } } },
} as const;

let db: PGlite;
let rest: RestInstance;
const realFetch = globalThis.fetch;
const seenBy: (string | null)[] = [];

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
    END $$;
    GRANT anon TO CURRENT_USER;
    CREATE SCHEMA api;
    GRANT USAGE ON SCHEMA api TO anon;
    CREATE TABLE api.notes (id int PRIMARY KEY, owner text NOT NULL);
    GRANT SELECT ON api.notes TO anon;
    INSERT INTO api.notes VALUES (1, 'a'), (2, 'b');
  `);
  rest = await createRest({
    db: pgliteAdapter(db),
    schemas: ["api"],
    anonymousRole: "anon",
    resolveContext: (req) => {
      seenBy.push(req.headers.get("cookie"));
      return undefined;
    },
  });
  // any request that reaches the network is a failure
  globalThis.fetch = (() => {
    throw new Error("network");
  }) as unknown as typeof fetch;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await rest.close();
  await db.close();
});

test("a collection reads through handle(), with a relative url and no network", async () => {
  const tspg = tspgClient<Database>({
    url: "/", // relative: resolved against the base, never requested
    queryClient: new QueryClient(),
    keys,
    fetch: restFetch(rest),
  });
  const notes = createCollection(tspg.collectionOptions("notes"));
  await notes.preload();
  expect([...notes.keys()]).toEqual([1, 2]);
});

test("the identity of the incoming request is carried onto each call", async () => {
  seenBy.length = 0;
  const incoming = new Request("http://app/page", { headers: { cookie: "session=abc", "x-other": "no" } });
  const f = restFetch(rest, incoming);
  const res = await f("/notes");
  expect(res.status).toBe(200);
  expect(seenBy).toEqual(["session=abc"]);

  // what the call sets itself wins, and what is not on the list is not forwarded
  seenBy.length = 0;
  await restFetch(rest, incoming, { forward: [] })("/notes");
  await restFetch(rest, incoming)("/notes", { headers: { cookie: "own=1" } });
  expect(seenBy).toEqual([null, "own=1"]);
});
