/**
 * What the database sees of a text: it ends at the first NUL byte, as a C string does -- that is where
 * PostgREST's driver cuts a name or a value, so that is where the library does. A NUL is never sent on.
 */
export const cString = (text: string): string => {
  const nul = text.indexOf("\0");
  return nul < 0 ? text : text.slice(0, nul);
};

/**
 * Escape a string as an SQL literal of *unknown* type, so Postgres infers the
 * type from context (`int_col = '5'` works). Mirrors `pg.escapeLiteral`.
 *
 * We inline literals (like PostgREST does) instead of binding parameters
 * because some drivers (Bun.sql) re-encode string parameters as JSON when the
 * inferred type is json/jsonb.
 */
export const literal = (text: string): string => {
  const value = cString(text);
  let out = `'${value.replace(/'/g, "''")}'`;
  if (out.includes("\\")) out = `E${out.replace(/\\/g, "\\\\")}`;
  return out;
};
