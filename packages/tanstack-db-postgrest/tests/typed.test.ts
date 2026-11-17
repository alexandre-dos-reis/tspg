import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/query-core";
import { createCollection } from "@tanstack/db";
import { tspgClient, type TspgRow } from "../src/index";

/** What `generate()` writes for these tables: the `Database` type of a browser bundle. */
type Table<Row extends object, Pk extends readonly string[], W extends boolean = true, Insert extends object = Row> = {
  row: Row;
  insert: Insert;
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
      orders: Table<
        { id: number; client_id: number; total: number | null },
        ["id"],
        true,
        { id: number; client_id: number; total?: number | null }
      >;
      order_items: Table<{ order_id: number; product_id: number; qty: number }, ["order_id", "product_id"]>;
      profiles: Table<{ client_id: number; bio: string | null }, ["client_id"]>;
      client_totals: Table<{ client_id: number; revenue: number | null }, [], false>;
    };
    v2: { things: Table<{ id: number; name: string }, ["id"]> };
  };
};

// What `generate()` emits for these tables (the generator is tested in generate.test.ts, against
// `compositeKey`): a view has no primary key, so no entry.
const keys = {
  default: "api",
  schemas: {
    api: {
      orders: { pk: ["id"], key: (row: { id: number }) => row.id },
      order_items: {
        pk: ["order_id", "product_id"],
        key: (row: { order_id: number; product_id: number }) => `${row.order_id}_${row.product_id}`,
      },
      profiles: { pk: ["client_id"], key: (row: { client_id: number }) => row.client_id },
    },
    v2: { things: { pk: ["id"], key: (row: { id: number }) => row.id } },
  },
} as const;

const calls: { method: string; url: string; headers: Record<string, string> }[] = [];
const tspg = tspgClient<Database>({
  url: "http://x/api",
  queryClient: new QueryClient(),
  keys,
  fetch: (async (url: string, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? "GET",
      url: decodeURIComponent(url),
      headers: init?.headers as Record<string, string>,
    });
    if (init?.method === "PATCH") return new Response("[]");
    return new Response(
      url.includes("/order_items") ? JSON.stringify([{ order_id: 12, product_id: 3, qty: 1 }]) : "[]",
    );
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

test("only the tables that exist", () => {
  // @ts-expect-error there is no such table
  expect(() => tspg.collectionOptions("nope")).toThrow("no key");
});

test("the key comes from the generated keys: nothing to name, and no primaryKey option", async () => {
  tspg.collectionOptions("orders");
  tspg.collectionOptions("order_items");
  // @ts-expect-error the key is the database's: it is not an option
  tspg.collectionOptions("order_items", { primaryKey: ["order_id"] });

  const lines = createCollection(tspg.collectionOptions("order_items", { syncMode: "eager" }));
  await lines.preload();
  expect([...lines.keys()]).toEqual(["12_3"]);
  await lines
    .update("12_3", (d) => {
      d.qty = 5;
    })
    .when("settled");
  expect(calls.find((c) => c.method === "PATCH")!.url).toEndWith("/order_items?order_id=eq.12&product_id=eq.3");
});

test("a view has no primary key: it names the columns that identify a row, and is read-only", () => {
  const compiles = () => {
    tspg.collectionOptions("client_totals", { keyColumns: ["client_id"], readOnly: true });
    // @ts-expect-error a view has no key to generate: the columns have to be named
    tspg.collectionOptions("client_totals", { readOnly: true });
    // @ts-expect-error client_totals accepts no write: `readOnly: true` is required
    tspg.collectionOptions("client_totals", { keyColumns: ["client_id"] });
    // @ts-expect-error not a column of the view
    tspg.collectionOptions("client_totals", { keyColumns: ["nope"], readOnly: true });
    // @ts-expect-error `readOnly: false` is refused on a view
    tspg.collectionOptions("client_totals", { keyColumns: ["client_id"], readOnly: false });
  };
  expect(compiles).toBeTypeOf("function"); // checked by the compiler, never run
});

test("insert() takes the generated insert shape: the key is required, the columns the database fills are not", async () => {
  const orders = createCollection(tspg.collectionOptions("orders", { omitOnInsert: ["id"] }));
  const compiles = () => {
    orders.insert({ id: -1, client_id: 7 }); // `total` may be left out
    // @ts-expect-error the key is required: the optimistic row is held by it
    orders.insert({ client_id: 7 });
    // @ts-expect-error `client_id` is required
    orders.insert({ id: -1 });
    // reads are typed by the row
    const total: number | null | undefined = orders.get(1)?.total;
    void total;
  };
  expect(compiles).toBeTypeOf("function"); // checked by the compiler, never run

  // at run time the temporary key is held by the collection and kept out of the POST body
  await orders.insert({ id: -1, client_id: 7 }).when("settled");
  const post = calls.find((c) => c.method === "POST");
  expect(post?.url).toEndWith("/orders");
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
  const compiles = () => {
    // @ts-expect-error `things` lives in v2, not in the default schema
    tspg.collectionOptions("things");
    // @ts-expect-error no such schema
    tspg.schema("v3");
  };
  expect(compiles).toBeTypeOf("function"); // checked by the compiler, never run
});

test("the default schema sends no profile", async () => {
  const orders = createCollection(tspg.collectionOptions("orders", { syncMode: "eager" }));
  await orders.preload();
  const call = calls.find((c) => c.url.includes("/orders"))!;
  expect(call.headers["Accept-Profile"]).toBeUndefined();
});

test("keys that do not match the Database are refused", () => {
  tspgClient<Database>({
    url: "/api",
    queryClient: new QueryClient(),
    // @ts-expect-error order_items' key is (order_id, product_id), and the other tables are missing
    keys: { default: "api", schemas: { api: { order_items: { pk: ["order_id"], key: () => 1 } } } },
  });
});
