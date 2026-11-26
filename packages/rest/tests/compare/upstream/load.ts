// PostgREST's own fixture database, loaded into a throwaway database of the test server.
//
// `fixture.sql` is upstream's `test/spec/fixtures/load.sql` with its includes inlined (written by
// `scripts/sync-upstream-fixture.ts`), so it is still psql's dialect in two places. Both are dealt
// with here rather than in the generated file, which stays comparable with upstream line by line:
//
//   :DBNAME, :"PGUSER"        psql variables, substituted with this database's own coordinates
//   COPY ... FROM STDIN       inline data psql streams; rewritten as INSERTs, which a driver can run
//
// Compared with `tests/support/fixture.sql` (6 views), this carries 316 relations, 81 of them views, and 353 functions,
// which is the point of adopting it: the differential cases get a far larger surface, and the kind
// of bug that only a view shows (reading `xmax` through one, #58) is in range from the start.
import { SQL } from "bun";
import { bunSqlAdapter } from "../../../../adapters/src/bun";
import type { DbAdapter } from "../../../../adapters/src";
import { ADMIN_URL } from "../../../../../tests/support/db";

const fixture = await Bun.file(new URL("./fixture.sql", import.meta.url)).text();

/** The database the fixture is loaded into. See `createUpstreamDb` for why it is not per-run. */
const FIXTURE_DB = "pgrst_upstream_fixture";

/** A Postgres string literal, for the psql variables the fixture carries. */
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
const ident = (v: string) => `"${v.replace(/"/g, '""')}"`;

/**
 * `COPY <table> (<cols>) FROM STDIN CSV DELIMITER '|'` followed by its rows and a `\.` terminator.
 * The two blocks in the fixture are both CSV with that delimiter; anything else is left in place,
 * so that a future fixture using another form fails loudly on load instead of silently loading less.
 */
const copyToInserts = (sql: string): string =>
  sql.replace(
    // the column list can hold a `)` of its own: `"(inside,parens)"` is a column name in there
    /^COPY\s+(.+?)\s*\(([\s\S]*?)\)\s+FROM STDIN CSV DELIMITER '\|';\n([\s\S]*?)^\\\.$/gm,
    (_all, table: string, cols: string, rows: string) => {
      const values = rows
        .split("\n")
        .filter((r) => r.trim() !== "")
        .map(
          (r) =>
            `(${r
              .split("|")
              .map((v) => lit(v.trim()))
              .join(", ")})`,
        );
      return `INSERT INTO ${table} (${cols}) VALUES\n${values.join(",\n")};`;
    },
  );

/** What the fixture needs that is PostgREST's configuration rather than its schema. */
const appSettings = `
-- PostgREST passes \`app.settings.*\` to each transaction from its own configuration (SpecHelper's
-- baseCfg). This engine has no such setting, so they are set on the database instead: both sides
-- then read the same values, which is what a differential comparison needs.
ALTER DATABASE %DB% SET "app.settings.app_host" = 'localhost';
ALTER DATABASE %DB% SET "app.settings.external_api_secret" = '0123456789abcdef';
`;

export interface UpstreamDb {
  readonly url: string;
  readonly adapter: DbAdapter;
  drop(): Promise<void>;
}

/**
 * Create a database, load PostgREST's fixtures into it and hand back an adapter on it. Unlike
 * `createTestDb`, there is no template: one database serves the whole suite (every write is rolled
 * back), so the fixture is loaded once.
 */
export const createUpstreamDb = async (): Promise<UpstreamDb> => {
  if (!ADMIN_URL) throw new Error("TEST_DATABASE_URL is not set");
  const admin = connect(ADMIN_URL);
  // One fixed name, not one per run: `roles.sql` drops and recreates four roles, which are
  // cluster-wide, so a second fixture database cannot exist beside the first anyway -- and a
  // leftover from an interrupted run would then make every later run fail on `DROP ROLE`.
  const name = FIXTURE_DB;
  await admin.unsafe(`DROP DATABASE IF EXISTS ${ident(name)} WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE ${ident(name)}`);
  await admin.close();

  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const user = decodeURIComponent(url.username) || "postgres";
  // The loading connection is closed before the one the engine is given: `ALTER DATABASE ... SET`
  // (which both `database.sql` and `appSettings` use) only reaches a session opened after it, and
  // PostgREST connects after the load. A connection that outlived the load would not see them.
  const loader = connect(url.toString());
  try {
    await loader.unsafe(
      copyToInserts(fixture).replaceAll(":DBNAME", ident(name)).replaceAll(':"PGUSER"', ident(user)) +
        appSettings.replaceAll("%DB%", ident(name)),
    );
  } catch (e) {
    await drop(name);
    throw e;
  } finally {
    await loader.close();
  }

  const sql = connect(url.toString());
  return {
    url: url.toString(),
    adapter: bunSqlAdapter(sql),
    async drop() {
      await sql.close();
      await drop(name);
    },
  };
};

const drop = async (name: string) => {
  const admin = connect(ADMIN_URL!);
  await admin.unsafe(`DROP DATABASE IF EXISTS ${ident(name)} WITH (FORCE)`);
  await admin.close();
};

/**
 * Explicit coordinates rather than `new SQL(url)`: a `PGDATABASE` in the environment wins over the
 * database an URL carries, and anyone who uses `psql` daily has one. Naming them leaves nothing for
 * the environment to decide.
 */
const connect = (url: string): SQL => {
  const u = new URL(url);
  return new SQL({
    hostname: u.hostname,
    port: Number(u.port || 5432),
    database: decodeURIComponent(u.pathname.slice(1)),
    username: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    max: 4,
  });
};
