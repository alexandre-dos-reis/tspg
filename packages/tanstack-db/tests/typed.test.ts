import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/query-core";
import { createCollection } from "@tanstack/db";
import { tspgClient, type TspgRow } from "../src/index";

/** What `generate()` writes for these tables: the `Database` type of a browser bundle. */
type Table<Row extends object, Pk extends readonly string[], W extends boolean = true> = {
  row: Row;
  insert: Partial<Row>;
  update: Partial<Row>;
  pk: Pk;
  insertable: W;
  updatable: W;
  deletable: W;
};
type Database = {
  default: "api";
  schemas: {
    api: {
      orders: Table<{ id: number; client_id: number; total: number | null }, ["id"]>;
      order_items: Table<{ order_id: number; product_id: number; qty: number }, ["order_id", "product_id"]>;
      profiles: Table<{ client_id: number; bio: string | null }, ["client_id"]>;
      client_totals: Table<{ client_id: number; revenue: number | null }, [], false>;
    };
    v2: { things: Table<{ id: number; name: string }, ["id"]> };
  };
};

const calls: { url: string; headers: Record<string, string> }[] = [];
const tspg = tspgClient<Database>({
  url: "http://x/api",
  queryClient: new QueryClient(),
  fetch: (async (url: string, init?: RequestInit) => {
    calls.push({ url: decodeURIComponent(url), headers: init?.headers as Record<string, string> });
    return new Response("[]");
  }) as unknown as typeof fetch,
});

test("the row type comes from the generated type", () => {
  const orders = createCollection(tspg.collectionOptions("orders"));
  // `orders.get` returns the generated row: its columns are typed
  const total: number | undefined = orders.get(1)?.id;
  expect(total).toBeUndefined();

  type Order = TspgRow<Database, "orders">;
  const row: Order = {} as Order;
  void row.id;
  // @ts-expect-error not a column of orders
  void row.nope;
});

test("only the relations that exist", () => {
  // @ts-expect-error there is no such table
  tspg.collectionOptions("nope");
});

test("a primary key other than id has to be named, and must be the table's", () => {
  tspg.collectionOptions("orders"); // pk is ["id"]: the default holds
  tspg.collectionOptions("order_items", { primaryKey: ["order_id", "product_id"] });
  // @ts-expect-error order_items has a composite key: it must be given
  tspg.collectionOptions("order_items");
  // @ts-expect-error the key is not this table's
  tspg.collectionOptions("order_items", { primaryKey: ["order_id"] });
  tspg.collectionOptions("profiles", { primaryKey: ["client_id"] });
});

test("a relation that cannot be written is read-only", () => {
  // a view has no primary key: name the columns that identify a row, and say it is read-only
  tspg.collectionOptions("client_totals", { primaryKey: ["client_id"], readOnly: true });
  // @ts-expect-error client_totals accepts no write: `readOnly: true` is required
  tspg.collectionOptions("client_totals", { primaryKey: ["client_id"] });
  // @ts-expect-error not a column of the view
  tspg.collectionOptions("client_totals", { primaryKey: ["nope"], readOnly: true });
  // @ts-expect-error `readOnly: false` is refused on a view
  tspg.collectionOptions("client_totals", { primaryKey: ["client_id"], readOnly: false });
});

test("omitOnInsert and filters name real columns", () => {
  tspg.collectionOptions("orders", { omitOnInsert: ["id"], filters: { id: "gt.0" } });
  // @ts-expect-error not a column
  tspg.collectionOptions("orders", { omitOnInsert: ["nope"] });
});

test("another schema is chosen by name, and sent as a profile", async () => {
  const things = createCollection(tspg.schema("v2").collectionOptions("things", { syncMode: "eager" }));
  await things.preload();
  const call = calls.find((c) => c.url.includes("/things"))!;
  expect(call.headers["Accept-Profile"]).toBe("v2");
  // @ts-expect-error `things` lives in v2, not in the default schema
  tspg.collectionOptions("things");
  // @ts-expect-error no such schema
  tspg.schema("v3");
});

test("the default schema sends no profile", async () => {
  const orders = createCollection(tspg.collectionOptions("orders", { syncMode: "eager" }));
  await orders.preload();
  const call = calls.find((c) => c.url.includes("/orders"))!;
  expect(call.headers["Accept-Profile"]).toBeUndefined();
});

// What `generate()` emits for these tables (the generator is tested in generate.test.ts, against
// `compositeKey`).
const keys = {
  default: "api",
  schemas: {
    api: {
      orders: { pk: ["id"], key: (row: { id: number }) => row.id },
      order_items: {
        pk: ["order_id", "product_id"],
        key: (row: { order_id: number; product_id: number }) => `${row.order_id}_${row.product_id}`,
      },
    },
    v2: { things: { pk: ["id"], key: (row: { id: number }) => row.id } },
  },
} as const;

test("with the generated keys, the key columns and the key construction are not written by hand", async () => {
  const seen: { method: string; url: string }[] = [];
  const keyed = tspgClient<Database>({
    url: "http://x/api",
    queryClient: new QueryClient(),
    keys,
    fetch: (async (url: string, init?: RequestInit) => {
      seen.push({ method: init?.method ?? "GET", url: decodeURIComponent(url) });
      return new Response(init?.method === "PATCH" ? "[]" : JSON.stringify([{ order_id: 12, product_id: 3, qty: 1 }]));
    }) as unknown as typeof fetch,
  });
  const lines = createCollection(keyed.collectionOptions("order_items", { syncMode: "eager" })); // no primaryKey
  await lines.preload();
  expect([...lines.keys()]).toEqual(["12_3"]);

  await lines
    .update("12_3", (d) => {
      d.qty = 5;
    })
    .when("settled");
  expect(seen.find((c) => c.method === "PATCH")!.url).toEndWith("/order_items?order_id=eq.12&product_id=eq.3");

  // the key columns can still be named, and then the generated construction is not used
  keyed.collectionOptions("order_items", { primaryKey: ["order_id", "product_id"] });
  // a table without keys in the generated module still has to say its key
  // @ts-expect-error `things` is in v2, with a key of its own
  keyed.collectionOptions("things");
  keyed.schema("v2").collectionOptions("things");
  // @ts-expect-error a view has no key to generate, and is read-only
  keyed.collectionOptions("client_totals");
});

test("keys that do not match the Database are refused", () => {
  tspgClient<Database>({
    url: "/api",
    queryClient: new QueryClient(),
    // @ts-expect-error order_items' key is (order_id, product_id)
    keys: { default: "api", schemas: { api: { order_items: { pk: ["order_id"], key: () => 1 } } } },
  });
});
