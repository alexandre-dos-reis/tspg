import { EngineError } from "./errors";
import { fuzzyGetOne, levenshtein } from "./fuzzy";
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

/** Whether `cols` are a key of `rel`: its primary key (PostgREST's, for a view) or a unique constraint. */
const isUnique = (rel: Relation, cols: ReadonlyArray<string>) => {
  const key = pgrstKey(rel);
  return (key.length > 0 && sameCols(key, cols)) || rel.uniques.some((u) => sameCols(u, cols));
};

const isView = (rel: Relation) => rel.kind === "view" || rel.kind === "matview";
const sameRel = (a: Relation, b: Relation) => a.schema === b.schema && a.name === b.name;

const CARDINALITY: Record<RelationshipKind, string> = {
  o2m: "one-to-many",
  m2o: "many-to-one",
  o2o: "one-to-one",
  m2m: "many-to-many",
};

/** A relationship as PostgREST details it when an embed is ambiguous (`compressedRel`). */
const describe = (r: Relationship): Record<string, string> => {
  const cols = (c: ReadonlyArray<string>) => `(${c.join(", ")})`;
  const embedding = `${r.from.name} with ${r.to.name}`;
  const j = r.junction;
  if (j) {
    return {
      cardinality: CARDINALITY.m2m,
      embedding,
      relationship: `${j.relation.name} using ${j.fkFrom.name}${cols(j.fkFrom.cols)} and ${j.fkTo.name}${cols(j.fkTo.cols)}`,
    };
  }
  return {
    cardinality: CARDINALITY[r.kind],
    embedding,
    relationship: `${r.fk.name} using ${r.from.name}${cols(r.fromCols)} and ${r.to.name}${cols(r.toCols)}`,
  };
};

/** The order PostgREST keeps the relationships of a table in (`sort`, the derived `Ord`). */
const KIND_ORDER: Record<RelationshipKind, number> = { o2m: 0, m2o: 1, o2o: 2, m2m: 3 };
const cmpText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const cmpList = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const c = cmpText(a[i]!, b[i]!);
    if (c !== 0) return c;
  }
  return a.length - b.length;
};
const pairs = (r: Relationship) => r.fromCols.flatMap((c, i) => [c, r.toCols[i]!]);
const compareRels = (a: Relationship, b: Relationship): number =>
  Number(Boolean(a.computed)) - Number(Boolean(b.computed)) ||
  cmpText(a.to.schema, b.to.schema) ||
  cmpText(a.to.name, b.to.name) ||
  Number(sameRel(a.from, a.to)) - Number(sameRel(b.from, b.to)) ||
  KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
  (a.junction && b.junction
    ? cmpText(a.junction.relation.schema, b.junction.relation.schema) ||
      cmpText(a.junction.relation.name, b.junction.relation.name) ||
      cmpText(a.junction.fkFrom.name, b.junction.fkFrom.name) ||
      cmpText(a.junction.fkTo.name, b.junction.fkTo.name)
    : cmpText(a.fk.name, b.fk.name) || cmpList(pairs(a), pairs(b)));

/**
 * Every relationship of `from`, as PostgREST's schema cache holds them: a foreign key from it
 * (many-to-one, or one-to-one when its columns are a key), one to it (the inverse: one-to-many or
 * one-to-one), many-to-many through a junction whose two foreign keys lie in its primary key
 * (`addM2MRels`), and the computed ones, which replace a detected relationship to the table they are
 * named after. Views take part through the foreign keys introspection derives for them. Only
 * relations of the exposed schemas are known, which is PostgREST's `removeInternal`.
 */
export const relationshipsOf = (cache: SchemaCache, from: Relation): Relationship[] => {
  const out: Relationship[] = [];
  const rel = (schema: string, name: string) => cache.relations.get(relKey(schema, name));
  const owns = (fk: ForeignKey, r: Relation) => fk.schema === r.schema && fk.table === r.name;
  const refers = (fk: ForeignKey, r: Relation) => fk.fschema === r.schema && fk.ftable === r.name;

  for (const fk of cache.foreignKeys) {
    if (owns(fk, from)) {
      const to = rel(fk.fschema, fk.ftable);
      if (to) {
        const kind = isUnique(from, fk.cols) ? "o2o" : "m2o";
        out.push({ kind, from, to, fromCols: fk.cols, toCols: fk.fcols, fk });
      }
    }
    if (refers(fk, from)) {
      const to = rel(fk.schema, fk.table);
      if (to) {
        const kind = isUnique(to, fk.cols) ? "o2o" : "o2m";
        out.push({ kind, from, to, fromCols: fk.fcols, toCols: fk.cols, fk });
      }
    }
  }

  // many-to-many: a junction with a many-to-one to `from` and another to the target, both of whose
  // columns are part of the junction's primary key
  for (const fk1 of cache.foreignKeys) {
    if (!refers(fk1, from)) continue;
    const junction = rel(fk1.schema, fk1.table);
    if (!junction || isUnique(junction, fk1.cols)) continue;
    const key = pgrstKey(junction);
    for (const fk2 of cache.foreignKeys) {
      if (fk2 === fk1 || fk2.name === fk1.name || !owns(fk2, junction) || isUnique(junction, fk2.cols)) continue;
      if (![...fk1.cols, ...fk2.cols].every((c) => key.includes(c))) continue;
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

  // computed relationships: `fn(from_row) RETURNS [SETOF] to_table`
  const computed: Relationship[] = [];
  for (const defs of cache.functions.values()) {
    for (const f of defs) {
      if (f.schema !== from.schema || f.args.length !== 1) continue;
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
      computed.push({
        kind: !f.returnsSet || f.rows === 1 ? "m2o" : "o2m",
        from,
        to,
        fromCols: [],
        toCols: [],
        fk,
        computed: f,
      });
    }
  }
  // a computed relationship named like a table replaces what was detected towards that table
  const replaced = new Set(computed.map((c) => relKey(c.computed!.schema, c.computed!.name)));
  return [...out.filter((r) => !replaced.has(relKey(r.to.schema, r.to.name))), ...computed].sort(compareRels);
};

/**
 * The relationships an embed of `target` (with an optional `!hint`) can mean, as PostgREST's
 * `findRel` picks them: the target is a table or view, a foreign key constraint, or a column of a
 * single-column one; the hint a constraint, a column on either side, or a junction table. A
 * self-relationship is told apart by convention -- the table's name is the one-to-many, a column's
 * name the many-to-one.
 */
export const findRelationships = (
  cache: SchemaCache,
  from: Relation,
  target: string,
  hint?: string,
): Relationship[] => {
  const single = (r: Relationship) => !r.junction && !r.computed && r.fromCols.length === 1;
  const fkCol = (r: Relationship, name: string) => single(r) && r.fromCols[0] === name;
  const refCol = (r: Relationship, name: string) => single(r) && r.toCols[0] === name;
  const constraint = (r: Relationship, name: string) => !r.junction && !r.computed && r.fk.name === name;
  return relationshipsOf(cache, from).filter((r) => {
    if (r.computed) return target === r.computed.name;
    if (sameRel(r.from, r.to)) {
      if (hint === undefined)
        return (target === r.to.name && r.kind === "o2m") || (fkCol(r, target) && r.kind === "m2o");
      return target === r.to.name && r.kind === "o2m" && refCol(r, hint);
    }
    if (hint === undefined) {
      return target === r.to.name || (constraint(r, target) && !isView(r.to)) || (fkCol(r, target) && !isView(r.to));
    }
    return (
      target === r.to.name &&
      (constraint(r, hint) ||
        fkCol(r, hint) ||
        refCol(r, hint) ||
        (r.junction !== undefined && r.junction.relation.name === hint))
    );
  });
};

/**
 * PostgREST's hint when nothing matched (`noRelBetweenHint`): a close name for the target among the
 * tables `from` is related to, or -- when `from` is related to nothing -- for `from` among the tables
 * that are related to something.
 */
const noRelationshipHint = (cache: SchemaCache, from: Relation, target: string): string | null => {
  // PostgREST keeps a table's entry when its relationships all lead out of the exposed schemas, with
  // nothing in it: such a table is "found", and there is then no child to suggest
  const known =
    cache.foreignKeys.some(
      (fk) =>
        (fk.schema === from.schema && fk.table === from.name) ||
        (fk.fschema === from.schema && fk.ftable === from.name),
    ) ||
    [...cache.functions.values()].some((defs) =>
      defs.some((f) => f.argRelation?.schema === from.schema && f.argRelation.name === from.name && f.returnRelation),
    );
  const related = relationshipsOf(cache, from);
  if (known) {
    const names = related.map((r) => (r.computed ? r.computed.name : r.to.name));
    const best = fuzzyGetOne(
      names.filter((n) => n.toLowerCase() !== target.toLowerCase()),
      target,
      0.33,
    );
    return best === undefined || names.includes(target) ? null : `Perhaps you meant '${best}' instead of '${target}'.`;
  }
  const parents = new Set<string>();
  for (const fk of cache.foreignKeys) {
    if (fk.schema === from.schema && cache.relations.has(relKey(fk.schema, fk.table))) parents.add(fk.table);
    if (fk.fschema === from.schema && cache.relations.has(relKey(fk.fschema, fk.ftable))) parents.add(fk.ftable);
  }
  const best = fuzzyGetOne([...parents], from.name, 0.33);
  return best === undefined ? null : `Perhaps you meant '${best}' instead of '${from.name}'.`;
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
      noRelationshipHint(cache, from, target),
    );
  }
  throw new EngineError(
    "ambiguous_relationship",
    `Could not embed because more than one relationship was found for '${from.name}' and '${target}'`,
    // PostgREST answers a list of objects here; the transport parses it back (`data.json`)
    JSON.stringify(found.map(describe)),
    `Try changing '${target}' to one of the following: ${found
      .map((r) => `'${r.to.name}!${r.junction ? r.junction.relation.name : r.fk.name}'`)
      .join(", ")}. Find the desired relationship in the 'details' key.`,
    { json: true },
  );
};

/** Look up a relation by (optional) schema and name, or throw `table_not_found`. */
/** The key `@tspg/rest` names a row by, as PostgREST does: a view's {@link Relation.pgrstPk}, a table's primary key. */
export const pgrstKey = (rel: Relation): ReadonlyArray<string> => rel.pgrstPk ?? rel.pk;

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

export { levenshtein };
