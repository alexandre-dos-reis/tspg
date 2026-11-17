import { EngineError } from "./errors";
import { cString, literal } from "@tspg/introspect";

export { cString, literal };

/** Quote an SQL identifier: `a"b` → `"a""b"`. */
export const quoteIdent = (name: string): string => `"${cString(name).replace(/"/g, '""')}"`;

export const quoteQualified = (schema: string, name: string): string => `${quoteIdent(schema)}.${quoteIdent(name)}`;

const ID = "[A-Za-z_][A-Za-z0-9_]*";
const MOD = "(?:\\(\\s*\\d+(?:\\s*,\\s*\\d+)?\\s*\\))?";
const ARR = "(?:\\[\\])*";
// Types made of several words are matched against a fixed list, so that a cast
// can never smuggle SQL keywords (`::int4 from secrets`) into the query.
const MULTI_WORD =
  "double precision|character varying|national character varying|national character|bit varying|" +
  "timestamp(?:\\(\\d+\\))? with(?:out)? time zone|time(?:\\(\\d+\\))? with(?:out)? time zone";
const TYPE_RE = new RegExp(`^(?:(?:${MULTI_WORD})|${ID}(?:\\.${ID})?)${MOD}${ARR}$`, "i");

/** Validate a user-supplied cast target (`::type`) and return it verbatim. */
export const safeType = (type: string): string => {
  const t = type.trim();
  if (t.length > 100 || !TYPE_RE.test(t)) {
    throw new EngineError("invalid_input", "Invalid type in cast", `"${type}" is not an allowed cast target`);
  }
  return t;
};
