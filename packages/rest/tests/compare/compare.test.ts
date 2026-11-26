import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { hasDb, requirePostgis } from "../../../../tests/support/db";
import { makeApi, type TestApi } from "../support/api";
import { cases, type Case } from "./cases";
import { normalize } from "./seen";
import { POSTGREST_BIN, signJwt, startPostgrest, type RunningPostgrest } from "./postgrest";

/**
 * Differential test: every case is sent to the real PostgREST 16 and to pg-rest, both on the same
 * database, and the responses are compared. Run with:
 *   POSTGREST_BIN=/path/to/postgrest TEST_DATABASE_URL=postgres://... bun test ./packages/rest/tests/compare/
 */
const enabled = hasDb && Boolean(POSTGREST_BIN);

const identities = {
  anon: { token: undefined, ctx: undefined },
  alice: {
    token: signJwt({ role: "authenticated", sub: "alice" }),
    ctx: { role: "authenticated", claims: { sub: "alice" } },
  },
  bob: {
    token: signJwt({ role: "authenticated", sub: "bob" }),
    ctx: { role: "authenticated", claims: { sub: "bob" } },
  },
} as const;

describe.skipIf(!enabled)("pg-rest vs PostgREST 16", () => {
  let ours: TestApi;
  let theirs: RunningPostgrest;

  beforeAll(async () => {
    ours = await makeApi({ allowTxOverride: true, planEnabled: true });
    theirs = await startPostgrest(ours.db.url, 54340 + Math.floor(Math.random() * 500), ["api", "v2"]);
  }, 60_000);
  afterAll(async () => {
    await theirs?.stop();
    await ours?.close();
  });

  const send = async (base: string | null, c: Case): Promise<Response> => {
    const who = identities[c.as ?? "anon"];
    const headers: Record<string, string> = { ...c.headers };
    let body: string | undefined;
    if (c.body !== undefined) {
      if (typeof c.body === "string") body = c.body;
      else {
        body = JSON.stringify(c.body);
        headers["Content-Type"] ??= "application/json";
      }
    }
    const method = c.method ?? "GET";
    if (base === null) {
      return ours.api.handle(
        new Request(`http://localhost${c.path}`, { method, headers, ...(body !== undefined ? { body } : {}) }),
        who.ctx as never,
      );
    }
    if (who.token) headers["Authorization"] = `Bearer ${who.token}`;
    return fetch(`${base}${c.path}`, { method, headers, ...(body !== undefined ? { body } : {}) });
  };

  /** Rolled-back inserts still consume sequence values; restore them so both engines see the same ids. */
  const snapshot = async () =>
    ours.db.adapter.query("SELECT schemaname || '.' || sequencename AS name, last_value::text AS v FROM pg_sequences");
  const restore = async (snap: Awaited<ReturnType<typeof snapshot>>) => {
    for (const r of snap) {
      const name = String(r["name"]).replace(/'/g, "''");
      await ours.db.adapter.query(
        r["v"] === null ? `SELECT setval('${name}', 1, false)` : `SELECT setval('${name}', ${Number(r["v"])}, true)`,
      );
    }
  };

  for (const c of cases) {
    test(`${c.known ? "[known difference] " : ""}${c.name}${c.as && c.as !== "anon" ? ` (as ${c.as})` : ""}`, async () => {
      if (c.requires === "postgis") requirePostgis();
      const snap = await snapshot();
      const a = await normalize(await send(theirs.url, c), c);
      await restore(snap);
      const b = await normalize(await send(null, c), c);
      await restore(snap);
      if (c.known) expect(b).not.toEqual(a);
      else expect(b).toEqual(a);
    });
  }
});
