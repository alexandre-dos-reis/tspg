// Node-side: the command line of `generate`. It reads the catalog and writes the module a client
// imports -- so an application never imports the introspection (`@tspg/introspect` is inlined into the build).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { DbAdapter } from "@tspg/introspect";
import { nodePostgresAdapter } from "../../adapters/src/node-postgres";
import { pgliteAdapter } from "../../adapters/src/pglite";
import { generate } from "./generate";

export const USAGE = `tspg-db: generate the module a @tspg/tanstack-db-postgrest client imports

Usage
  tspg-db generate [options]

Where the catalog is read
  --url <url>          a Postgres connection string, read with pg (default: $DATABASE_URL)
  --pglite <dir>       read a PGlite database instead: a directory, or "memory://" for an empty one

What is written
  --schemas <a,b>      schemas to read (default: public); the first one is the default schema of the client
  --out <file>         output file (default: db.generated.ts); "-" writes to the standard output
  --name <name>        name of the exported database type (default: Database)
  --keys-name <name>   name of the exported keys constant (default: keys)
  --collections-name <name>
                       name of the exported collections constant (default: collections)

  -h, --help           show this help
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

// `pg` (and PGlite) are the project's own, not this package's: loaded by name at run time, so a project that does not
// use one is not asked to install it. A module name held in a variable keeps the bundler from resolving it.
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

const connect = async (url: string): Promise<DbAdapter> => {
  const mod = await load("pg");
  const Pool = mod?.Pool ?? mod?.default?.Pool;
  if (!Pool) throw new UsageError("pg is not installed here: add it with your package manager (npm i -D pg)");
  return nodePostgresAdapter(new Pool({ connectionString: url }));
};

const openPglite = async (dir: string, io: Io): Promise<DbAdapter> => {
  const mod = await load("@electric-sql/pglite");
  if (!mod?.PGlite) throw new UsageError("@electric-sql/pglite is not installed here");
  const pglite = new mod.PGlite(dir === "memory://" ? undefined : resolve(io.cwd, dir));
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
        pglite: { type: "string" },
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
    if (values.pglite !== undefined && values.url !== undefined)
      throw new UsageError("--pglite cannot be combined with --url");

    if (values.pglite !== undefined) db = await openPglite(values.pglite, io);
    else {
      const url = values.url ?? io.env.DATABASE_URL;
      if (!url) throw new UsageError("no database: give --url, set DATABASE_URL, or read a PGlite one with --pglite");
      db = await connect(url);
    }

    const schemas = (values.schemas ?? "public")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const module = await generate(
      { db, schemas },
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
