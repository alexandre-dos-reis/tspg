// Node-side: the command line of `generate` (`tspg-db`, built as `dist/bin.js`). It reads the catalog of a database
// -- `--url` with the `pg` it bundles, or `--sql` into a throwaway PGlite -- and writes the module a client imports, so an
// application never imports the generator or the introspection (`@tspg/introspect` is inlined into the build).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import pg from "pg";
import type { DbAdapter } from "@tspg/introspect";
import { nodePostgresAdapter } from "../../adapters/src/node-postgres";
import { pgliteAdapter } from "../../adapters/src/pglite";
import { generate } from "./generate";

export const USAGE = `tspg-db: write the module a @tspg/tanstack-db-postgrest client imports (the Database type, the
keys of every table and its TanStack DB collections), from the catalog of a Postgres database.

Usage
  tspg-db generate [options]

Where the catalog is read from (one of the two)
  --url <url>          a Postgres connection string (default: $DATABASE_URL)
  --sql <file>         a SQL file: its schema is built in a throwaway PGlite database, which is read instead.
                       Needs @electric-sql/pglite; cannot be combined with --url

What is written
  --schemas <a,b>      the schemas to read, comma-separated (default: public); the first is the default
                       schema of the client
  --out <file>         the file to write (default: db.generated.ts); "-" writes to the standard output
  --name <name>        name of the exported database type (default: Database)
  --keys-name <name>   name of the exported keys constant (default: keys)
  --collections-name <name>
                       name of the exported collections constant (default: collections)

  -h, --help           show this help

Examples
  tspg-db generate --url postgres://localhost/app --schemas api --out src/db.ts
  DATABASE_URL=postgres://localhost/app tspg-db generate --schemas api
  tspg-db generate --sql schema.sql --schemas api

Run it again after a migration. It exits with 1, and says why, when it cannot read the database or write the file.
`;

interface Io {
  readonly log: (line: string) => void;
  readonly error: (line: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Where relative paths are resolved from. */
  readonly cwd: string;
}

const nodeIo = (): Io => ({
  log: (l) => console.log(l),
  error: (l) => console.error(l),
  env: process.env,
  cwd: process.cwd(),
});

class UsageError extends Error {}

// `pg` is bundled into the build, so the command needs nothing installed. PGlite (WebAssembly, for `--sql`) is the
// project's own: loaded by name at run time, so a project that does not use `--sql` is not asked to install it.
// A module name held in a variable keeps the bundler from resolving it.
const load = async (name: string): Promise<any> => {
  try {
    return await import(name);
  } catch (e) {
    if (
      (e as { code?: string }).code === "ERR_MODULE_NOT_FOUND" ||
      (e as { code?: string }).code === "MODULE_NOT_FOUND"
    )
      return undefined;
    throw e;
  }
};

const connect = (url: string): DbAdapter => nodePostgresAdapter(new pg.Pool({ connectionString: url }));

const fromSql = async (file: string, io: Io): Promise<DbAdapter> => {
  const mod = await load("@electric-sql/pglite");
  if (!mod?.PGlite) throw new UsageError("@electric-sql/pglite is not installed here");
  const pglite = new mod.PGlite();
  await pglite.exec(readFileSync(resolve(io.cwd, file), "utf8"));
  return pgliteAdapter(pglite);
};

/**
 * `tspg-db generate`: what `argv` (without the node and script paths) asks for. Resolves to the exit code; it
 * prints its own errors.
 */
export const runCli = async (argv: ReadonlyArray<string>, io: Io = nodeIo()): Promise<number> => {
  let db: DbAdapter | undefined;
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        url: { type: "string" },
        sql: { type: "string" },
        schemas: { type: "string" },
        out: { type: "string" },
        name: { type: "string" },
        "keys-name": { type: "string" },
        "collections-name": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
    if (values.help || positionals.length === 0) {
      io.log(USAGE);
      return values.help ? 0 : 1;
    }
    if (positionals[0] !== "generate" || positionals.length > 1)
      throw new UsageError(`unknown command "${positionals.join(" ")}" (there is only "generate")`);
    if (values.sql !== undefined && values.url !== undefined)
      throw new UsageError("--sql cannot be combined with --url");

    if (values.sql !== undefined) db = await fromSql(values.sql, io);
    else {
      const url = values.url ?? io.env.DATABASE_URL;
      if (!url) throw new UsageError("no database: give --url, set DATABASE_URL, or build one from a file with --sql");
      db = connect(url);
    }

    const schemas = (values.schemas ?? "public")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const module = await generate(
      { adapter: db, schemas },
      {
        ...(values.name !== undefined ? { name: values.name } : {}),
        ...(values["keys-name"] !== undefined ? { keysName: values["keys-name"] } : {}),
        ...(values["collections-name"] !== undefined ? { collectionsName: values["collections-name"] } : {}),
      },
    );
    const out = values.out ?? "db.generated.ts";
    if (out === "-") io.log(module.trimEnd());
    else {
      const path = resolve(io.cwd, out);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, module);
      io.log(`${out}: ${module.split("\n").length} lines`);
    }
    return 0;
  } catch (e) {
    if (e instanceof UsageError || (e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS"))
      io.error(`tspg-db: ${(e as Error).message}\nRun tspg-db --help for the options.`);
    else io.error(`tspg-db: ${(e as Error).message}`);
    return 1;
  } finally {
    await db?.close?.().catch(() => {});
  }
};
