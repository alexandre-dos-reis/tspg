import { expect, test } from "bun:test";
import { IR } from "@tanstack/db";
import type { LoadSubsetOptions } from "@tanstack/db";
import { buildQuery, compositeKey } from "../src/postgrest.ts";

const ref = (...p: string[]) => new IR.PropRef(p);
const val = (v: unknown) => new IR.Value(v);
const fn = (name: string, ...a: IR.BasicExpression[]) => new IR.Func(name, a);
const q = (where?: IR.BasicExpression, extra: Partial<LoadSubsetOptions> = {}) =>
  decodeURIComponent(buildQuery({ where: where as never, ...extra }));
const asc = (e: IR.BasicExpression) =>
  [{ expression: e, compareOptions: { direction: "asc", nulls: "last" } }] as never;

test("comparisons, either way round", () => {
  expect(q(fn("eq", ref("a"), val(1)))).toBe("select=*&a=eq.1");
  expect(q(fn("gt", ref("a"), val(1)))).toBe("select=*&a=gt.1");
  expect(q(fn("gte", ref("a"), val(1)))).toBe("select=*&a=gte.1");
  expect(q(fn("lt", ref("a"), val(1)))).toBe("select=*&a=lt.1");
  expect(q(fn("lte", val(1), ref("a")))).toBe("select=*&a=gte.1"); // 1 <= a  ==  a >= 1
  expect(q(fn("eq", ref("a"), val(null)))).toBe("select=*&a=is.null");
  expect(q(fn("eq", ref("d"), val(new Date("2026-01-02T00:00:00Z"))))).toBe("select=*&d=eq.2026-01-02T00:00:00.000Z");
});

test("in, like, ilike, isNull, isUndefined, boolean column", () => {
  expect(q(fn("in", ref("a"), val([1, "x y"])))).toBe('select=*&a=in.(1,"x+y")'); // form-encoded space
  expect(q(fn("like", ref("a"), val("ab%")))).toBe("select=*&a=like.ab%");
  expect(q(fn("ilike", ref("a"), val("ab%")))).toBe("select=*&a=ilike.ab%");
  expect(q(fn("isNull", ref("a")))).toBe("select=*&a=is.null");
  expect(q(fn("isUndefined", ref("a")))).toBe("select=*&a=is.null");
  expect(q(ref("done"))).toBe("select=*&done=is.true");
});

test("logic, nested paths", () => {
  expect(q(fn("and", fn("eq", ref("a"), val(1)), fn("eq", ref("b"), val(2))))).toBe("select=*&a=eq.1&b=eq.2");
  expect(q(fn("or", fn("eq", ref("a"), val(1)), fn("gt", ref("b"), val(2))))).toBe("select=*&or=(a.eq.1,b.gt.2)");
  expect(q(fn("eq", ref("meta", "k"), val("v")))).toBe("select=*&meta->>k=eq.v");
});

test("negation keeps NULL rows (a superset; TanStack DB then decides)", () => {
  expect(q(fn("not", fn("eq", ref("a"), val(1))))).toBe("select=*&or=(a.not.eq.1,a.is.null)");
  expect(q(fn("not", fn("isNull", ref("a"))))).toBe("select=*&a=not.is.null");
  expect(q(fn("not", fn("and", fn("eq", ref("a"), val(1)), fn("eq", ref("b"), val(2)))))).toBe(
    "select=*&or=(or(a.not.eq.1,a.is.null),or(b.not.eq.2,b.is.null))",
  );
  expect(q(fn("not", fn("not", fn("eq", ref("a"), val(1)))))).toBe("select=*&a=eq.1");
});

test("lower/upper equality -> ilike, escaped", () => {
  expect(q(fn("eq", fn("lower", ref("n")), val("a_b%")))).toBe("select=*&n=ilike.a\\_b\\%");
  expect(q(fn("eq", fn("upper", ref("n")), val("AB")))).toBe("select=*&n=ilike.AB");
});

test("coalesce(col, default) compared to a constant", () => {
  expect(q(fn("gt", fn("coalesce", ref("p"), val(0)), val(5)))).toBe("select=*&p=gt.5"); // 0 > 5 false
  expect(q(fn("lt", fn("coalesce", ref("p"), val(0)), val(5)))).toBe("select=*&or=(p.lt.5,p.is.null)"); // 0 < 5 true
});

test("operators PostgREST cannot express fall back to client filtering, without a limit", () => {
  for (const name of ["length", "concat", "add", "subtract", "multiply", "divide", "caseWhen", "count"]) {
    const where = fn("gt", fn(name, ref("a"), val(1)), val(3));
    const out = q(where, { orderBy: asc(ref("a")), limit: 10, offset: 5 });
    expect(out).toBe("select=*&order=a.asc.nullslast");
  }
  // column-to-column
  expect(q(fn("eq", ref("a"), ref("b")), { limit: 3 })).toBe("select=*");
  // unsupported conjunct is dropped, the supported one is kept
  expect(q(fn("and", fn("eq", ref("a"), val(1)), fn("gt", fn("length", ref("s")), val(3))))).toBe("select=*&a=eq.1");
  // an unsupported OR branch frees the whole OR
  expect(q(fn("or", fn("eq", ref("a"), val(1)), fn("gt", fn("length", ref("s")), val(3))))).toBe("select=*");
  // negation never narrows a widened sub-expression
  expect(q(fn("not", fn("and", fn("eq", ref("a"), val(1)), fn("gt", fn("length", ref("s")), val(3)))))).toBe(
    "select=*",
  );
  expect(q(fn("not", fn("or", fn("eq", ref("a"), val(1)), fn("gt", fn("length", ref("s")), val(3)))))).toBe(
    "select=*&or=(a.not.eq.1,a.is.null)",
  );
});

test("limit/offset only with a pushable order and an exact where", () => {
  const exact = fn("eq", ref("a"), val(1));
  expect(q(exact, { orderBy: asc(ref("a")), limit: 2, offset: 4 })).toBe(
    "select=*&a=eq.1&order=a.asc.nullslast&limit=2&offset=4",
  );
  expect(q(exact, { orderBy: asc(fn("upper", ref("a"))), limit: 2 })).toBe("select=*&a=eq.1");
  expect(
    q(exact, {
      orderBy: [
        {
          expression: ref("a"),
          compareOptions: { direction: "asc", nulls: "last", stringSort: "locale", locale: "fr" },
        },
      ] as never,
      limit: 2,
    }),
  ).toBe("select=*&a=eq.1");
});

test("compositeKey", () => {
  expect(compositeKey(["id"], { id: 7 })).toBe(7);
  expect(compositeKey(["order_id", "line"], { order_id: 12, line: 3 })).toBe("12_3");
  expect(compositeKey(["b", "a"], { a: "x", b: "y" })).toBe("y_x"); // the order of the key, not of the row
});
