---
"@tspg/rest": patch
"@tspg/query": patch
---

fix: introspection reads constraints in a stable order

The `pg_constraint` query had no `ORDER BY`, unlike every other query introspection runs, so the
order of `foreignKeys` -- and of the `hints` on an ambiguous embed, which are built from it -- was
whatever the heap returned. A generated descriptor is committed by the app, so the same database
could regenerate a different file; `examples/query/with-transactions` flaked on exactly that. They
are now ordered by schema, table and constraint name.
