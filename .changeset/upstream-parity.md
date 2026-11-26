---
"@tspg/rest": minor
"@tspg/query": minor
---

fix: answer PostgREST's own requests the way PostgREST does

Replaying the requests of PostgREST's own test suite on its own fixtures listed 251 places where `handle()`
answered differently. 249 are closed; the two left are the transport's (a CORS preflight, and the host the
OpenAPI document names), in `packages/rest/tests/compare/upstream/known.ts`. Most of the fixes are ports of the
corresponding PostgREST code (`findRel`, `findProc`, `addM2MRels`, `hoistSpreadAggFunctions`,
`addNullEmbedFilters`, `parseRaisePGRST`, `mapSQLtoHTTP`, `OpenAPI.hs`…).

Embedding:

- an embed's target may be a foreign key constraint or a column of one, its hint a constraint, a column on
  either side or a junction; a foreign key whose columns are a key is one-to-one from both ends; many-to-many
  needs two different constraints in the junction's key; a computed relationship named like a table replaces
  the one detected towards it;
- a view's columns are read from its own target list only (a subquery's no longer leaks in), and a view that
  exposes one column twice has a relationship through each;
- an ambiguous embed (PGRST201) lists its relationships as objects, as PostgREST does: `ErrorBody.details` can
  now be that list; PGRST200 suggests a close name;
- aggregates inside a to-one spread are applied in the parent, grouped by its columns; an order on a spread is by
  its column; `embed=is.null` works in logic trees and on spreads, and any other filter on an embed's name is a
  filter on the column (no PGRST120).

Reads and writes:

- `col->>key::type` casts the value; `col->>key::int.sum()` is understood;
- PostgREST's data representations (a domain's implicit casts to and from `json`/`text`) are applied;
- `PUT` takes an array payload; `columns=` is the whole of what a write reads and sets; `missing=default`
  reaches a domain's default and an identity column; a write returns only the columns its representation reads;
- `Range` and `limit=` intersect; `count=estimated` without `max-rows` is the larger count; `count=planned`
  estimates PostgREST's count query;
- `Location`, `PUT` and `Allow` use a view's key as PostgREST reads it; CSV reads `NULL` and refuses ragged lines;
  a resolution with no conflict target is ignored over HTTP (`upsert()` still refuses it).

Functions:

- overloads resolve as `findProc`; a function of a table row or a trigger function is not callable; a bare
  `record` is called in the select list; `char(n)`/`bit(n)` keep their length; `?id=5&id=gt.2` passes 5 and
  filters; a repeated parameter is the last value or a variadic list;
- a function returning a domain over a table's rows embeds; computed fields resolve on a function's rows.

Media types and errors:

- a handler is an aggregate returning a domain named like a media type, whatever its name, and its result is read
  in binary as PostgREST reads it; a `*/*` handler takes any media type; a `Content-Type` set in
  `response.headers` wins;
- `RAISE SQLSTATE 'PGRST'` and the SQLSTATE statuses follow PostgREST (21000 is a 500, an unknown role a 401, …);
- the OpenAPI document is PostgREST's: the relations the role can reach, the schema's comment as title, the same
  formats, notes and parameters.

`@tspg/query` shares the engine, so it reads JSON casts, defaults, data representations and function calls the
same way.
