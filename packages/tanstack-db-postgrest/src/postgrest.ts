import { parseOrderByExpression } from "@tanstack/db";
import type { LoadSubsetOptions } from "@tanstack/db";

/** A filter, as a small tree, before it is written in PostgREST syntax. */
type Cmp = { t: "cmp"; col: string; op: string; val: string };
type Node = Cmp | { t: "and" | "or"; items: Node[] } | { t: "not"; item: Node };

/** `["a", "b"]` -> `a->>b` (text, for comparisons); a single name stays itself. */
function column(path: Array<string | number>): string {
  const [head, ...rest] = path.map(String);
  if (rest.length === 0) return head!;
  const last = rest.pop()!;
  return [head, ...rest.map((k) => `->${k}`), `->>${last}`].join("");
}

/** A value inside `in.(…)`, `or(…)`, `and(…)`: quoted when it holds a reserved character. */
function quoted(v: string): string {
  return /[,.:()"\\\s]/.test(v) || v === "" ? `"${v.replace(/["\\]/g, "\\$&")}"` : v;
}

function scalar(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

type Expr =
  | { type: "ref"; path: Array<string | number> }
  | { type: "val"; value: unknown }
  | { type: "func"; name: string; args: Expr[] }
  | { type: string };

interface Ctx {
  /** True once a predicate was dropped or widened: the server then returns a superset. */
  inexact: boolean;
}

const FLIP: Record<string, string> = { eq: "eq", gt: "lt", gte: "lte", lt: "gt", lte: "gte" };
const mk = (col: string, op: string, val: string): Cmp => ({ t: "cmp", col, op, val });
const isNull = (col: string): Cmp => mk(col, "is", "null");
const orNode = (...items: Node[]): Node => ({ t: "or", items });
const andNode = (items: Node[]): Node => ({ t: "and", items });
/** `NOT p`, widened so rows where the column is NULL stay in: a superset whatever the client's null logic (TanStack DB's is three-valued and then drops them). */
const negate = (n: Cmp): Node =>
  n.op === "is" ? mk(n.col, "not.is", n.val) : orNode({ t: "not", item: n }, isNull(n.col));

/** `LIKE` pattern matching `s` literally. */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, "\\$&");

/**
 * One TanStack DB expression -> a PostgREST filter, as a **superset**:
 * every row satisfying the expression (or, with `neg`, its negation) is
 * guaranteed to satisfy the result. `null` means "no constraint". Whatever
 * PostgREST cannot say (`upper`/`length`/`concat`/arithmetic/`caseWhen`/
 * aggregates on a column, column-to-column comparisons…) is left out and sets
 * `ctx.inexact`; TanStack DB re-applies the whole `where` locally, so results
 * stay correct. Negation is pushed down (De Morgan) so that a widened
 * sub-expression is never inverted into a narrowing one.
 */
function tr(e: Expr, neg: boolean, ctx: Ctx): Node | null {
  const give = (): null => ((ctx.inexact = true), null);

  if (e.type === "ref") {
    const col = column((e as { path: Array<string | number> }).path);
    return neg ? orNode(mk(col, "is", "false"), isNull(col)) : mk(col, "is", "true");
  }
  if (e.type === "val") {
    const v = (e as { value: unknown }).value;
    return v === !neg ? null : give();
  }
  if (e.type !== "func") return give();

  const { name, args } = e as { name: string; args: Expr[] };
  switch (name) {
    case "and":
    case "or": {
      const conj = (name === "and") !== neg; // De Morgan under negation
      const parts = args.map((a) => tr(a, neg, ctx));
      if (conj) return parts.some((p) => p) ? andNode(parts.filter((p): p is Node => p !== null)) : null;
      if (parts.some((p) => p === null)) return null; // an unconstrained branch frees the whole OR
      return orNode(...(parts as Node[]));
    }
    case "not":
      return tr(args[0]!, !neg, ctx);
    case "isNull":
    case "isUndefined": {
      const c = colOf(args[0]);
      if (!c) return give();
      return neg ? mk(c, "not.is", "null") : isNull(c);
    }
    case "in": {
      const c = colOf(args[0]);
      const v = (args[1] as { value?: unknown } | undefined)?.value;
      if (!c || !Array.isArray(v)) return give();
      const n = mk(c, "in", `(${v.map((x) => quoted(scalar(x))).join(",")})`);
      return neg ? negate(n) : n;
    }
    case "like":
    case "ilike": {
      const c = colOf(args[0]);
      const v = (args[1] as { value?: unknown } | undefined)?.value;
      if (!c || typeof v !== "string") return give();
      const n = mk(c, name, v);
      return neg ? negate(n) : n;
    }
    case "eq":
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const r = comparison(name, args[0]!, args[1]!);
      if (!r) return give();
      return neg ? negateTree(r) : r;
    }
    default:
      return give(); // upper, lower, length, concat, add…, coalesce, caseWhen, aggregates alone
  }
}

function colOf(e: Expr | undefined): string | null {
  return e?.type === "ref" ? column((e as { path: Array<string | number> }).path) : null;
}

/** Negate a positive comparison tree built by `comparison`. */
function negateTree(n: Node): Node {
  if (n.t === "cmp") return negate(n);
  if (n.t === "not") return n.item;
  if (n.t === "or") return andNode(n.items.map(negateTree)); // NOT (a OR b) = NOT a AND NOT b
  if (n.t === "and") return orNode(...n.items.map(negateTree));
  return n;
}

/**
 * `column <op> value`, either way round, with the column optionally wrapped in
 * `lower`/`upper` (case-insensitive equality -> `ilike`) or `coalesce(col, c)`.
 */
function comparison(op: string, a: Expr, b: Expr): Node | null {
  if (a.type === "val" && b.type !== "val") return comparison(FLIP[op]!, b, a);
  if (b.type !== "val") return null;
  const v = (b as { value: unknown }).value;
  if (v === undefined) return null;

  if (a.type === "ref") {
    const col = colOf(a)!;
    if (v === null) return op === "eq" ? isNull(col) : null;
    return mk(col, op, scalar(v));
  }
  if (a.type !== "func") return null;
  const { name, args } = a as { name: string; args: Expr[] };

  if ((name === "lower" || name === "upper") && op === "eq" && typeof v === "string") {
    const c = colOf(args[0]);
    return c ? mk(c, "ilike", likeEscape(v)) : null; // superset: folding differs only on exotic Unicode
  }
  if (name === "coalesce" && args.length === 2 && args[1]!.type === "val" && v !== null) {
    const c = colOf(args[0]);
    if (!c) return null;
    const d = (args[1] as { value: unknown }).value;
    const base = mk(c, op, scalar(v));
    return constHolds(op, d, v) ? orNode(base, isNull(c)) : base; // NULL rows take the default
  }
  return null;
}

function constHolds(op: string, d: unknown, v: unknown): boolean {
  const x = d as never,
    y = v as never;
  return op === "eq" ? x === y : op === "gt" ? x > y : op === "gte" ? x >= y : op === "lt" ? x < y : x <= y;
}

/** Where expression -> filter tree (a superset; see `tr`). */
function toTree(where: LoadSubsetOptions["where"], ctx: Ctx): Node | null {
  return where ? tr(where as unknown as Expr, false, ctx) : null;
}

/** Inside `and(…)`/`or(…)`: `col.op.val`. Values there need quoting. */
function inline(n: Node): string {
  switch (n.t) {
    case "cmp":
      return `${n.col}.${n.op}.${n.op === "in" ? n.val : quoted(n.val)}`;
    case "not":
      return n.item.t === "cmp"
        ? `${n.item.col}.not.${n.item.op}.${n.item.op === "in" ? n.item.val : quoted(n.item.val)}`
        : `not.${inline(n.item)}`;
    default:
      return `${n.t}(${n.items.map(inline).join(",")})`;
  }
}

/** Top level: a conjunction becomes one query-string parameter per term. */
function emit(n: Node, out: URLSearchParams): void {
  switch (n.t) {
    case "and":
      for (const i of n.items) emit(i, out);
      return;
    case "or":
      out.append("or", `(${n.items.map(inline).join(",")})`);
      return;
    case "not":
      if (n.item.t === "cmp") out.append(n.item.col, `not.${n.item.op}.${n.item.val}`);
      else if (n.item.t === "not") emit(n.item.item, out); // not(not(x)) = x
      else out.append(`not.${n.item.t}`, `(${n.item.items.map(inline).join(",")})`);
      return;
    case "cmp":
      out.append(n.col, `${n.op}.${n.val}`);
  }
}

export interface BuildQueryOptions {
  /** PostgREST `select` (columns, embeds). Default `*`. */
  select?: string;
  /** Extra filters that are always applied (e.g. `{ deleted_at: "is.null" }`). */
  filters?: Record<string, string>;
}

/**
 * TanStack DB's `loadSubsetOptions` (where / orderBy / limit / offset / cursor)
 * -> a PostgREST query string.
 *
 * Cursor pagination is served from `cursor.whereFrom` only, so rows that tie
 * on the cursor value with the previous page's last row are not re-fetched.
 */
export function buildQuery(subset: LoadSubsetOptions | undefined | null, options: BuildQueryOptions = {}): string {
  const q = new URLSearchParams();
  q.set("select", options.select ?? "*");
  for (const [k, v] of Object.entries(options.filters ?? {})) q.append(k, v);

  const ctx: Ctx = { inexact: false };
  const nodes = [subset?.where, subset?.cursor?.whereFrom]
    .map((w) => toTree(w, ctx))
    .filter((n): n is Node => n !== null);
  for (const n of nodes) emit(n, q);

  // Server order must equal TanStack DB's, or a limited prefix would be the wrong rows.
  // A custom comparator or an explicit locale cannot be expressed; the default string sort is
  // pushed down (it then follows the database collation, which is a deployment concern).
  let ordered = true;
  let sorts: ReturnType<typeof parseOrderByExpression> = [];
  try {
    sorts = parseOrderByExpression(subset?.orderBy);
    if (sorts.some((s) => s.compare || s.stringSort === "custom" || s.locale || s.localeOptions)) ordered = false;
  } catch {
    ordered = false; // ORDER BY on an expression, not a column
  }
  if (ordered && sorts.length > 0) {
    q.set("order", sorts.map((s) => `${column(s.field)}.${s.direction}.nulls${s.nulls}`).join(","));
  }
  // A page of a widened or unordered set is not the page the client asked for.
  const pageable = ordered && !ctx.inexact;
  if (pageable && subset?.limit !== undefined) q.set("limit", String(subset.limit));
  if (pageable && subset?.offset) q.set("offset", String(subset.offset));
  return q.toString();
}

/**
 * The collection key of a row: its primary-key value, or, for a composite key, the values
 * joined with `_` in the order of the key columns (`12_3`). Values containing `_` can make two
 * different keys collide (`a_b` + `c` and `a` + `b_c`): use another key if yours can.
 */
export function compositeKey(pk: readonly string[], row: Record<string, unknown>): string | number {
  if (pk.length === 1) {
    const v = row[pk[0]!];
    return typeof v === "number" || typeof v === "string" ? v : String(v); // a key is a string or a number
  }
  return pk.map((k) => String(row[k])).join("_");
}

/** `col=eq.value` for each primary-key column of a row (composite keys supported). */
export function keyFilter(pk: readonly string[], row: Record<string, unknown>): URLSearchParams {
  const q = new URLSearchParams();
  for (const k of pk) {
    const v = row[k];
    if (v === undefined || v === null) throw new Error(`tspg: row has no value for primary key "${k}"`);
    q.append(k, `eq.${scalar(v)}`);
  }
  return q;
}

/** What a PostgREST-compatible server answers on failure: `{ code, message, details, hint }`. */
export class TspgError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly details: string | null | undefined;
  readonly hint: string | null | undefined;
  constructor(
    status: number,
    code: string | undefined,
    message: string,
    details?: string | null,
    hint?: string | null,
  ) {
    super(message);
    this.name = "TspgError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.hint = hint;
  }
}
