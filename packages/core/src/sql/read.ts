import { EngineError } from "../errors";
import type { FilterNode, NodeParams, ParsedQuery } from "../parse/filter";
import { outputName, type AggregateItem, type EmbedItem, type FieldItem, type SelectItem } from "../parse/select";
import { quoteIdent, quoteQualified } from "../quote";
import { type Relation, type SchemaCache, resolveRelationship } from "../schema";
import type { OrderTerm } from "../parse/filter";
import { fieldSql, nodeSql } from "./filters";
import { type Values, inlined } from "./values";
import { ALIAS, ROOT_ALIAS } from "../constants";

export interface ReadOptions {
  readonly cache: SchemaCache;
  readonly rel: Relation;
  /** The row source, without alias: `"api"."clients"`, a CTE name or `(subquery)`. */
  readonly from: string;
  readonly query: ParsedQuery;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
  /** How a filter's value gets into the SQL; literals when not given. */
  readonly values?: Values | undefined;
}

export interface ReadSql {
  /** The row-producing SELECT (with ORDER/LIMIT/OFFSET). */
  readonly rows: string;
  /** `SELECT count(*) …` over the same rows without paging. */
  readonly count: string;
  /** The row-producing SELECT without ORDER/LIMIT/OFFSET. */
  readonly unpaged: string;
  /** What the planner is asked to estimate for `count=planned`: PostgREST's count query when it can be built. */
  readonly planned: string;
}

interface Join {
  readonly sql: string;
  readonly alias: string;
  /** Name (alias or target) used to match `?embed=is.null` filters. */
  readonly name: string;
  readonly inner: boolean;
  /** Null exactly when the embed found no row: what `embed=is.null` tests. */
  readonly presence: string;
}

/** An aggregate a to-one spread leaves to its parent: applied there, over the column the spread selects. */
interface Hoisted {
  readonly fn: AggregateItem["fn"];
  readonly cast?: string | undefined;
}

interface Built {
  readonly cols: string[];
  readonly joins: Join[];
  readonly groupBy: string[];
  readonly aggregated: boolean;
  /** Built for a to-one spread: its aggregates, by output name, for the parent to apply. */
  readonly hoisted: ReadonlyMap<string, Hoisted>;
}

const applyHoisted = (ref: string, h: Hoisted): string => {
  const expr = `${h.fn}(${ref})`;
  return h.cast ? `(${expr})::${h.cast}` : expr;
};

class Aliases {
  private n = 0;
  next(prefix: string): string {
    return `${prefix}${++this.n}`;
  }
}

interface Ctx {
  readonly cache: SchemaCache;
  readonly query: ParsedQuery;
  readonly aliases: Aliases;
  readonly values: Values;
}

/** A column rendered through its data representation, when it has one (PostgREST's `withOutputFormat`). */
const rendered = (alias: string, rel: Relation, name: string): string | undefined => {
  const fn = rel.columns.find((c) => c.name === name)?.representation?.toJson;
  return fn ? `${fn}(${quoteIdent(alias)}.${quoteIdent(name)})` : undefined;
};

/** `*`, as columns when one of them is rendered through a data representation. */
const starSql = (alias: string, rel: Relation): string =>
  rel.columns.some((c) => c.representation?.toJson)
    ? rel.columns
        .map((c) => {
          const r = rendered(alias, rel, c.name);
          return r ? `${r} AS ${quoteIdent(c.name)}` : `${quoteIdent(alias)}.${quoteIdent(c.name)}`;
        })
        .join(", ")
    : `${quoteIdent(alias)}.*`;

const fieldExpr = (item: FieldItem, alias: string, rel: Relation): string => {
  const output = item.field.json.length === 0 ? rendered(alias, rel, item.field.name) : undefined;
  if (output) {
    const expr = item.cast ? `(${output})::${item.cast}` : output;
    return `${expr} AS ${quoteIdent(outputName(item))}`;
  }
  const base = fieldSql(alias, item.field, rel);
  // `::` binds tighter than `->>`: a path is cast as a whole, not its last key
  const expr = item.cast ? (item.field.json.length ? `(${base})::${item.cast}` : `${base}::${item.cast}`) : base;
  const plain = !item.cast && item.field.json.length === 0 && !item.alias;
  return plain ? expr : `${expr} AS ${quoteIdent(outputName(item))}`;
};

/** What an aggregate aggregates; `star` is what `count()` counts (a whole row, when it is hoisted). */
const aggregateArg = (item: AggregateItem, alias: string, rel: Relation, star: string): string => {
  const column = item.field ? fieldSql(alias, item.field, rel) : star;
  return item.fieldCast ? `(${column})::${item.fieldCast}` : column;
};

const aggregateExpr = (item: AggregateItem, alias: string, rel: Relation): string => {
  const arg = aggregateArg(item, alias, rel, "*");
  let expr = `${item.fn}(${arg})`;
  if (item.cast) expr = `(${expr})::${item.cast}`;
  return `${expr} AS ${quoteIdent(outputName(item))}`;
};

/** Output column names produced by a list of select items (used for spreads). */
const itemNames = (ctx: Ctx, items: ReadonlyArray<SelectItem>, rel: Relation): string[] => {
  const out: string[] = [];
  for (const it of items) {
    if (it.kind === "star") out.push(...rel.columns.map((c) => c.name));
    else if (it.kind === "field" || it.kind === "aggregate") out.push(outputName(it));
    else if (it.items.length === 0) continue;
    else if (it.spread)
      out.push(...itemNames(ctx, it.items, resolveRelationship(ctx.cache, rel, it.target, it.hint).to));
    else out.push(it.alias ?? it.target);
  }
  return out;
};

const orderClause = (
  ctx: Ctx,
  terms: ReadonlyArray<OrderTerm>,
  rel: Relation,
  alias: string,
  items: ReadonlyArray<SelectItem>,
  joins: ReadonlyArray<Join> = [],
): string => {
  if (terms.length === 0) return "";
  const q = quoteIdent;
  const parts = terms.map((t) => {
    const tail = `${t.dir.toUpperCase()}${t.nulls ? ` NULLS ${t.nulls.toUpperCase()}` : ""}`;
    if (!t.relation) return `${fieldSql(alias, t.field, rel)} ${tail}`;
    const embed = items.find((i): i is EmbedItem => i.kind === "embed" && (i.alias ?? i.target) === t.relation);
    if (!embed) {
      throw new EngineError(
        "not_embedded",
        `'${t.relation}' is not an embedded resource in this request`,
        null,
        `Verify that '${t.relation}' is included in the 'select' query parameter.`,
      );
    }
    const r = resolveRelationship(ctx.cache, rel, embed.target, embed.hint);
    if (r.kind !== "m2o" && r.kind !== "o2o") {
      throw new EngineError(
        "invalid_related_order",
        `A related order on '${t.relation}' is not possible`,
        `'${rel.name}' and '${t.relation}' do not form a many-to-one or one-to-one relationship`,
        null,
      );
    }
    // a to-one spread is a join: PostgREST orders by the column it selects, under the name it gives it
    const spread = embed.spread ? joins.find((j) => j.name === t.relation) : undefined;
    if (spread) return `${fieldSql(spread.alias, t.field)} ${tail}`;
    // PostgREST orders by the embedded query's output, so the column has to be selected there
    const selected = embed.items.filter((i) => i.kind !== "embed");
    if (
      selected.length > 0 &&
      !selected.some((i) => i.kind === "star" || (i.kind === "field" && i.field.name === t.field.name))
    ) {
      throw new EngineError(
        "undefined_column",
        `column ${rel.name}_${embed.target}_1.${t.field.name} does not exist`,
        null,
        null,
      );
    }
    const o = ctx.aliases.next(`${ALIAS}_o`);
    if (r.computed) {
      return `(SELECT ${fieldSql(o, t.field, r.to)} FROM ${quoteQualified(r.computed.schema, r.computed.name)}(${q(alias)}) AS ${q(o)} LIMIT 1) ${tail}`;
    }
    const cond = r.toCols.map((c, i) => `${q(o)}.${q(c)} = ${q(alias)}.${q(r.fromCols[i]!)}`).join(" AND ");
    return `(SELECT ${fieldSql(o, t.field, r.to)} FROM ${quoteQualified(r.to.schema, r.to.name)} AS ${q(o)} WHERE ${cond} LIMIT 1) ${tail}`;
  });
  return `ORDER BY ${parts.join(", ")}`;
};

/** Whether these items have an aggregate a parent would apply: their own, or one of a to-one spread among them. */
const hoistable = (ctx: Ctx, items: ReadonlyArray<SelectItem>, rel: Relation): boolean =>
  items.some((i) => {
    if (i.kind === "aggregate") return true;
    if (i.kind !== "embed" || !i.spread) return false;
    const r = resolveRelationship(ctx.cache, rel, i.target, i.hint);
    return (r.kind === "m2o" || r.kind === "o2o") && hoistable(ctx, i.items, r.to);
  });

/**
 * The select list of one level. `hoist` is set for a to-one spread: PostgREST applies its aggregates
 * in the nearest level that is not one (`hoistSpreadAggFunctions`), so they are not applied here --
 * the column is selected, and `hoisted` says what to do with it.
 */
const buildItems = (
  ctx: Ctx,
  items: ReadonlyArray<SelectItem>,
  rel: Relation,
  alias: string,
  path: string[],
  hoist = false,
): Built => {
  const cols: string[] = [];
  const joins: Join[] = [];
  const groupBy: string[] = [];
  const hoisted = new Map<string, Hoisted>();
  const aggregated = !hoist && hoistable(ctx, items, rel);

  for (const item of items) {
    switch (item.kind) {
      case "star":
        if (aggregated) {
          for (const c of rel.columns) {
            const e = `${quoteIdent(alias)}.${quoteIdent(c.name)}`;
            cols.push(e);
            groupBy.push(e);
          }
        } else cols.push(starSql(alias, rel));
        break;
      case "field":
        cols.push(fieldExpr(item, alias, rel));
        if (aggregated) groupBy.push(fieldSql(alias, item.field, rel));
        break;
      case "aggregate":
        if (hoist) {
          // `count()` counts the rows the spread joined: their whole-row value is null where there were none
          const name = outputName(item);
          cols.push(`${aggregateArg(item, alias, rel, quoteIdent(alias))} AS ${quoteIdent(name)}`);
          hoisted.set(name, { fn: item.fn, cast: item.cast });
        } else cols.push(aggregateExpr(item, alias, rel));
        break;
      case "embed": {
        const e = buildEmbed(ctx, item, rel, alias, path, hoist);
        cols.push(...e.cols);
        joins.push(e.join);
        if (aggregated) groupBy.push(...e.group);
        for (const [n, h] of e.hoisted) hoisted.set(n, h);
        break;
      }
    }
  }
  return { cols, joins, groupBy, aggregated, hoisted };
};

const notEmbedded = (name: string) =>
  new EngineError(
    "not_embedded",
    `'${name}' is not an embedded resource in this request`,
    null,
    `Verify that '${name}' is included in the 'select' query parameter.`,
  );

const presenceConditions = (params: NodeParams | undefined, joins: ReadonlyArray<Join>): string[] =>
  (params?.presence ?? []).map((p) => {
    const j = joins.find((x) => x.name === p.embed);
    if (!j) throw notEmbedded(p.embed);
    return `${j.presence} IS ${p.present ? "NOT " : ""}NULL`;
  });

/**
 * The filters of one level. A filter `<embed>.is.null` -- in a logic tree too -- tests whether the
 * embed found a row, as PostgREST's `addNullEmbedFilters` has it; any other is on a column.
 */
const levelWhere = (
  nodes: ReadonlyArray<FilterNode>,
  alias: string,
  rel: Relation,
  joins: ReadonlyArray<Join>,
  values: Values,
): string[] => {
  const render = (node: FilterNode): string => {
    if (node.kind === "filter") {
      const j =
        node.op === "is" && node.value === "null" && node.field.json.length === 0
          ? joins.find((x) => x.name === node.field.name)
          : undefined;
      if (j) return `${j.presence} IS ${node.negate ? "DISTINCT" : "NOT DISTINCT"} FROM NULL`;
      return nodeSql(node, alias, rel, values);
    }
    const inner = `(${node.children.map(render).join(node.op === "and" ? " AND " : " OR ")})`;
    return node.negate ? `NOT ${inner}` : inner;
  };
  return nodes.map(render);
};

const paging = (limit: number | undefined, offset: number | undefined): string => {
  let s = "";
  if (limit !== undefined) s += ` LIMIT ${Math.trunc(limit)}`;
  if (offset !== undefined && offset > 0) s += ` OFFSET ${Math.trunc(offset)}`;
  return s;
};

const buildEmbed = (
  ctx: Ctx,
  item: EmbedItem,
  parentRel: Relation,
  parentAlias: string,
  path: string[],
  hoist = false,
): { cols: string[]; join: Join; group: string[]; hoisted: ReadonlyMap<string, Hoisted> } => {
  const relationship = resolveRelationship(ctx.cache, parentRel, item.target, item.hint);
  const name = item.alias ?? item.target;
  const childPath = [...path, name];
  const params = ctx.query.embeds.get(childPath.join("."));
  const toOne = relationship.kind === "m2o" || relationship.kind === "o2o";
  const child = relationship.to;
  const cAlias = ctx.aliases.next(`${child.name}_`);
  const eAlias = ctx.aliases.next(`${ALIAS}_j`);
  // a to-one spread is a join into its parent, which applies its aggregates
  const spreadToOne = item.spread && toOne;
  const inner = buildItems(ctx, item.items, child, cAlias, childPath, spreadToOne);
  const hasCols = inner.cols.length > 0;
  const none: ReadonlyMap<string, Hoisted> = new Map();

  const q = quoteIdent;
  const conds: string[] = [];
  let from: string;
  if (relationship.computed) {
    const fn = relationship.computed;
    from = `${quoteQualified(fn.schema, fn.name)}(${q(parentAlias)}) AS ${q(cAlias)}`;
    conds.push("TRUE");
  } else if (relationship.junction) {
    const j = relationship.junction;
    const jAlias = ctx.aliases.next(`${ALIAS}_m`);
    const onTo = j.fkTo.cols.map((c, i) => `${q(jAlias)}.${q(c)} = ${q(cAlias)}.${q(j.fkTo.fcols[i]!)}`);
    from = `${quoteQualified(child.schema, child.name)} AS ${q(cAlias)} JOIN ${quoteQualified(j.relation.schema, j.relation.name)} AS ${q(jAlias)} ON ${onTo.join(" AND ")}`;
    conds.push(...j.fkFrom.cols.map((c, i) => `${q(jAlias)}.${q(c)} = ${q(parentAlias)}.${q(j.fkFrom.fcols[i]!)}`));
  } else {
    from = `${quoteQualified(child.schema, child.name)} AS ${q(cAlias)}`;
    conds.push(
      ...relationship.toCols.map((c, i) => `${q(cAlias)}.${q(c)} = ${q(parentAlias)}.${q(relationship.fromCols[i]!)}`),
    );
  }
  if (inner.joins.length) from += ` ${inner.joins.map((j) => j.sql).join(" ")}`;

  conds.push(...(params ? levelWhere(params.filters, cAlias, child, inner.joins, ctx.values) : []));
  conds.push(...presenceConditions(params, inner.joins));

  const order = params ? orderClause(ctx, params.order, child, cAlias, item.items, inner.joins) : "";
  const page = paging(params?.limit, params?.offset);
  const sel = hasCols ? inner.cols.join(", ") : "1";
  const groupSql = inner.aggregated && inner.groupBy.length ? ` GROUP BY ${inner.groupBy.join(", ")}` : "";
  const body = `SELECT ${sel} FROM ${from} WHERE ${conds.join(" AND ")}${groupSql}${order ? ` ${order}` : ""}${page}`;
  // PostgREST embeds with jsonb (key order and spacing are visible in CSV output)
  const J = "jsonb";

  const joinKw = item.join === "inner" ? "JOIN LATERAL" : "LEFT JOIN LATERAL";

  if (item.spread) {
    const names = itemNames(ctx, item.items, child);
    if (toOne) {
      const present = q(`${ALIAS}_present`);
      const lateral = `${joinKw} (SELECT _r.*, TRUE AS ${present} FROM (${body}) AS _r LIMIT 1) AS ${q(eAlias)} ON TRUE`;
      const refs = names.map((n) => `${q(eAlias)}.${q(n)}`);
      return {
        // the aggregates are applied here, or -- under another to-one spread -- handed up
        cols: names.map((n, i) => {
          const h = inner.hoisted.get(n);
          return `${h && !hoist ? applyHoisted(refs[i]!, h) : refs[i]} AS ${q(n)}`;
        }),
        join: { sql: lateral, alias: eAlias, name, inner: item.join === "inner", presence: `${q(eAlias)}.${present}` },
        group: refs.filter((_, i) => !inner.hoisted.has(names[i]!)),
        hoisted: hoist ? inner.hoisted : none,
      };
    }
    if (inner.aggregated) {
      throw new EngineError(
        "not_implemented",
        "Feature not implemented",
        "Aggregates are not implemented for one-to-many or many-to-many spreads.",
        null,
      );
    }
    // to-many spread: every column becomes an array with one entry per related row, and the count of
    // those rows says whether there were any (it also keeps one row per parent row with no column)
    const counted = q(`${ALIAS}_n`);
    const agg = [
      ...names.map((n) => `coalesce(${J}_agg(_r.${q(n)}), '[]'::${J}) AS ${q(n)}`),
      `count(*) AS ${counted}`,
    ].join(", ");
    const having = item.join === "inner" ? " HAVING count(*) > 0" : "";
    const lateral = `${joinKw} (SELECT ${agg} FROM (${body}) AS _r${having}) AS ${q(eAlias)} ON TRUE`;
    const refs = names.map((n) => `${q(eAlias)}.${q(n)}`);
    return {
      cols: names.map((n, i) => `${refs[i]} AS ${q(n)}`),
      join: {
        sql: lateral,
        alias: eAlias,
        name,
        inner: item.join === "inner",
        presence: `nullif(${q(eAlias)}.${counted}, 0)`,
      },
      group: refs,
      hoisted: none,
    };
  }

  if (toOne) {
    const lateral = `${joinKw} (SELECT to_${J}(_r) AS j FROM (${body}) AS _r LIMIT 1) AS ${q(eAlias)} ON TRUE`;
    return {
      cols: hasCols ? [`${q(eAlias)}.j AS ${q(name)}`] : [],
      join: { sql: lateral, alias: eAlias, name, inner: item.join === "inner", presence: `${q(eAlias)}.j` },
      group: hasCols ? [`${q(eAlias)}.j`] : [],
      hoisted: none,
    };
  }

  const having = item.join === "inner" ? " HAVING count(*) > 0" : "";
  const lateral = `${joinKw} (SELECT ${J}_agg(_r) AS j FROM (${body}) AS _r${having}) AS ${q(eAlias)} ON TRUE`;
  return {
    cols: hasCols ? [`coalesce(${q(eAlias)}.j, '[]'::${J}) AS ${q(name)}`] : [],
    join: { sql: lateral, alias: eAlias, name, inner: item.join === "inner", presence: `${q(eAlias)}.j` },
    group: hasCols ? [`${q(eAlias)}.j`] : [],
    hoisted: none,
  };
};

/**
 * PostgREST's count query (`readPlanToCountQuery`), whose plan `count=planned` reads: the rows of the
 * level and nothing else, an embed's `is.null` and an `!inner` embed as `[NOT] EXISTS` over the
 * embedded rows. `undefined` where this does not build it the same way (aggregates, computed
 * relationships), and then the read itself is estimated.
 */
const countQuery = (
  ctx: Ctx,
  items: ReadonlyArray<SelectItem>,
  rel: Relation,
  alias: string,
  from: string,
  params: NodeParams | undefined,
  path: string[],
  joinConds: ReadonlyArray<string>,
): string | undefined => {
  if (items.some((i) => i.kind === "aggregate")) return undefined;
  const q = quoteIdent;
  const embeds = new Map<string, { inner: boolean; sub: () => string | undefined }>();
  for (const item of items) {
    if (item.kind !== "embed") continue;
    const name = item.alias ?? item.target;
    const r = resolveRelationship(ctx.cache, rel, item.target, item.hint);
    const child = r.to;
    const cAlias = ctx.aliases.next(`${child.name}_`);
    embeds.set(name, {
      inner: item.join === "inner",
      sub: () => {
        if (r.computed) return undefined;
        let childFrom = `${quoteQualified(child.schema, child.name)} AS ${q(cAlias)}`;
        let conds: string[];
        if (r.junction) {
          const j = r.junction;
          const jAlias = ctx.aliases.next(`${ALIAS}_m`);
          childFrom += ` JOIN ${quoteQualified(j.relation.schema, j.relation.name)} AS ${q(jAlias)} ON ${j.fkTo.cols
            .map((c, i) => `${q(jAlias)}.${q(c)} = ${q(cAlias)}.${q(j.fkTo.fcols[i]!)}`)
            .join(" AND ")}`;
          conds = j.fkFrom.cols.map((c, i) => `${q(jAlias)}.${q(c)} = ${q(alias)}.${q(j.fkFrom.fcols[i]!)}`);
        } else {
          conds = r.toCols.map((c, i) => `${q(cAlias)}.${q(c)} = ${q(alias)}.${q(r.fromCols[i]!)}`);
        }
        const childPath = [...path, name];
        return countQuery(
          ctx,
          item.items,
          child,
          cAlias,
          childFrom,
          ctx.query.embeds.get(childPath.join(".")),
          childPath,
          conds,
        );
      },
    });
  }
  let failed = false;
  const exists = (name: string, present: boolean): string => {
    const sub = embeds.get(name)?.sub();
    if (sub === undefined) {
      failed = true;
      return "";
    }
    return `${present ? "" : "NOT "}EXISTS (${sub})`;
  };
  const render = (node: FilterNode): string => {
    if (node.kind === "filter") {
      if (node.op === "is" && node.value === "null" && node.field.json.length === 0 && embeds.has(node.field.name))
        return exists(node.field.name, node.negate === true);
      return nodeSql(node, alias, rel, ctx.values);
    }
    const inner = `(${node.children.map(render).join(node.op === "and" ? " AND " : " OR ")})`;
    return node.negate ? `NOT ${inner}` : inner;
  };
  const conds = [
    ...(params?.filters ?? []).map(render),
    ...(params?.presence ?? []).map((p) => exists(p.embed, p.present)),
    ...[...embeds].filter(([, e]) => e.inner).map(([name]) => exists(name, true)),
    ...joinConds,
  ];
  if (failed) return undefined;
  return `SELECT 1 FROM ${from}${conds.length ? ` WHERE ${conds.join(" AND ")}` : ""}`;
};

/** Build the SELECT (and matching COUNT) for a read. */
export const buildRead = (opts: ReadOptions): ReadSql => {
  const ctx: Ctx = { cache: opts.cache, query: opts.query, aliases: new Aliases(), values: opts.values ?? inlined };
  const built = buildItems(ctx, opts.query.select, opts.rel, ROOT_ALIAS, []);

  const where = [
    ...levelWhere(opts.query.root.filters, ROOT_ALIAS, opts.rel, built.joins, ctx.values),
    ...presenceConditions(opts.query.root, built.joins),
  ];
  const whereClause = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  const fromClause = `${opts.from} AS ${quoteIdent(ROOT_ALIAS)}`;
  const joinSql = built.joins.map((j) => j.sql).join(" ");
  const groupClause = built.aggregated && built.groupBy.length ? ` GROUP BY ${built.groupBy.join(", ")}` : "";
  const order = orderClause(ctx, opts.query.root.order, opts.rel, ROOT_ALIAS, opts.query.select, built.joins);

  const cols = built.cols.length ? built.cols.join(", ") : "1";
  const unpaged = `SELECT ${cols} FROM ${fromClause}${joinSql ? ` ${joinSql}` : ""}${whereClause}${groupClause}`;
  const rows = `${unpaged}${order ? ` ${order}` : ""}${paging(opts.limit, opts.offset)}`;

  let count: string;
  if (built.aggregated) {
    count = `SELECT count(*) FROM (${unpaged}) AS _c`;
  } else if (built.joins.some((j) => j.inner) || (opts.query.root.presence.length ?? 0) > 0) {
    count = `SELECT count(*) FROM ${fromClause} ${joinSql}${whereClause}`;
  } else {
    count = `SELECT count(*) FROM ${fromClause}${whereClause}`;
  }
  // the count query is PostgREST's only where its values are literals, as in its own logs: bound ones
  // would be numbered twice
  const planned =
    ctx.values === inlined && !built.aggregated
      ? (countQuery(
          { ...ctx, aliases: new Aliases() },
          opts.query.select,
          opts.rel,
          ROOT_ALIAS,
          fromClause,
          opts.query.root,
          [],
          [],
        ) ?? unpaged)
      : unpaged;
  return { rows, count, unpaged, planned };
};
