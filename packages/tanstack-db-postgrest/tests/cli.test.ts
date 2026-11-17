import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli";

let dir: string;
const logs: string[] = [];
const errors: string[] = [];
const run = (...argv: string[]) => {
  logs.length = 0;
  errors.length = 0;
  return runCli(argv, { log: (l) => logs.push(l), error: (l) => errors.push(l), env: {}, cwd: dir });
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tspg-db-"));
  writeFileSync(
    join(dir, "schema.sql"),
    `CREATE SCHEMA api; CREATE TABLE api.todos (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, title text NOT NULL);`,
  );
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("generate --pglite writes the module", async () => {
  expect(
    await run("generate", "--pglite", "memory://", "--sql", "schema.sql", "--schemas", "api", "--out", "out/db.ts"),
  ).toBe(0);
  const out = readFileSync(join(dir, "out/db.ts"), "utf8");
  expect(out).toContain("export type Database = {");
  expect(out).toContain("export const keys = {");
  expect(out).toContain("export const collections = ");
  expect(out).toContain("row: { id: number; title: string };");
  expect(logs[0]).toStartWith("out/db.ts: ");
});

test("the names of the exports are options", async () => {
  const code = await run(
    "generate",
    "--pglite",
    "memory://",
    "--sql",
    "schema.sql",
    "--schemas",
    "api",
    "--out",
    "-",
    "--name",
    "Db",
    "--keys-name",
    "pks",
    "--collections-name",
    "cols",
  );
  expect(code).toBe(0);
  expect(logs.join("\n")).toContain("export type Db = {");
  expect(logs.join("\n")).toContain("export const pks = {");
  expect(logs.join("\n")).toContain("export const cols = ");
});

test("mistakes are said, and exit 1", async () => {
  expect(await run("generate")).toBe(1);
  expect(errors[0]).toContain("no database");
  expect(await run("generate", "--sql", "schema.sql")).toBe(1);
  expect(errors[0]).toContain("--sql needs --pglite");
  expect(await run("generate", "--driver", "pg", "--url", "x")).toBe(1); // no choice of driver
  expect(await run("generate", "--pglite", "memory://", "--url", "x")).toBe(1);
  expect(errors[0]).toContain("cannot be combined");
  expect(await run("migrate")).toBe(1);
  expect(await run("generate", "--nope")).toBe(1);
  expect(await run("--help")).toBe(0);
  expect(logs[0]).toContain("Usage");
});
