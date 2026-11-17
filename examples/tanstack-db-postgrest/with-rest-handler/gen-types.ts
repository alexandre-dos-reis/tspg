// Step 1: write the module the client needs. Run it again after a migration.
//   node gen-types.ts
//
// It reads the catalog of the database and writes db.generated.ts: the `Database` type, and `keys`, the
// primary key of every table and the code that builds a row's collection key from it. That is all the
// client takes from the database, so the browser bundle holds no schema and no introspection.
import { readFileSync, writeFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pgliteAdapter } from "@tspg/introspect/adapters/pglite";
import { generate } from "@tspg/tanstack-db-postgrest/generate";

const pglite = new PGlite();
await pglite.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));

const module = await generate({ db: pgliteAdapter(pglite), schemas: ["api"] });
writeFileSync(new URL("./db.generated.ts", import.meta.url), module);
console.log(`db.generated.ts: ${module.split("\n").length} lines`);

await pglite.close();
