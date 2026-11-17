import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { pgliteAdapter } from "../../adapters/src/pglite";
import { columnType, fromDescriptor, introspect, literal, toDescriptor, tsKey } from "../src/index";
import type { SchemaCache } from "../src/index";

let pg: PGlite;
let cache: SchemaCache;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE SCHEMA api;
    CREATE TYPE api.mood AS ENUM ('sad', 'ok', 'happy');
    CREATE TABLE api.clients (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text NOT NULL, mood api.mood);
    CREATE TABLE api.lines (
      order_id int NOT NULL, line int NOT NULL, qty int DEFAULT 1, tags text[],
      PRIMARY KEY (order_id, line)
    );
    CREATE VIEW api.totals AS SELECT order_id, sum(qty)::int AS total FROM api.lines GROUP BY order_id;
  `);
  cache = await introspect({ db: pgliteAdapter(pg), schemas: ["api"] });
});

afterAll(() => pg.close());

describe("introspect", () => {
  test("relations, columns and primary keys", () => {
    const rels = [...cache.relations.values()].map((r) => r.name).sort();
    expect(rels).toEqual(["clients", "lines", "totals"]);
    const clients = cache.relations.get("api.clients")!;
    expect(clients.pk).toEqual(["id"]);
    expect(clients.columns.find((c) => c.name === "id")!.identity).toBe("always");
    expect(cache.relations.get("api.lines")!.pk).toEqual(["order_id", "line"]);
    expect(cache.relations.get("api.totals")!.kind).toBe("view");
    expect(cache.relations.get("api.totals")!.updatable).toBe(false);
  });

  test("the schemas default to public", async () => {
    const c = await introspect({ db: pgliteAdapter(pg) });
    expect([...c.schemas]).toEqual(["public"]);
  });

  test("the descriptor round-trips", () => {
    const again = fromDescriptor(toDescriptor(cache));
    expect([...again.relations.keys()].sort()).toEqual([...cache.relations.keys()].sort());
  });
});

describe("columnType: SQL type -> TypeScript type", () => {
  const col = (type: string, extra: object = {}) => columnType({ type, ...extra });
  test("scalars", () => {
    expect(col("integer")).toBe("number");
    expect(col("numeric(10,2)")).toBe("number");
    expect(col("boolean")).toBe("boolean");
    expect(col("character varying(10)")).toBe("string");
    expect(col("timestamp with time zone")).toBe("string");
    expect(col("jsonb")).toBe("unknown"); // plausible is worse than honest
  });
  test("enums and arrays", () => {
    expect(col("api.mood", { enumLabels: ["sad", "ok"] })).toBe('"sad" | "ok"');
    expect(col("text[]")).toBe("string[]");
    expect(col("api.mood[]", { enumLabels: ["a", "b"] })).toBe('("a" | "b")[]');
  });
  test("what the catalog gives for a real table", () => {
    const lines = cache.relations.get("api.lines")!;
    expect(columnType(lines.columns.find((c) => c.name === "tags")!)).toBe("string[]");
    const mood = cache.relations.get("api.clients")!.columns.find((c) => c.name === "mood")!;
    expect(columnType(mood)).toBe('"sad" | "ok" | "happy"');
  });
});

test("tsKey quotes what is not an identifier", () => {
  expect(tsKey("ok")).toBe("ok");
  expect(tsKey("odd col")).toBe('"odd col"');
});

test("literal escapes quotes and stops at a NUL", () => {
  expect(literal("it's")).toBe("'it''s'");
  expect(literal("a\0b")).toBe("'a'");
});
