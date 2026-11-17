// What `gen:types` reads: a PGlite database on disk (./.pglite) made from schema.sql. A real project points
// `tspg-db generate` at its own database (`--url`) and has no such step.
import { readFileSync, rmSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

rmSync(new URL("./.pglite", import.meta.url), { recursive: true, force: true });
const pglite = new PGlite(new URL("./.pglite", import.meta.url).pathname);
await pglite.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
await pglite.close();
