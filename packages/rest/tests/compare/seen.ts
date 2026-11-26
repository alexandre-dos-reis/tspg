// What "the same response" means for the differential suites: the status, the headers a PostgREST
// client reads, and the body. Shared by `compare.test.ts` (this repository's fixture) and
// `upstream.test.ts` (PostgREST's own), so the two cannot drift into comparing different things.

export interface Seen {
  status: number;
  contentType: string | null;
  contentRange: string | null;
  location: string | null;
  preferenceApplied: string | null;
  allow: string | null;
  wwwAuthenticate: string | null;
  body: unknown;
}

/** Drop values that legitimately differ between two runs (now()-based timestamps). */
export const scrub = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([k]) => k !== "created_at")
        .map(([k, x]) => [k, scrub(x)]),
    );
  }
  if (typeof v === "string") return v.replace(/\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d+)?[+-]\d\d/g, "<timestamp>");
  return v;
};

/** A comma-separated header whose order carries no meaning (`Preference-Applied`). */
export const tokens = (v: string | null) =>
  v === null
    ? null
    : v
        .split(",")
        .map((t) => t.trim())
        .sort()
        .join(", ");

export interface SeenOptions {
  /** Compare the status and the headers only. */
  readonly ignoreBody?: boolean;
}

export const normalize = async (res: Response, options: SeenOptions = {}): Promise<Seen> => {
  // `fetch` decodes a body without its byte order mark, and a `Response` built from a string keeps it:
  // the bytes on the wire are the same, so neither side's is compared
  const text = (await res.text()).replace(/^\uFEFF/, "");
  const ct = res.headers.get("content-type");
  let body: unknown = text;
  if (options.ignoreBody) body = "(ignored)";
  else if (ct?.includes("json")) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return {
    status: res.status,
    contentType: ct
      ? ct
          .replace(/;\s*charset=utf-8/i, "")
          .replace(/\s+/g, "")
          .toLowerCase()
      : null,
    contentRange: res.headers.get("content-range"),
    location: res.headers.get("location"),
    preferenceApplied: tokens(res.headers.get("preference-applied")),
    allow: res.headers.get("allow"),
    wwwAuthenticate: res.headers.get("www-authenticate"),
    body: scrub(body),
  };
};
