import type { DbSession } from "@tspg/adapters";
import { literal } from "./quote";
import { relKey } from "./model";
import type {
  Column,
  CompositeRef,
  CompositeType,
  ForeignKey,
  FunctionArg,
  FunctionDef,
  MediaHandler,
  Relation,
  RelationKind,
  SchemaCache,
} from "./model";

const kindOf = (k: string): RelationKind =>
  k === "v" ? "view" : k === "m" ? "matview" : k === "f" ? "foreign" : k === "p" ? "partitioned" : "table";

const schemaList = (schemas: ReadonlyArray<string>) => `ARRAY[${schemas.map(literal).join(",")}]::text[]`;

const asJson = (inner: string) => `SELECT coalesce(json_agg(r), '[]'::json)::text AS j FROM (${inner}) r`;

/**
 * Labels of the enum behind a type oid -- the type itself, or the element type of an array of it --
 * in declaration order, or NULL when it is not an enum. A domain over an enum is not unwrapped, as
 * {@link Column.enumLabels} says.
 */
const enumLabelsSql = (oid: string) => `(
            SELECT json_agg(e.enumlabel ORDER BY e.enumsortorder)
              FROM pg_type ent
              LEFT JOIN pg_type ene ON ene.oid = ent.typelem
              JOIN pg_enum e ON e.enumtypid = CASE WHEN ent.typtype = 'e' THEN ent.oid
                                                   WHEN ene.typtype = 'e' THEN ene.oid END
             WHERE ent.oid = ${oid})`;

/**
 * `{ schema, name }` of the composite type behind a type oid -- through arrays (`addr[]`) and
 * domains, which nest in any order -- or NULL when there is none. `format_type` cannot answer this:
 * `api.addr` and `api.jd` read the same way.
 */
const compositeOfSql = (oid: string) => `(
            WITH RECURSIVE under(oid, depth) AS (
              SELECT ${oid}, 0
              UNION ALL
              SELECT CASE WHEN t.typtype = 'd' THEN t.typbasetype ELSE t.typelem END, u.depth + 1
                FROM under u JOIN pg_type t ON t.oid = u.oid
               WHERE u.depth < 8 AND t.typrelid = 0 AND (t.typtype = 'd' OR t.typcategory = 'A')
            )
            SELECT json_build_object('schema', tn.nspname, 'name', t.typname)
              FROM under u
              JOIN pg_type t ON t.oid = u.oid
              JOIN pg_class tc ON tc.oid = t.typrelid AND tc.relkind = 'c'
              JOIN pg_namespace tn ON tn.oid = t.typnamespace
             LIMIT 1)`;

const run = async <T>(db: DbSession, sql: string): Promise<T[]> => {
  const rows = await db.query(asJson(sql));
  const j = rows[0]?.["j"];
  return JSON.parse(typeof j === "string" ? j : "[]") as T[];
};

/**
 * The tables the views of `schemas` read from, as `(schema, name)` -- including the ones outside
 * `schemas`, which is the usual arrangement: views in `api` over tables in `core`. A view borrows
 * its nullability and its primary key from there, so both have to be legible even when the schema
 * holding them is not exposed.
 */
const sourceRelationsSql = (S: string): string =>
  `SELECT DISTINCT tn.nspname AS schema, tc.relname AS name
     FROM pg_rewrite rw
     JOIN pg_class vc ON vc.oid = rw.ev_class AND vc.relkind IN ('v','m')
     JOIN pg_namespace vn ON vn.oid = vc.relnamespace
     CROSS JOIN LATERAL regexp_matches(rw.ev_action::text, ':resorigtbl (\\d+)', 'g') AS m(x)
     JOIN pg_class tc ON tc.oid = m.x[1]::oid
     JOIN pg_namespace tn ON tn.oid = tc.relnamespace
    WHERE vn.nspname = ANY(${S}) AND rw.rulename = '_RETURN' AND m.x[1]::oid <> 0`;

interface ViewColumn {
  readonly vschema: string;
  readonly vname: string;
  readonly vcol: string;
  readonly tschema: string;
  readonly tname: string;
  readonly tcol: string;
}

/**
 * Foreign keys seen through views: a view that exposes the columns of a foreign key (directly, or
 * through other views) gets the same relationships as the table, towards tables and views alike.
 */
const viewForeignKeys = (fks: ReadonlyArray<ForeignKey>, rows: ReadonlyArray<ViewColumn>): ForeignKey[] => {
  const viewCols = new Map<string, Map<string, { key: string; col: string }>>();
  for (const r of rows) {
    const key = relKey(r.vschema, r.vname);
    const m = viewCols.get(key) ?? new Map();
    m.set(r.vcol, { key: relKey(r.tschema, r.tname), col: r.tcol });
    viewCols.set(key, m);
  }
  // follow view -> view chains down to the table behind each column
  const base = (key: string, col: string, depth = 0): { key: string; col: string } => {
    const next = viewCols.get(key)?.get(col);
    return next && depth < 16 ? base(next.key, next.col, depth + 1) : { key, col };
  };
  /** Every view that exposes all of `cols` of table `tableKey`, with the view-side column names. */
  const exposing = (tableKey: string, cols: ReadonlyArray<string>) => {
    const out: Array<{ schema: string; name: string; cols: string[] }> = [];
    for (const [vkey, m] of viewCols) {
      const names: string[] = [];
      for (const c of cols) {
        let found: string | undefined;
        for (const [vcol] of m) {
          const b = base(vkey, vcol);
          if (b.key === tableKey && b.col === c) {
            found = vcol;
            break;
          }
        }
        if (found === undefined) break;
        names.push(found);
      }
      if (names.length === cols.length) {
        const [schema, ...rest] = vkey.split(".");
        out.push({ schema: schema!, name: rest.join("."), cols: names });
      }
    }
    return out;
  };

  const out: ForeignKey[] = [];
  for (const fk of fks) {
    const sources = [
      { schema: fk.schema, name: fk.table, cols: [...fk.cols] },
      ...exposing(relKey(fk.schema, fk.table), fk.cols),
    ];
    const targets = [
      { schema: fk.fschema, name: fk.ftable, cols: [...fk.fcols] },
      ...exposing(relKey(fk.fschema, fk.ftable), fk.fcols),
    ];
    for (const [i, s] of sources.entries()) {
      for (const [j, t] of targets.entries()) {
        if (i === 0 && j === 0) continue;
        out.push({
          name: fk.name,
          schema: s.schema,
          table: s.name,
          cols: s.cols,
          fschema: t.schema,
          ftable: t.name,
          fcols: t.cols,
        });
      }
    }
  }
  return out;
};

/** Read the catalog and build a fresh {@link SchemaCache}. */
export const readCatalog = async (db: DbSession, schemas: ReadonlyArray<string>): Promise<SchemaCache> => {
  const S = schemaList(schemas);

  const relRows = await run<{
    schema: string;
    name: string;
    kind: string;
    comment: string | null;
    bits: number;
  }>(
    db,
    `SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS kind,
            obj_description(c.oid, 'pg_class') AS comment,
            pg_relation_is_updatable(c.oid, true) AS bits
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY(${S})
        AND c.relkind IN ('r','v','m','f','p')
        AND NOT c.relispartition
      ORDER BY 1, 2`,
  );

  const colRows = await run<{
    schema: string;
    table: string;
    name: string;
    type: string;
    nullable: boolean;
    has_default: boolean;
    default_expr: string | null;
    generated: boolean;
    identity: string;
    comment: string | null;
    pos: number;
    enum_labels: string[] | null;
    composite: CompositeRef | null;
  }>(
    db,
    `SELECT n.nspname AS schema, c.relname AS "table", a.attname AS name,
            format_type(a.atttypid, a.atttypmod) AS type,
            ${compositeOfSql("a.atttypid")} AS composite,
            ${enumLabelsSql("a.atttypid")} AS enum_labels,
            NOT a.attnotnull AS nullable,
            (a.atthasdef OR a.attidentity <> '') AS has_default,
            -- what PostgREST's schema cache reads as the default: a domain's own when the column has
            -- none, and the sequence of an identity column (\`missing=default\` writes it)
            CASE
              WHEN d.adbin IS NULL AND ty.typtype = 'd' THEN pg_get_expr(ty.typdefaultbin, 0)
              WHEN a.attidentity <> '' THEN format('nextval(%L::regclass)', pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname))
              ELSE pg_get_expr(d.adbin, d.adrelid)
            END AS default_expr,
            (a.attgenerated <> '') AS generated,
            a.attidentity::text AS identity,
            col_description(c.oid, a.attnum) AS comment,
            a.attnum AS pos
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_type ty ON ty.oid = a.atttypid
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE n.nspname = ANY(${S})
        AND c.relkind IN ('r','v','m','f','p')
        AND NOT c.relispartition
        AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY 1, 2, a.attnum`,
  );

  // Ordered, like every other query here: the heap order of pg_constraint is not stable, and a
  // generated descriptor -- the ambiguous embed `hints` especially -- is committed by the app.
  const conRows = await run<{
    name: string;
    type: string;
    schema: string;
    table: string;
    cols: string[];
    fschema: string | null;
    ftable: string | null;
    fcols: string[] | null;
  }>(
    db,
    `SELECT con.conname AS name, con.contype::text AS type,
            ns.nspname AS schema, rel.relname AS "table",
            (SELECT json_agg(a.attname ORDER BY k.ord)
               FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS cols,
            fns.nspname AS fschema, frel.relname AS ftable,
            (SELECT json_agg(a.attname ORDER BY k.ord)
               FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum) AS fcols
       FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid
       JOIN pg_namespace ns ON ns.oid = rel.relnamespace
       LEFT JOIN pg_class frel ON frel.oid = con.confrelid
       LEFT JOIN pg_namespace fns ON fns.oid = frel.relnamespace
      WHERE con.contype IN ('p','u','f')
        AND con.conparentid = 0
        AND (ns.nspname = ANY(${S}) OR fns.nspname = ANY(${S})
             OR (ns.nspname, rel.relname) IN (${sourceRelationsSql(S)}))
      ORDER BY ns.nspname, rel.relname, con.conname`,
  );

  // Plain columns of views (and materialized views) and the table column each one is read from,
  // taken from the rewrite rule's target list. PostgREST uses this to follow foreign keys through views.
  // The DISTINCT ON has to be ordered by its own keys, so the naming order is the outer one: it
  // decides the order of the foreign keys views add, and which column of a view that exposes one
  // table column twice is the one a key is built from.
  const viewRows = await run<{
    vschema: string;
    vname: string;
    vcol: string;
    tschema: string;
    tname: string;
    tcol: string;
  }>(
    db,
    `SELECT v.vschema, v.vname, v.vcol, v.tschema, v.tname, v.tcol
       FROM (SELECT DISTINCT ON (vc.oid, m.x[1]::int)
                    vn.nspname AS vschema, vc.relname AS vname, va.attname AS vcol, va.attnum AS vpos,
                    tn.nspname AS tschema, tc.relname AS tname, ta.attname AS tcol
               FROM pg_rewrite rw
               JOIN pg_class vc ON vc.oid = rw.ev_class AND vc.relkind IN ('v','m')
               JOIN pg_namespace vn ON vn.oid = vc.relnamespace
               CROSS JOIN LATERAL regexp_matches(rw.ev_action::text,
                    ':resno (\\d+) :resname [^:]* :ressortgroupref \\d+ :resorigtbl (\\d+) :resorigcol (\\d+) :resjunk false', 'g')
                    WITH ORDINALITY AS m(x, ord)
               JOIN pg_attribute va ON va.attrelid = vc.oid AND va.attnum = m.x[1]::int AND NOT va.attisdropped
               JOIN pg_class tc ON tc.oid = m.x[2]::oid
               JOIN pg_namespace tn ON tn.oid = tc.relnamespace
               JOIN pg_attribute ta ON ta.attrelid = tc.oid AND ta.attnum = m.x[3]::int
              WHERE vn.nspname = ANY(${S}) AND rw.rulename = '_RETURN' AND m.x[2]::oid <> 0
              -- the last match for a column wins the DISTINCT ON, so this inner order is the rule's
              ORDER BY vc.oid, m.x[1]::int, m.ord DESC) v
      ORDER BY v.vschema, v.vname, v.vpos`,
  );

  // Views whose own query has an outer join, and whose columns therefore cannot inherit the source
  // column's `NOT NULL`: the preserved side of a `LEFT`, `RIGHT` or `FULL` join produces nulls for
  // columns the catalog calls `NOT NULL`. `resorigtbl` names the column either way, so provenance
  // alone cannot tell the two apart -- this is what tells them apart.
  //
  // Read off the rewrite rule's node tree, where a `JoinExpr` spells its kind as `:jointype N`:
  // 0 inner, 1 left, 2 full, 3 right, and 4/5 semi/anti (from `EXISTS`/`IN`, which null nothing).
  // The whole tree is scanned, so a view is excluded by a join anywhere in it, including one in a
  // subquery that cannot reach the columns at issue. That is the safe direction to be wrong in:
  // the column keeps the `| null` it has today.
  const outerJoinRows = await run<{ schema: string; name: string }>(
    db,
    `SELECT n.nspname AS schema, c.relname AS name
       FROM pg_rewrite rw
       JOIN pg_class c ON c.oid = rw.ev_class AND c.relkind IN ('v','m')
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY(${S}) AND rw.rulename = '_RETURN'
        AND rw.ev_action::text ~ ':jointype [1-3]'`,
  );
  const outerJoinViews = new Set(outerJoinRows.map((r) => relKey(r.schema, r.name)));

  // `attnotnull` of the columns those views read, which are not themselves exposed: a view in `api`
  // over a table in `core` is the usual shape, and `schemas: ["api"]` is the usual way to expose it.
  // Without this the source column would be invisible and every view column would stay nullable --
  // exactly the case the inheritance is for. Nullability only: nothing here becomes a relation.
  const sourceNullRows = await run<{ schema: string; table: string; name: string; nullable: boolean }>(
    db,
    `SELECT DISTINCT n.nspname AS schema, c.relname AS "table", a.attname AS name,
            NOT a.attnotnull AS nullable
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT (n.nspname = ANY(${S}))
        AND a.attnum > 0 AND NOT a.attisdropped
        AND (n.nspname, c.relname) IN (${sourceRelationsSql(S)})`,
  );

  const fnRows = await run<{
    schema: string;
    name: string;
    returns_set: boolean;
    volatility: string;
    return_type: string;
    return_typtype: string;
    has_out: boolean;
    n_defaults: number;
    comment: string | null;
    rows: number;
    arg_rel: { schema: string; name: string } | null;
    ret_rel: { schema: string; name: string } | null;
    ret_media: { name: string; bytea: boolean } | null;
    return_enum: string[] | null;
    return_composite: CompositeRef | null;
    args: Array<{ name: string; type: string; mode: string; enum: string[] | null; composite: CompositeRef | null }>;
  }>(
    db,
    `SELECT n.nspname AS schema, p.proname AS name,
            p.proretset AS returns_set, p.provolatile::text AS volatility,
            format_type(p.prorettype, NULL) AS return_type,
            ${enumLabelsSql("p.prorettype")} AS return_enum,
            ${compositeOfSql("p.prorettype")} AS return_composite,
            rt.typtype::text AS return_typtype,
            coalesce(p.proargmodes && ARRAY['o','b','t']::"char"[], false) AS has_out,
            p.pronargdefaults AS n_defaults,
            obj_description(p.oid, 'pg_proc') AS comment,
            p.prorows::float8 AS rows,
            CASE WHEN rt.typtype = 'd' AND rt.typname LIKE '%/%'
                 THEN json_build_object('name', rt.typname, 'bytea', rt.typbasetype = 'bytea'::regtype) END AS ret_media,
            (SELECT json_build_object('schema', n2.nspname, 'name', c2.relname)
               FROM pg_type t2 JOIN pg_class c2 ON c2.oid = t2.typrelid JOIN pg_namespace n2 ON n2.oid = c2.relnamespace
              WHERE p.pronargs = 1 AND t2.oid = p.proargtypes[0] AND c2.relkind IN ('r','v','m','f','p')) AS arg_rel,
            (SELECT json_build_object('schema', n2.nspname, 'name', c2.relname)
               FROM pg_type t2 JOIN pg_class c2 ON c2.oid = t2.typrelid JOIN pg_namespace n2 ON n2.oid = c2.relnamespace
              -- a domain over a table's row type returns that table's rows
              WHERE t2.oid = CASE WHEN rt.typtype = 'd' THEN rt.typbasetype ELSE p.prorettype END
                AND c2.relkind IN ('r','v','m','f','p')) AS ret_rel,
            (SELECT coalesce(json_agg(json_build_object(
                       'name', coalesce(p.proargnames[t.i], ''),
                       'type', format_type(t.typ, NULL),
                       'enum', ${enumLabelsSql("t.typ")},
                       'composite', ${compositeOfSql("t.typ")},
                       'mode', coalesce(p.proargmodes[t.i]::text, 'i')) ORDER BY t.i), '[]'::json)
               FROM unnest(coalesce(p.proallargtypes, string_to_array(p.proargtypes::text, ' ')::oid[]))
                    WITH ORDINALITY AS t(typ, i)
              WHERE coalesce(p.proargmodes[t.i]::text, 'i') IN ('i','b','v')) AS args
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       JOIN pg_type rt ON rt.oid = p.prorettype
      WHERE n.nspname = ANY(${S})
        AND p.prokind = 'f'
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
      -- overloads share a name, so the signature breaks the tie: without it the order is whatever
      -- the catalog scan returns, which differs between a database and a copy of it, and the
      -- generated types churn
      ORDER BY 1, 2, pg_get_function_identity_arguments(p.oid)`,
  );

  // Composite types are reached from the exposed schemas rather than listed by schema: the type of a
  // column may live anywhere, and a composite nests other composites.
  const compRows = await run<{
    schema: string;
    name: string;
    comment: string | null;
    attrs: Array<{ name: string; type: string; pos: number; enum: string[] | null; composite: CompositeRef | null }>;
  }>(
    db,
    `WITH RECURSIVE seed(oid) AS (
            SELECT a.atttypid
              FROM pg_attribute a
              JOIN pg_class c ON c.oid = a.attrelid
              JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = ANY(${S}) AND c.relkind IN ('r','v','m','f','p')
               AND a.attnum > 0 AND NOT a.attisdropped
            UNION
            SELECT t.typ
              FROM pg_proc p
              JOIN pg_namespace n ON n.oid = p.pronamespace
              CROSS JOIN LATERAL unnest(array_append(
                      coalesce(p.proallargtypes, string_to_array(p.proargtypes::text, ' ')::oid[]),
                      p.prorettype)) AS t(typ)
             WHERE n.nspname = ANY(${S}) AND p.prokind = 'f'
          ),
          -- down through arrays, domains and the fields of a composite, until nothing new shows up
          walk(oid) AS (
            SELECT oid FROM seed
            UNION
            SELECT x.oid
              FROM walk w
              JOIN pg_type t ON t.oid = w.oid
              CROSS JOIN LATERAL (
                SELECT t.typelem AS oid WHERE t.typcategory = 'A'
                UNION ALL
                SELECT t.typbasetype WHERE t.typtype = 'd'
                UNION ALL
                SELECT a.atttypid
                  FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid
                 WHERE c.oid = t.typrelid AND c.relkind = 'c' AND a.attnum > 0 AND NOT a.attisdropped
              ) x
             WHERE x.oid <> 0
          )
     SELECT tn.nspname AS schema, t.typname AS name,
            obj_description(t.oid, 'pg_type') AS comment,
            (SELECT coalesce(json_agg(json_build_object(
                      'name', a.attname,
                      'type', format_type(a.atttypid, a.atttypmod),
                      'pos', a.attnum,
                      'enum', ${enumLabelsSql("a.atttypid")},
                      'composite', ${compositeOfSql("a.atttypid")}) ORDER BY a.attnum), '[]'::json)
               FROM pg_attribute a
              WHERE a.attrelid = t.typrelid AND a.attnum > 0 AND NOT a.attisdropped) AS attrs
       FROM walk w
       JOIN pg_type t ON t.oid = w.oid
       JOIN pg_class c ON c.oid = t.typrelid AND c.relkind = 'c'
       JOIN pg_namespace tn ON tn.oid = t.typnamespace
      ORDER BY 1, 2`,
  );

  const handlerRows = await run<{
    schema: string;
    name: string;
    arg_rel: { schema: string; name: string } | null;
    bytea: boolean;
  }>(
    db,
    `SELECT n.nspname AS schema, p.proname AS name,
            (SELECT json_build_object('schema', n2.nspname, 'name', c2.relname)
               FROM pg_type t2 JOIN pg_class c2 ON c2.oid = t2.typrelid JOIN pg_namespace n2 ON n2.oid = c2.relnamespace
              WHERE t2.oid = p.proargtypes[0] AND c2.relkind IN ('r','v','m','f','p')) AS arg_rel,
            rt.typbasetype = 'bytea'::regtype AS bytea
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       JOIN pg_type rt ON rt.oid = p.prorettype AND rt.typtype = 'd'
      WHERE n.nspname = ANY(${S})
        AND p.prokind = 'a' AND p.pronargs = 1 AND p.proname LIKE '%/%'
        AND (p.proargtypes[0] = 'anyelement'::regtype
             OR EXISTS (SELECT 1 FROM pg_type t3 JOIN pg_class c3 ON c3.oid = t3.typrelid WHERE t3.oid = p.proargtypes[0]))
      ORDER BY 1, 2`,
  );
  const mediaHandlers: MediaHandler[] = handlerRows.map((h) => ({
    schema: h.schema,
    mediaType: h.name.toLowerCase(),
    ...(h.arg_rel ? { argRelation: h.arg_rel } : {}),
    bytea: h.bytea,
  }));

  // ---- assemble ----
  const pk = new Map<string, string[]>();
  const uniques = new Map<string, string[][]>();
  const foreignKeys: ForeignKey[] = [];
  for (const c of conRows) {
    const key = relKey(c.schema, c.table);
    if (c.type === "p") pk.set(key, c.cols);
    else if (c.type === "u") uniques.set(key, [...(uniques.get(key) ?? []), c.cols]);
    else if (c.type === "f" && c.fschema && c.ftable && c.fcols) {
      foreignKeys.push({
        name: c.name,
        schema: c.schema,
        table: c.table,
        cols: c.cols,
        fschema: c.fschema,
        ftable: c.ftable,
        fcols: c.fcols,
      });
    }
  }

  foreignKeys.push(...viewForeignKeys(foreignKeys, viewRows));

  // view column -> the table column it is read from, following view-over-view chains
  const viewSource = new Map<string, { schema: string; table: string; column: string }>();
  {
    const direct = new Map<string, { key: string; col: string }>();
    for (const r of viewRows)
      direct.set(`${relKey(r.vschema, r.vname)}.${r.vcol}`, { key: relKey(r.tschema, r.tname), col: r.tcol });
    for (const [from, first] of direct) {
      let at = first;
      for (let depth = 0; depth < 16; depth++) {
        const next = direct.get(`${at.key}.${at.col}`);
        if (!next) break;
        at = next;
      }
      const [schema, ...rest] = at.key.split(".");
      viewSource.set(from, { schema: schema!, table: rest.join("."), column: at.col });
    }
  }

  // Every column by `schema.table.column`, so a view column can be read against the table column it
  // comes from. Built before the loop below: a view may be introspected before the table it reads.
  const nullableByCol = new Map<string, boolean>();
  for (const r of sourceNullRows) nullableByCol.set(`${relKey(r.schema, r.table)}.${r.name}`, r.nullable);
  for (const c of colRows) nullableByCol.set(`${relKey(c.schema, c.table)}.${c.name}`, c.nullable);

  const colsByRel = new Map<string, Column[]>();
  for (const c of colRows) {
    const key = relKey(c.schema, c.table);
    const list = colsByRel.get(key) ?? [];
    const source = viewSource.get(`${key}.${c.name}`);
    // `attnotnull` is always false on a view column -- a view carries no constraint of its own -- so
    // what the catalog says there is not an answer. When the column is read straight from a table
    // column and no outer join can null it, the table's answer is the true one.
    //
    // Only `nullable` is taken this way. A default is deliberately not: `pg_attrdef` being empty for
    // the view *is* the truth, because `SET col = DEFAULT` through a view that has no default of
    // its own writes a null rather than the table's default. Omitting the column on an insert does
    // reach that default, but that is insert optionality, which the generator works out from
    // `source` instead -- see `packages/query/src/types.ts`.
    const inherited =
      source && !outerJoinViews.has(key)
        ? nullableByCol.get(`${relKey(source.schema, source.table)}.${source.column}`)
        : undefined;
    list.push({
      name: c.name,
      type: c.type,
      ...(c.enum_labels ? { enumLabels: c.enum_labels } : {}),
      ...(c.composite ? { composite: c.composite } : {}),
      ...(source ? { source } : {}),
      nullable: inherited ?? c.nullable,
      hasDefault: c.has_default,
      defaultExpr: c.default_expr,
      generated: c.generated,
      ...(c.identity === "a"
        ? { identity: "always" as const }
        : c.identity === "d"
          ? { identity: "by-default" as const }
          : {}),
      comment: c.comment,
      position: c.pos,
    });
    colsByRel.set(key, list);
  }

  // The primary key of a view: the one of the table behind it, named in the view's own columns, when
  // the view exposes every column of that key. A view has no `pg_constraint` row of its own, so
  // without this it has no key at all -- and a key is what tells a single row from a set of one.
  // Same exclusion as for nullability: an outer join can leave a key column null.
  const viewPk = (key: string): string[] | undefined => {
    if (outerJoinViews.has(key)) return undefined;
    // base table column -> the view column reading it, for this view only
    const exposed = new Map<string, string>();
    for (const col of colsByRel.get(key) ?? []) {
      const src = col.source;
      if (src) exposed.set(`${relKey(src.schema, src.table)}.${src.column}`, col.name);
    }
    for (const tableKey of new Set([...exposed.keys()].map((k) => k.slice(0, k.lastIndexOf("."))))) {
      const cols = pk.get(tableKey);
      if (!cols?.length) continue;
      const names = cols.map((c) => exposed.get(`${tableKey}.${c}`));
      if (names.every((n) => n !== undefined)) return names as string[];
    }
    return undefined;
  };

  // The key of a view as PostgREST's schema cache reads it (`addViewPrimaryKeys`): every primary key
  // column of every table behind it that the view exposes, outer join or not, whole key or not. It
  // does not tell a row from a set -- `viewPk` does that -- but it is what PostgREST's `Location`
  // and `PUT` are made of, so `@tspg/rest` answers with it.
  const pgrstViewPk = (key: string): string[] | undefined => {
    const exposed = new Map<string, string>();
    for (const col of colsByRel.get(key) ?? []) {
      const src = col.source;
      const at = src ? `${relKey(src.schema, src.table)}.${src.column}` : undefined;
      if (at && !exposed.has(at)) exposed.set(at, col.name);
    }
    const names: string[] = [];
    for (const tableKey of new Set([...exposed.keys()].map((k) => k.slice(0, k.lastIndexOf("."))))) {
      for (const c of pk.get(tableKey) ?? []) {
        const n = exposed.get(`${tableKey}.${c}`);
        if (n !== undefined && !names.includes(n)) names.push(n);
      }
    }
    return names.length ? names : undefined;
  };

  const relations = new Map<string, Relation>();
  for (const r of relRows) {
    const key = relKey(r.schema, r.name);
    relations.set(key, {
      schema: r.schema,
      name: r.name,
      kind: kindOf(r.kind),
      columns: colsByRel.get(key) ?? [],
      pk: pk.get(key) ?? viewPk(key) ?? [],
      ...(pk.has(key) ? {} : { pgrstPk: pgrstViewPk(key) ?? [] }),
      uniques: uniques.get(key) ?? [],
      insertable: (r.bits & 8) === 8,
      updatable: (r.bits & 4) === 4,
      deletable: (r.bits & 16) === 16,
      comment: r.comment,
    });
  }

  const functions = new Map<string, FunctionDef[]>();
  for (const f of fnRows) {
    const nDefaults = f.n_defaults;
    const args: FunctionArg[] = f.args.map((a, i) => ({
      name: a.name,
      type: a.type,
      hasDefault: i >= f.args.length - nDefaults,
      variadic: a.mode === "v",
      ...(a.enum ? { enumLabels: a.enum } : {}),
      ...(a.composite ? { composite: a.composite } : {}),
    }));
    const def: FunctionDef = {
      schema: f.schema,
      name: f.name,
      args,
      returnType: f.return_type,
      ...(f.return_enum ? { returnEnumLabels: f.return_enum } : {}),
      ...(f.return_composite ? { returnComposite: f.return_composite } : {}),
      returnsSet: f.returns_set,
      returnsComposite:
        f.has_out ||
        f.return_typtype === "c" ||
        f.return_type === "record" ||
        (f.return_typtype === "d" && f.ret_rel !== null),
      ...(f.return_type === "record" && !f.has_out ? { returnsAnonymousRecord: true } : {}),
      returnsVoid: f.return_type === "void",
      volatility: f.volatility === "i" ? "immutable" : f.volatility === "s" ? "stable" : "volatile",
      comment: f.comment,
      rows: f.rows,
      ...(f.arg_rel ? { argRelation: f.arg_rel } : {}),
      ...(f.ret_rel ? { returnRelation: f.ret_rel } : {}),
      ...(f.ret_media && !f.returns_set ? { returnMediaType: f.ret_media } : {}),
    };
    const key = relKey(f.schema, f.name);
    functions.set(key, [...(functions.get(key) ?? []), def]);
  }

  const composites = new Map<string, CompositeType>();
  for (const c of compRows) {
    composites.set(relKey(c.schema, c.name), {
      schema: c.schema,
      name: c.name,
      attributes: c.attrs.map((a) => ({
        name: a.name,
        type: a.type,
        ...(a.enum ? { enumLabels: a.enum } : {}),
        ...(a.composite ? { composite: a.composite } : {}),
        position: a.pos,
      })),
      comment: c.comment,
    });
  }

  return { schemas, relations, foreignKeys, functions, mediaHandlers, composites };
};
