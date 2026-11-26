import { ROOT_ALIAS } from "../constants";
import { EngineError } from "../errors";
import type { FilterNode } from "../parse/filter";
import { quoteIdent, quoteQualified } from "../quote";
import { pgrstKey, type Relation } from "../schema";
import { whereSql } from "./filters";
import { type Values, inlined } from "./values";

export type JsonObject = Record<string, unknown>;

/** What the data-modifying statement should RETURN. */
export type Returning = "representation" | "pk" | "minimal";

const returningSql = (rel: Relation, returning: Returning): string => {
  const alias = quoteIdent(ROOT_ALIAS);
  if (returning === "representation") return `${alias}.*`;
  // `return=headers-only` reads back the columns `Location` names
  const key = pgrstKey(rel);
  if (returning === "pk" && key.length > 0) return key.map((c) => `${alias}.${quoteIdent(c)}`).join(", ");
  return "1";
};

const columnNotFound = (rel: Relation, column: string) =>
  new EngineError(
    "unknown_column",
    `Could not find the '${column}' column of '${rel.name}' in the schema cache`,
    null,
    null,
  );

const checkColumns = (rel: Relation, cols: ReadonlyArray<string>): void => {
  const known = new Set(rel.columns.map((c) => c.name));
  for (const c of cols) if (!known.has(c)) throw columnNotFound(rel, c);
};

const unionKeys = (rows: ReadonlyArray<JsonObject>): string[] => {
  const seen = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) seen.add(k);
  return [...seen];
};

export interface InsertOptions {
  readonly rel: Relation;
  readonly rows: ReadonlyArray<JsonObject>;
  /** `columns=` query parameter: restrict which keys of the payload are used. */
  readonly columns?: ReadonlyArray<string> | undefined;
  readonly onConflict?: ReadonlyArray<string> | undefined;
  readonly resolution?: "merge-duplicates" | "ignore-duplicates" | undefined;
  readonly missingDefault?: boolean | undefined;
  /**
   * Count the rows an upsert really inserted, in `pgrst.inserted`; read back by
   * {@link buildStatement}. Set for a merge-duplicates upsert and for `PUT`, as PostgREST does
   * (`isInsert && (isPut || resolution == MergeDuplicates)`): it is what tells `201` from `200`.
   */
  readonly countInserted?: boolean | undefined;
  readonly returning: Returning;
}

/**
 * The columns of `ON CONFLICT (…)`: those of `on_conflict=`, or the primary key. The target itself is
 * the database's to check -- PostgREST forwards it, and an unknown column comes back as `42703`.
 */
const conflictTarget = (onConflict: ReadonlyArray<string> | undefined, rel: Relation): string[] =>
  onConflict && onConflict.length > 0 ? [...onConflict] : [...rel.pk];

/**
 * PostgREST's counter of really-inserted rows (`addConfigPgrstInserted` in `SqlFragment.hs`): a
 * predicate that is **always true** and moves `pgrst.inserted` by one. It goes on the `WHERE` of the
 * insert's source (`+1`, once per candidate row) and on the `WHERE` of `DO UPDATE` (`-1`, once per
 * row that turned out to exist), so what remains is the number of rows actually inserted.
 *
 * Each sentinel is the one value its own `set_config` cannot return at that point: after `+1` the
 * counter is at least 1, so it is never `'0'`; a row only reaches `DO UPDATE` after being counted,
 * so after `-1` it is at least 0 and never `'-1'`. The predicate is therefore true for every row,
 * and filters nothing.
 *
 * `set_config(…, true)` is transaction-local: the counter cannot outlive the request on a pooled
 * connection.
 *
 * The alternative -- `xmax = 0` on the returned rows, which tells an inserted tuple from an updated
 * one -- reads a **table** system column, so it cannot work through a view, a partitioned table or a
 * foreign table. PostgREST does not use it, and neither does this.
 */
const countingPredicate = (add: boolean): string =>
  `set_config('pgrst.inserted', (coalesce(nullif(current_setting('pgrst.inserted', true), '')::int, 0) ` +
  `${add ? "+" : "-"} 1)::text, true) <> '${add ? "0" : "-1"}'`;

/**
 * `INSERT … RETURNING …`. The payload is `$1` (JSON text, an array of objects);
 * it is always cast through `$1::text` so the driver never re-encodes it.
 */
export const buildInsert = (o: InsertOptions): string => {
  const { rel } = o;
  const table = quoteQualified(rel.schema, rel.name);
  const target = `${table} AS ${quoteIdent(ROOT_ALIAS)}`;
  const returning = returningSql(rel, o.returning);
  const cols = o.columns ? [...o.columns] : unionKeys(o.rows);
  if (!o.columns && o.rows.some((r) => Object.keys(r).length !== cols.length)) {
    throw new EngineError("invalid_body", "All object keys must match");
  }
  checkColumns(rel, cols);

  // PostgREST counts for `PUT` and for merge-duplicates only; `ignore-duplicates` never updates, so
  // every row it keeps is an insert and there is nothing to tell apart.
  const counting = Boolean(o.countInserted) && o.resolution === "merge-duplicates";
  const counted = (select: string, add: boolean) => (counting ? `${select} WHERE ${countingPredicate(add)}` : select);

  if (o.rows.length === 0) {
    // An empty array inserts nothing.
    const first = rel.columns[0];
    if (!first) throw new EngineError("invalid_body", "Cannot insert into a relation without columns");
    return `INSERT INTO ${target} (${quoteIdent(first.name)}) SELECT NULL WHERE FALSE RETURNING ${returning}`;
  }

  if (cols.length === 0) {
    // Only empty objects: one all-defaults row per element of the payload. No column list and a
    // **zero-column** SELECT, which is what PostgREST emits (`INSERT INTO t SELECT FROM …`): a
    // `VALUES (DEFAULT)` list would leave the counter nowhere to sit, and `ON CONFLICT` nothing to
    // hang on. With no column to set, both resolutions are `DO NOTHING` -- as in PostgREST, where
    // `MergeDuplicates` with no columns is `DO NOTHING` too.
    const keys = conflictTarget(o.onConflict, rel);
    const nothing = o.resolution
      ? ` ON CONFLICT${keys.length ? ` (${keys.map(quoteIdent).join(", ")})` : ""} DO NOTHING`
      : "";
    const defaults = `SELECT FROM json_array_elements(($1::text)::json)`;
    return `INSERT INTO ${target} ${counted(defaults, true)}${nothing} RETURNING ${returning}`;
  }

  const colList = cols.map(quoteIdent).join(", ");
  const typed = `null::${table}`;
  const json = "($1::text)::json";

  let select: string;
  if (o.missingDefault) {
    const byName = new Map(rel.columns.map((c) => [c.name, c]));
    const exprs = cols.map((c) => {
      const allPresent = o.rows.every((r) => c in r);
      const value = `_p.${quoteIdent(c)}`;
      if (allPresent) return value;
      const dflt = byName.get(c)?.defaultExpr ?? "NULL";
      return `CASE WHEN (_e.value::jsonb) ? ${"'" + c.replace(/'/g, "''") + "'"} THEN ${value} ELSE ${dflt} END`;
    });
    select = `SELECT ${exprs.join(", ")} FROM json_array_elements(${json}) AS _e(value) CROSS JOIN LATERAL json_populate_record(${typed}, _e.value) AS _p`;
  } else {
    select = `SELECT ${colList} FROM json_populate_recordset(${typed}, ${json})`;
  }

  let conflict = "";
  if (o.resolution) {
    const keys = conflictTarget(o.onConflict, rel);
    const targetCols = keys.length ? ` (${keys.map(quoteIdent).join(", ")})` : "";
    if (o.resolution === "ignore-duplicates") {
      conflict = ` ON CONFLICT${targetCols} DO NOTHING`;
    } else {
      if (keys.length === 0) {
        throw new EngineError(
          "invalid_input",
          "Upsert needs a conflict target",
          `"${rel.name}" has no primary key; pass on_conflict=<columns>`,
        );
      }
      // The counter goes down here, once per row that turned out to exist: what the two `WHERE`
      // clauses leave in `pgrst.inserted` is the number of rows actually inserted.
      conflict =
        ` ON CONFLICT${targetCols} DO UPDATE SET ` +
        counted(cols.map((c) => `${quoteIdent(c)} = EXCLUDED.${quoteIdent(c)}`).join(", "), false);
    }
  } else if (o.onConflict && o.onConflict.length > 0) {
    // on_conflict without a resolution preference has no effect (as in PostgREST).
  }

  return `INSERT INTO ${target} (${colList}) ${counted(select, true)}${conflict} RETURNING ${returning}`;
};

export interface UpdateOptions {
  readonly rel: Relation;
  readonly body: JsonObject;
  /** `columns=`: the columns written, whatever the payload holds; a column it lacks is set to null (or its default). */
  readonly columns?: ReadonlyArray<string> | undefined;
  /** `missing=default`: a column of `columns` the payload lacks is set to its default rather than null. */
  readonly missingDefault?: boolean | undefined;
  /** `col = expr` clauses compiled by `query()` (`sql/expression.ts`); HTTP never sets them. */
  readonly clauses?: ReadonlyArray<string> | undefined;
  readonly filters: ReadonlyArray<FilterNode>;
  readonly returning: Returning;
  readonly values?: Values | undefined;
}

/** `UPDATE … SET … RETURNING …`, or `null` when the payload sets no columns. */
export const buildUpdate = (o: UpdateOptions): string | null => {
  const { rel } = o;
  const cols = o.columns ? [...o.columns] : Object.keys(o.body);
  checkColumns(rel, cols);
  const clauses = o.clauses ?? [];
  if (cols.length === 0 && clauses.length === 0) return null;
  const table = quoteQualified(rel.schema, rel.name);
  const valueOf = (c: string) => (o.columns && o.missingDefault && !(c in o.body) ? "DEFAULT" : `_u.${quoteIdent(c)}`);
  const set = [...cols.map((c) => `${quoteIdent(c)} = ${valueOf(c)}`), ...clauses].join(", ");
  const where = whereSql(o.filters, ROOT_ALIAS, rel, o.values ?? inlined);
  // the JSON body is `$1`, and only a statement that reads it may mention it
  const from = cols.length ? ` FROM (SELECT * FROM json_populate_record(null::${table}, ($1::text)::json)) AS _u` : "";
  return (
    `UPDATE ${table} AS ${quoteIdent(ROOT_ALIAS)} SET ${set}${from}` +
    `${where.length ? ` WHERE ${where.join(" AND ")}` : ""} RETURNING ${returningSql(rel, o.returning)}`
  );
};

export interface DeleteOptions {
  readonly rel: Relation;
  readonly filters: ReadonlyArray<FilterNode>;
  readonly returning: Returning;
  readonly values?: Values | undefined;
}

export const buildDelete = (o: DeleteOptions): string => {
  const where = whereSql(o.filters, ROOT_ALIAS, o.rel, o.values ?? inlined);
  return (
    `DELETE FROM ${quoteQualified(o.rel.schema, o.rel.name)} AS ${quoteIdent(ROOT_ALIAS)}` +
    `${where.length ? ` WHERE ${where.join(" AND ")}` : ""} RETURNING ${returningSql(o.rel, o.returning)}`
  );
};
