import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/query-core";
import { createCollection } from "@tanstack/db";
// A type-only import, as in a browser bundle: the generated module has no runtime content.
import type { DatabasePgRest as Database } from "../../../tests/support/fixture.types";
import { tspgClient, type TspgRow } from "../src/index";

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
