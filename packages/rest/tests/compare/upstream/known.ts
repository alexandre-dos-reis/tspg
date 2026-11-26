// Where this engine and PostgREST 16.5 answer differently on PostgREST's own requests (`upstream/cases.ts`,
// replayed on its own fixtures by `../upstream.test.ts`): 2 of the 1295 that run,
// each named by the cluster it belongs to.
//
// The test asserts that a case listed here still differs, so one that starts answering identically fails until it
// is removed: the list cannot go stale.
//
// Both are about the transport rather than the engine: what is left is the HTTP server's (a CORS preflight) and the
// request this harness sends (the OpenAPI document names the host it was reached at, and the two engines are reached
// at different ones).

/** What each cluster of differences comes from. */
export const CLUSTERS = {
  OPTIONS:
    "a CORS preflight (`Origin` and `Access-Control-Request-Method`) is answered by PostgREST's CORS middleware, without an `Allow` header; `handle()` has no CORS layer -- the host's, by design -- and answers the `OPTIONS` itself",
  "the OpenAPI document":
    "the document names the host it was requested at (`127.0.0.1:<port>` for PostgREST, `localhost` for `handle()` here), and documents the overload of a function PostgREST read last, which follows creation order",
} as const;

export type Cluster = keyof typeof CLUSTERS;

/** Every difference, by case name (`UpstreamCase.name`). */
export const KNOWN: Record<string, Cluster> = {
  // ── OPTIONS (1) ──
  "OPTIONS / +{\"Accept\":\"*/*\",\"Origin\":\"http://example.com\",\"Access-Control-Request-Method\":\"POST\",\"Access-Control-Request-Headers\":\"Foo,Bar\"}": "OPTIONS",

  // ── the OpenAPI document (1) ──
  "GET /": "the OpenAPI document",

};

/**
 * Requests whose answer the request itself does not determine -- an `order=` that leaves ties -- so either engine
 * may legitimately answer either way. Skipped, not compared.
 */
export const UNSTABLE: Record<string, string> = {
  "GET /projects_count_grouped_by?select=number_of_projects,client:clients(name)&order=number_of_projects": "the `order=` leaves ties, so which of two rows with the same `number_of_projects` comes first is up to the plan"
};
