import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createRest, type RestInstance } from "../../src/index";
import { hasDb } from "../../../../tests/support/db";
import { normalize, type Seen } from "./seen";
import { POSTGREST_BIN, startPostgrest, type RunningPostgrest } from "./postgrest";
import { createUpstreamDb, type UpstreamDb } from "./upstream/load";
import { CLUSTERS, KNOWN, UNSTABLE } from "./upstream/known";
import { upstreamCases, type UpstreamCase } from "./upstream/cases";

/**
 * The differential suite of `compare/cases.ts`, run on PostgREST's own ground: its fixture database
 * (316 relations, 81 of them views, 353 functions) and the requests of its own `test/spec`, both
 * taken from the v16.5 source by `scripts/sync-upstream-fixture.ts`.
 *
 * Their assertions are not used -- the pinned binary is the expectation, so a case needs only a
 * request. The two engines are configured the same way as upstream's `SpecHelper.baseCfg` (the
 * `test` schema, `postgrest_test_anonymous`, `test.switch_role` as the pre-request), and every case
 * is anonymous: the ones that carry a JWT are not harvested.
 *
 *   POSTGREST_BIN=/path/to/postgrest TEST_DATABASE_URL=postgres://... bun test ./packages/rest/tests/compare/
 *
 * `known.ts` holds the differences that stand, each with the cluster it belongs to; a case listed
 * there is asserted to still differ, so one that starts matching has to be removed from the list.
 */
const enabled = hasDb && Boolean(POSTGREST_BIN);

/**
 * A request with no `order=` asks for no row order, so the two engines are free to answer in
 * different ones and a body comparison would be a coin toss. For those, every array in the body is
 * compared as a bag: sorted by the canonical form of its elements. With an `order=`, the order is
 * part of the answer and is compared as it comes.
 */
const bagged = (v: unknown): unknown => {
  if (Array.isArray(v)) {
    const items = v.map(bagged);
    return items
      .map((x) => [JSON.stringify(x), x] as const)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([, x]) => x);
  }
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, bagged(x)]));
  }
  return v;
};

const comparable = (seen: Seen, c: UpstreamCase): Seen =>
  c.path.includes("order=") ? seen : { ...seen, body: bagged(seen.body) };

describe.skipIf(!enabled)("PostgREST's own requests, on its own fixtures", () => {
  let db: UpstreamDb;
  let ours: RestInstance;
  let theirs: RunningPostgrest;

  beforeAll(async () => {
    db = await createUpstreamDb();
    ours = await createRest({
      adapter: db.adapter,
      schemas: ["test"],
      anonymousRole: "postgrest_test_anonymous",
      preRequest: "test.switch_role",
      allowTxOverride: true, // the harvested writes are rolled back, and so must PostgREST's be
      onClose: () => {}, // the driver is the harness's, and `db.drop()` ends it
    });
    theirs = await startPostgrest(db.url, 54850 + Math.floor(Math.random() * 500), ["test"], {
      anonRole: "postgrest_test_anonymous",
      preRequest: "test.switch_role",
      planEnabled: false, // baseCfg leaves plans off, and so do the blocks the cases come from
      openApiProxyUri: false,
      probe: "/items?limit=1",
      pool: 4,
    });
  }, 120_000);
  afterAll(async () => {
    await theirs?.stop();
    await ours?.close();
    await db?.drop();
  });

  const send = async (base: string | null, c: UpstreamCase): Promise<Response> => {
    const init: RequestInit = {
      method: c.method,
      headers: c.headers ?? {},
      ...(c.body !== undefined ? { body: c.body } : {}),
    };
    if (base === null) return ours.handle(new Request(`http://localhost${c.path}`, init));
    return fetch(`${base}${c.path}`, init);
  };

  /** Rolled-back writes still consume sequence values; restore them so both engines see the same ids. */
  const snapshot = () =>
    db.adapter.query("SELECT schemaname || '.' || sequencename AS name, last_value::text AS v FROM pg_sequences");
  const restore = async (snap: Awaited<ReturnType<typeof snapshot>>) => {
    for (const r of snap) {
      const name = String(r["name"]).replace(/'/g, "''");
      await db.adapter.query(
        r["v"] === null ? `SELECT setval('${name}', 1, false)` : `SELECT setval('${name}', ${Number(r["v"])}, true)`,
      );
    }
  };
  const writes = (c: UpstreamCase) => c.method !== "GET" && c.method !== "HEAD" && c.method !== "OPTIONS";

  for (const c of upstreamCases) {
    const known = KNOWN[c.name];
    const unstable = UNSTABLE[c.name];
    const label = `${unstable ? "[unstable] " : known ? `[known: ${known}] ` : ""}${c.name}  (${c.source})`;
    test.skipIf(Boolean(unstable))(label, async () => {
      const snap = writes(c) ? await snapshot() : undefined;
      const theirSeen = comparable(await normalize(await send(theirs.url, c)), c);
      if (snap) await restore(snap);
      const ourSeen = comparable(await normalize(await send(null, c)), c);
      if (snap) await restore(snap);
      if (known) {
        // Listed as a difference: assert it is still one, with the cluster it belongs to in the message, so that a
        // case this engine starts answering identically fails here until it is taken off the list.
        expect(ourSeen, `${c.name}\n\n${CLUSTERS[known]}`).not.toEqual(theirSeen);
      } else expect(ourSeen).toEqual(theirSeen);
    });
  }
});
