import { describe, expect, test } from "bun:test";
import type { Column, Relation, SchemaCache } from "../packages/core/src/schema";
import { generateKeys } from "../packages/query/src/types";
import { compositeKey } from "../packages/tanstack-db/src/postgrest";

/**
 * `@tspg/query` generates the code that builds a collection key and `@tspg/tanstack-db` builds the same
 * key by hand when it is not given that code. Neither package's tests name the other, so the guarantee
 * that the two agree is pinned here, where they meet.
 */
const column = (name: string, type: string): Column => ({
  name,
  type,
  nullable: false,
  hasDefault: false,
  defaultExpr: null,
  generated: false,
  comment: null,
  position: 0,
});

const relation = (name: string, columns: Column[], pk: string[]): Relation => ({
  schema: "api",
  name,
  kind: "table",
  columns: columns.map((c, i) => ({ ...c, position: i + 1 })),
  pk,
  uniques: [],
  insertable: true,
  updatable: true,
  deletable: true,
  comment: null,
});

const cache: SchemaCache = {
  schemas: ["api"],
  relations: new Map(
    [
      relation("todos", [column("id", "bigint")], ["id"]),
      relation(
        "order_items",
        [column("order_id", "integer"), column("product_id", "uuid")],
        ["order_id", "product_id"],
      ),
      relation("triple", [column("a", "integer"), column("b", "text"), column("c", "integer")], ["c", "a", "b"]),
    ].map((r) => [`api.${r.name}`, r]),
  ),
  foreignKeys: [],
  functions: new Map(),
  mediaHandlers: [],
  composites: new Map(),
};

describe("generated key construction == compositeKey", () => {
  test("the same key, for one column and for several, in the order of the key", async () => {
    const js = new Bun.Transpiler({ loader: "ts" }).transformSync(await generateKeys(cache, { header: false }));
    const { keys } = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
    const rows: Record<string, Record<string, unknown>> = {
      todos: { id: 42 },
      order_items: { order_id: 12, product_id: "p-3" },
      triple: { a: 1, b: "x", c: 9 },
    };
    for (const [table, row] of Object.entries(rows)) {
      const { pk, key } = keys.schemas.api[table];
      expect(key(row)).toBe(compositeKey(pk, row));
    }
    expect(keys.schemas.api.triple.key(rows.triple)).toBe("9_1_x");
  });
});
