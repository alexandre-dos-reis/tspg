---
"@tspg/rest": minor
"@tspg/query": minor
---

fix: answer PostgREST's own requests the way PostgREST does

Replaying the requests of PostgREST's own test suite on its own fixtures (#62) listed 251 places
where `handle()` answered differently. This closes most of them; what remains is in
`packages/rest/tests/compare/upstream/known.ts`, by cluster.

Writes:

- a `PUT` takes an array of objects as well as an object, and writes the element the URL's key
  selects; the request is checked before the payload (PGRST105, PGRST114 first);
- `columns=` is the whole of what a write sets: a PATCH ignores the other keys of the payload and
  refuses an unknown column of `columns=`, `missing=default` reaches the listed columns the payload
  lacks, a function is passed only the arguments it names, and an empty `columns=` is PGRST100;
- `missing=default` writes a domain's default and an identity column's next value;
- a resolution with no conflict target is ignored, and not reported as applied (`@tspg/rest` only:
  `upsert()` in `@tspg/query` still refuses it);
- `Location` names every column of a view's key as PostgREST reads it, and a null one as `is.null`;
- a CSV payload reads `NULL` as a null and refuses lines of unequal length.

Reads:

- `col->>key::type` casts the value, not the key, and an aggregate takes a cast of its column
  (`col->>key::int.sum()`);
- `Range` and `limit=`/`offset=` page by their intersection; `count=estimated` with no `max-rows`
  is the larger of the exact and the planned count;
- a backslash inside quotes escapes any character, and `and (...)` may have spaces;
- the root serves its OpenAPI document only: any other `Accept` is 406.

Functions:

- overloads are resolved as PostgREST's `findProc` resolves them, a function taking a table row is
  not callable, a bare `record` is called in the select list, and `char`/`bit` arguments keep their
  length;
- on a GET, `?id=5&id=gt.2` passes 5 and filters on `id > 2`; a repeated parameter is the last
  value, or a variadic parameter's list; the query string is read before the payload;
- a function returning a domain over a table's row type embeds from that table's rows, and a
  computed field or relationship resolves on the rows a function returns;
- the "Perhaps you meant" hint is PostgREST's fuzzy match.

`@tspg/query` shares the engine, so it reads JSON casts, defaults and function calls the same way.
