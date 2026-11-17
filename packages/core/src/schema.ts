import { EngineError } from "./errors";
import { relKey } from "@tspg/introspect";
import type { ForeignKey, FunctionDef, Relation, SchemaCache } from "@tspg/introspect";

// The catalog model and its reader live in `@tspg/introspect`, which is published on its own: what
// is left here is what only the request path needs, resolving relationships between relations.
export { compositeOf, fromDescriptor, readCatalog as introspect, relKey, toDescriptor } from "@tspg/introspect";
export type {
  Column,
  CompositeAttribute,
  CompositeRef,
  CompositeType,
  ForeignKey,
  FunctionArg,
  FunctionDef,
  MediaHandler,
  Relation,
  RelationKind,
  SchemaCache,
  SchemaDescriptor,
} from "@tspg/introspect";

// ---------------------------------------------------------------------------
// Relationships (for resource embedding)
// ---------------------------------------------------------------------------

export type RelationshipKind = "m2o" | "o2m" | "o2o" | "m2m";

export interface Relationship {
  readonly kind: RelationshipKind;
  readonly from: Relation;
  readonly to: Relation;
  /** Join columns on `from` and `to` (direct relationships only). */
  readonly fromCols: ReadonlyArray<string>;
  readonly toCols: ReadonlyArray<string>;
  readonly fk: ForeignKey;
  /** Computed relationship: a function taking a row of `from` and returning rows of `to`. */
  readonly computed?: FunctionDef;
  /** Many-to-many only: the junction table and its two FKs. */
  readonly junction?: {
    readonly relation: Relation;
    /** junction → from */
    readonly fkFrom: ForeignKey;
    /** junction → to */
    readonly fkTo: ForeignKey;
  };
}

const sameCols = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.length === b.length && a.every((c) => b.includes(c));

const isUnique = (rel: Relation, cols: ReadonlyArray<string>) =>
  (rel.pk.length > 0 && sameCols(rel.pk, cols)) || rel.uniques.some((u) => sameCols(u, cols));

const describe = (r: Relationship): string => {
  const j = r.junction;
  if (j) {
    return `'${j.relation.name}' using '${j.fkFrom.name}' and '${j.fkTo.name}' (many-to-many)`;
  }
  if (r.computed) return `'${r.computed.name}' (computed, ${r.kind === "m2o" ? "many-to-one" : "one-to-many"})`;
  return `'${r.fk.name}' (${r.kind === "m2o" ? "many-to-one" : r.kind === "o2o" ? "one-to-one" : "one-to-many"}) on ${r.fk.table}(${r.fk.cols.join(",")})`;
};

/** Find the relationships between `from` and the table/view named `target`. */
export const findRelationships = (
  cache: SchemaCache,
  from: Relation,
  target: string,
  hint?: string,
): Relationship[] => {
  const out: Relationship[] = [];
  const rel = (schema: string, name: string) => cache.relations.get(relKey(schema, name));

  for (const fk of cache.foreignKeys) {
    const selfReference = fk.schema === fk.fschema && fk.table === fk.ftable;
    // many-to-one: from → target (a self-reference is only reachable through its column name)
    if (fk.schema === from.schema && fk.table === from.name && fk.ftable === target && !selfReference) {
      const to = rel(fk.fschema, fk.ftable);
      if (to) out.push({ kind: "m2o", from, to, fromCols: fk.cols, toCols: fk.fcols, fk });
    }
    // many-to-one addressed by the foreign key column, e.g. `parent:parent_id(*)`
    if (fk.schema === from.schema && fk.table === from.name && fk.cols.length === 1 && fk.cols[0] === target) {
      const to = rel(fk.fschema, fk.ftable);
      if (to) out.push({ kind: "m2o", from, to, fromCols: fk.cols, toCols: fk.fcols, fk });
    }
    // one-to-many / one-to-one: target → from
    if (fk.fschema === from.schema && fk.ftable === from.name && fk.table === target) {
      const to = rel(fk.schema, fk.table);
      if (to) {
        out.push({
          kind: isUnique(to, fk.cols) ? "o2o" : "o2m",
          from,
          to,
          fromCols: fk.fcols,
          toCols: fk.cols,
          fk,
        });
      }
    }
  }

  // computed relationships: `fn(from_row) RETURNS [SETOF] to_table`
  for (const f of cache.functions.get(relKey(from.schema, target)) ?? []) {
    if (f.argRelation?.schema !== from.schema || f.argRelation.name !== from.name || !f.returnRelation) continue;
    const to = rel(f.returnRelation.schema, f.returnRelation.name);
    if (!to) continue;
    const fk: ForeignKey = {
      name: f.name,
      schema: from.schema,
      table: from.name,
      cols: [],
      fschema: to.schema,
      ftable: to.name,
      fcols: [],
    };
    out.push({
      kind: !f.returnsSet || f.rows === 1 ? "m2o" : "o2m",
      from,
      to,
      fromCols: [],
      toCols: [],
      fk,
      computed: f,
    });
  }

  // many-to-many through a junction table
  for (const fk1 of cache.foreignKeys) {
    if (fk1.fschema !== from.schema || fk1.ftable !== from.name) continue;
    const junction = rel(fk1.schema, fk1.table);
    if (!junction) continue;
    for (const fk2 of cache.foreignKeys) {
      if (fk2 === fk1) continue;
      if (fk2.schema !== fk1.schema || fk2.table !== fk1.table) continue;
      if (fk2.ftable !== target) continue;
      const to = rel(fk2.fschema, fk2.ftable);
      if (!to) continue;
      out.push({
        kind: "m2m",
        from,
        to,
        fromCols: fk1.fcols,
        toCols: fk2.fcols,
        fk: fk1,
        junction: { relation: junction, fkFrom: fk1, fkTo: fk2 },
      });
    }
  }

  if (!hint) return out;
  return out.filter((r) => {
    if (r.junction) {
      return r.junction.relation.name === hint || r.junction.fkFrom.name === hint || r.junction.fkTo.name === hint;
    }
    return r.fk.name === hint || r.fk.cols.includes(hint) || r.fk.fcols.includes(hint);
  });
};

/**
 * Resolve exactly one relationship or throw `no_relationship` / `ambiguous_relationship`.
 * `target` may also be a table that is not related at all (→ `no_relationship`).
 */
export const resolveRelationship = (
  cache: SchemaCache,
  from: Relation,
  target: string,
  hint?: string,
): Relationship => {
  const found = findRelationships(cache, from, target, hint);
  if (found.length === 1) return found[0]!;
  if (found.length === 0) {
    throw new EngineError(
      "no_relationship",
      `Could not find a relationship between '${from.name}' and '${target}' in the schema cache`,
      hint
        ? `Searched for a foreign key relationship between '${from.name}' and '${target}' using the hint '${hint}' in the schema '${from.schema}', but no matches were found.`
        : `Searched for a foreign key relationship between '${from.name}' and '${target}' in the schema '${from.schema}', but no matches were found.`,
      null,
    );
  }
  throw new EngineError(
    "ambiguous_relationship",
    `Could not embed because more than one relationship was found for '${from.name}' and '${target}'`,
    JSON.stringify(found.map((r) => describe(r))),
    `Try changing '${target}' to one of the following: ${found
      .map((r) => `'${target}!${r.junction ? r.junction.relation.name : r.fk.name}'`)
      .join(", ")}. Find the desired relationship in the 'details' key.`,
  );
};

/** Look up a relation by (optional) schema and name, or throw `table_not_found`. */
export const getRelation = (cache: SchemaCache, schema: string, name: string): Relation => {
  const rel = cache.relations.get(relKey(schema, name));
  if (!rel) {
    throw new EngineError(
      "table_not_found",
      `Could not find the table '${schema}.${name}' in the schema cache`,
      null,
      suggest(cache, schema, name),
    );
  }
  return rel;
};

const suggest = (cache: SchemaCache, schema: string, name: string): string | null => {
  let best: { name: string; d: number } | undefined;
  for (const r of cache.relations.values()) {
    if (r.schema !== schema) continue;
    const d = levenshtein(name.toLowerCase(), r.name.toLowerCase());
    if (d <= Math.max(1, Math.floor(name.length / 4)) && (!best || d < best.d)) {
      best = { name: r.name, d };
    }
  }
  return best ? `Perhaps you meant the table '${schema}.${best.name}'` : null;
};

export const levenshtein = (a: string, b: string): number => {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length]!;
};
