// Where this engine and PostgREST 16.5 answer differently on PostgREST's own requests (`upstream/cases.ts`,
// replayed on its own fixtures by `../upstream.test.ts`): 51 of the 1295 that run,
// each named by the cluster it belongs to.
//
// The test asserts that a case listed here still differs, so one that starts answering identically fails until it
// is removed: the list cannot go stale.
//
// The gap is almost entirely one-sided -- 126 requests PostgREST answers and this engine refuses, against **4** it
// refuses and this engine answers, which is the direction that matters for `packages/rest/PARITY.md`'s hardening
// claims. Those four, each worth its own look:
//
//   GET / with `Accept: text/csv`                    PostgREST 406; the OpenAPI document is served here
//   PATCH /articles?columns=helicopter               PostgREST PGRST204 on the unknown column; the update runs here
//   POST /no_pk with a ragged CSV payload            PostgREST PGRST102; the rows are inserted here
//   POST /rpc/overloaded_unnamed_param with CSV      PostgREST PGRST202; an overload is chosen here

/** What each cluster of differences comes from. */
export const CLUSTERS = {
  "data representations":
    "the cast functions of a domain (PostgREST's \"data representations\") are not applied: a value is sent to PostgreSQL as it comes, so a representation like `#001100` for an integer-backed domain is refused, and one read back is not rendered",
  "a media type handled in the database":
    "a media type whose handler is a function in the database (`pg/outfunc`, `application/vnd.twkb`, `magic/number`, `application/vnd.pgrst.array;nulls=stripped`, a cast to `text/xml`...) is not served here: only the built-in media types and the ones `media` registers are, so such a request is refused with PGRST107 or answered as JSON",
  "PUT with a single-element array payload":
    "PostgREST takes both an object and a one-element array as a PUT payload, and reads the request before the payload; this engine requires an object, so it answers PGRST102 where PostgREST answers, or where PostgREST reports what is wrong with the request instead (PGRST105, PGRST114, PGRST115)",
  "an embed by a name that is not a table":
    "embedding by a foreign-key constraint name, or by a column name, is not resolved here: PostgREST accepts `select=...,<fk name>(...)` and `select=...,<column>(...)` as embed targets, and resolves an embed through a view to the view's base relation",
  "an ambiguous embed":
    "an embed PostgREST resolves is reported as ambiguous here (PGRST201), and where both report it the details differ in shape: PostgREST lists objects (cardinality, embedding, relationship), this engine strings",
  "a cast after a json arrow":
    "`->>key::type` casts the key rather than the value, `->` followed by a cast is refused, and on a json array index the cast is dropped altogether, so the value comes back as text",
  "columns= and the payload":
    "`columns=` is not the whole of what is written here: a key of the payload outside it is reported (PGRST204) instead of ignored, and an empty or unknown `columns=` is read differently",
  "an aggregate in a spread embed":
    "an aggregate inside a spread embed is not grouped by the parent's columns, so the rows come back ungrouped, and an alias given inside a spread embed is not visible to `order=`",
  "a filter on an embed selected with no columns":
    "an embed selected with no columns (`clientinfo()`) is not usable as a filter target or inside a logic tree here, and the total of a request filtered that way differs",
  "an overloaded function":
    "which overload a call resolves to differs: a set of parameters PostgREST matches is refused here (or the reverse), and an overloaded computed relationship is not resolved",
  "the wording of an error":
    "the same failure, with the same code and the same status, but with the message, details or hint split or worded differently",
  "a filter or an order on a spread embed":
    "`...embed` combined with a filter or an order on the embed itself (`processes=is.null`, `processes.order=name`) builds SQL that does not compile",
  "a repeated query parameter":
    "a parameter given twice (`?name=ignored&name=world`, `v=hi&v=there`) is collected into an array here; PostgREST takes the last one, except for a variadic parameter, whose repetitions are its elements",
  "OPTIONS":
    "the `Allow` header of a view or an RPC differs: what PostgREST derives from triggers and auto-updatability",
  "a function returning record":
    "a function returning `record` (or `setof record`) needs a column definition list, which is not generated here",
  "a table without a usable primary key":
    "a table with no primary key, or one whose primary key is null in the inserted row, gives another `Location` header, and an upsert on it asks for an explicit `on_conflict` here",
  "an argument of a character type":
    "an RPC argument of `char(n)` or `bit(n)` is read as `character(1)`/`bit(1)`: the length in the function's signature is not taken into account",
  "a filter whose target is an embedded resource":
    "a filter on a column that is also an embed target (`select=...,client:client_id(name)&client_id=eq.2`, `status=eq.3`) is refused here (PGRST120) where PostgREST applies it to the parent column",
  "fts() on a domain over tsvector":
    "`fts()` on a column whose type is a domain over tsvector asks for a `to_tsvector` that does not exist",
  "the RAISE conventions":
    "a RAISE whose MESSAGE or DETAIL is not the JSON the convention asks for is reported differently: PostgREST explains what the JSON must hold (PGRST121), this engine reports the error it managed to read",
  "the query string of an RPC":
    "which parameters of an RPC's query string are arguments and which are filters on its result differs (`?id=5&id=gt.2` is both upstream), a function returning a domain over a composite is not embedded through, and on a POST the query string holds no arguments at all",
  "privileges through a view":
    "a write through a view, or a delete whose `select=` reads columns the role cannot read, is refused here where PostgREST runs it: it is not the view owner's privileges that are checked",
  "the status of an error":
    "the same failure, with the same code, mapped to another status",
  "CSV":
    "CSV differs: a null is written `NULL` rather than left empty, a geometry is rendered differently, and a CSV payload whose lines do not all have the same number of fields is accepted",
  "a Range header beside limit=":
    "a `Range` header does not override a `limit=` in the query string here; PostgREST lets the header win",
  "a backslash in an in-list value":
    "a backslash inside a quoted `in.(...)` value is kept here; PostgREST drops it",
  "the Location header of a composite primary key":
    "`Location` names only the first column of a composite primary key; PostgREST names all of them",
  "the OpenAPI document":
    "the OpenAPI document differs: PostgREST takes its title and description from the schema's comment and its version from its own, and answers 406 at the root for an Accept it cannot serve",
  "the total of a filtered request":
    "the total reported in `Content-Range`, and with it the status (200 or 206), differs",
  "whitespace in a logic tree":
    "the spaces PostgREST tolerates inside `and=(...)` / `or=(...)` are read as part of a column name here",
} as const;

export type Cluster = keyof typeof CLUSTERS;

/** Every difference, by case name (`UpstreamCase.name`). */
export const KNOWN: Record<string, Cluster> = {
  // ── a media type handled in the database (30) ──
  "GET /items?id=in.(1,2)&select=id,always_true +{\"Accept\":\"pg/outfunc\"}": "a media type handled in the database",
  "GET /lines +{\"Accept\":\"application/vnd.geo2+json\"}": "a media type handled in the database",
  "GET /lines +{\"Accept\":\"application/vnd.twkb\"}": "a media type handled in the database",
  "GET /lines +{\"Accept\":\"text/csv\"}": "a media type handled in the database",
  "GET /lines?id=eq.1 +{\"Accept\":\"application/geo+json\"}": "a media type handled in the database",
  "GET /lines?id=eq.1 +{\"Accept\":\"application/vnd.twkb\"}": "a media type handled in the database",
  "GET /organizations?select=* +{\"Accept\":\"application/vnd.pgrst.array;nulls=stripped\"}": "a media type handled in the database",
  "GET /ov_json +{\"Accept\":\"application/json\"}": "a media type handled in the database",
  "GET /projects?id=in.(1,2) +{\"Accept\":\"pg/outfunc\"}": "a media type handled in the database",
  "GET /projects?id=in.(1,2) +{\"Accept\":\"text/tab-separated-values\"}": "a media type handled in the database",
  "GET /projects?id=in.(1,2)&select=*,clients(id) +{\"Accept\":\"pg/outfunc\"}": "a media type handled in the database",
  "GET /projects?id=in.(1,2)&select=id,name +{\"Accept\":\"pg/outfunc\"}": "a media type handled in the database",
  "GET /projects?id=in.(1,2)&select=name,id,client_id +{\"Accept\":\"pg/outfunc\"}": "a media type handled in the database",
  "GET /rpc/get_line?id=777 +{\"Accept\":\"application/vnd.twkb\"}": "a media type handled in the database",
  "GET /rpc/get_lines +{\"Accept\":\"application/vnd.geo2+json\"}": "a media type handled in the database",
  "GET /rpc/get_lines +{\"Accept\":\"application/vnd.twkb\"}": "a media type handled in the database",
  "GET /rpc/get_shop_bles +{\"Accept\":\"application/vnd.geo2+json\"}": "a media type handled in the database",
  "GET /rpc/ret_any_mt +{\"Accept\":\"app/bingo\"}": "a media type handled in the database",
  "GET /rpc/ret_any_mt +{\"Accept\":\"image/boingo\"}": "a media type handled in the database",
  "GET /rpc/ret_any_mt +{\"Accept\":\"text/bango\"}": "a media type handled in the database",
  "GET /rpc/ret_some_mt +{\"Accept\":\"*/*\"}": "a media type handled in the database",
  "GET /rpc/ret_some_mt +{\"Accept\":\"app/chico\"}": "a media type handled in the database",
  "GET /rpc/ret_some_mt +{\"Accept\":\"app/harpo\"}": "a media type handled in the database",
  "GET /rpc/welcome.xml +{\"Accept\":\"text/xml\"}": "a media type handled in the database",
  "GET /shop_bles +{\"Accept\":\"application/vnd.geo2+json\"}": "a media type handled in the database",
  "GET /some_numbers?val=eq.1 +{\"Accept\":\"*/*\"}": "a media type handled in the database",
  "GET /some_numbers?val=eq.2 +{\"Accept\":\"magic/number\"}": "a media type handled in the database",
  "GET /some_numbers?val=eq.3 +{\"Accept\":\"crazy/bingo\"}": "a media type handled in the database",
  "GET /some_numbers?val=eq.4 +{\"Accept\":\"unknown/unknown\"}": "a media type handled in the database",
  "GET /xmltest +{\"Accept\":\"text/xml\"}": "a media type handled in the database",

  // ── an embed by a name that is not a table (4) ──
  "GET /i2459_self_v1?select=*,parent(*),grandparent(*)": "an embed by a name that is not a table",
  "GET /i2459_self_v2?select=*,parent(*),grandparent(*)": "an embed by a name that is not a table",
  "GET /i2459_simple_v1?select=*,i2459_simple_v2!t1_id2(*)": "an embed by a name that is not a table",
  "GET /i2459_simple_v2?select=*,i2459_simple_v1!t1_id2(*)": "an embed by a name that is not a table",

  // ── an ambiguous embed (1) ──
  "GET /i2459_composite_v2?select=*,i2459_composite_v1(*)": "an ambiguous embed",

  // ── a filter on an embed selected with no columns (4) ──
  "GET /client?select=*,clientinfo(),contact()&clientinfo.other=ilike.*main*&contact.name=ilike.*tabby*&or=(clientinfo.not.is.null,contact.not.is.null) +{\"Prefer\":\"count=estimated\"}": "a filter on an embed selected with no columns",
  "GET /client?select=*,clientinfo(),contact()&clientinfo.other=ilike.*main*&contact.name=ilike.*tabby*&or=(clientinfo.not.is.null,contact.not.is.null) +{\"Prefer\":\"count=planned\"}": "a filter on an embed selected with no columns",
  "GET /projects?select=name,clients()&clients=is.null +{\"Prefer\":\"count=estimated\"}": "a filter on an embed selected with no columns",
  "GET /projects?select=name,clients()&clients=is.null +{\"Prefer\":\"count=planned\"}": "a filter on an embed selected with no columns",

  // ── the wording of an error (2) ──
  "GET /clients?select=id,projects(id,tasks(id,name))&projects.tasks2.name=like.Design*": "the wording of an error",
  "POST /rpc/delete_items_returns_void +{\"Prefer\":\"handling=strict, max-affected=20, tx=rollback\"} <>": "the wording of an error",

  // ── OPTIONS (4) ──
  "OPTIONS / +{\"Accept\":\"*/*\",\"Origin\":\"http://example.com\",\"Access-Control-Request-Method\":\"POST\",\"Access-Control-Request-Headers\":\"Foo,Bar\"}": "OPTIONS",
  "OPTIONS /projects_auto_updatable_view_without_pk": "OPTIONS",
  "OPTIONS /projects_view_with_all_triggers_without_pk": "OPTIONS",
  "OPTIONS /rpc/reset_table": "OPTIONS",

  // ── fts() on a domain over tsvector (3) ──
  "GET /rpc/get_tsearch_to_tsvector?select=text_search_domain&text_search_domain=fts(simple).impossible": "fts() on a domain over tsvector",
  "GET /rpc/get_tsearch_to_tsvector?select=text_search_rec_domain&text_search_rec_domain=fts(simple).impossible": "fts() on a domain over tsvector",
  "GET /tsearch_to_tsvector?select=text_search_vector&text_search_vector=fts(simple).of": "fts() on a domain over tsvector",

  // ── privileges through a view (2) ──
  "DELETE /app_users?id=eq.1&select=id,email +{\"Prefer\":\"return=representation, tx=rollback\"} <{ \"password\": \"passxyz\" }>": "privileges through a view",
  "POST /limited_article_stars?select=article_id,user_id +{\"Prefer\":\"return=representation, tx=rollback\"} <{\"article_id\": 2, \"user_id\": 1}>": "privileges through a view",

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
