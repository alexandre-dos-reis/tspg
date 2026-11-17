import type { Column, CompositeRef } from "./model";

/** A plain identifier: usable as a bare property name. */
export const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** An object key: bare when it is a plain identifier, quoted otherwise. */
export const tsKey = (name: string): string => (IDENTIFIER.test(name) ? name : JSON.stringify(name));

/**
 * Map a `format_type` string to a TypeScript type. Anything not recognised becomes `unknown`
 * rather than `string`: a type that is merely plausible is worse than one that forces a check.
 */
const scalar = (pgType: string): string => {
  const base = pgType.trim().replace(/\(.*\)$/, "");
  switch (base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : base) {
    case "smallint":
    case "integer":
    case "bigint":
    case "numeric":
    case "decimal":
    case "real":
    case "double precision":
    case "smallserial":
    case "serial":
    case "bigserial":
      return "number";
    case "boolean":
      return "boolean";
    case "text":
    case "character varying":
    case "character":
    case "bpchar":
    case "varchar":
    case "char":
    case "name":
    case "citext":
    case "uuid":
    case "date":
    case "timestamp with time zone":
    case "timestamp without time zone":
    case "time with time zone":
    case "time without time zone":
    case "interval":
    case "bytea":
    case "money":
    case "xml":
    case "inet":
    case "cidr":
    case "macaddr":
    case "macaddr8":
    case "tsvector":
      return "string";
    default:
      return "unknown";
  }
};

/**
 * Names the type alias of a composite type, and records that the generated module refers to it.
 * `undefined` when the catalog does not carry its fields, which leaves the value `unknown`.
 */
export type CompositeNamer = (ref: CompositeRef) => string | undefined;

/** The type of one column's value: enum labels, composite types and array dimensions included. */
export const columnType = (
  col: Pick<Column, "type" | "enumLabels" | "composite">,
  compositeName?: CompositeNamer,
): string => {
  let t = col.type.trim();
  let dims = 0;
  while (t.endsWith("[]")) {
    t = t.slice(0, -2).trim();
    dims++;
  }
  const labels = col.enumLabels;
  const composite = col.composite && compositeName ? compositeName(col.composite) : undefined;
  const inner = labels?.length ? labels.map((l) => JSON.stringify(l)).join(" | ") : (composite ?? scalar(t));
  const wrapped = dims > 0 && inner.includes(" | ") ? `(${inner})` : inner;
  return wrapped + "[]".repeat(dims);
};
