---
"@tspg/rest": patch
"@tspg/query": patch
---

fix: introspection reads constraints and view columns in a stable order

The `pg_constraint` query had no `ORDER BY`, unlike every other query introspection runs, so the
order of `foreignKeys` -- and of the `hints` on an ambiguous embed, which are built from it -- was
whatever the heap returned. A generated descriptor is committed by the app, so the same database
could regenerate a different file; `examples/query/with-transactions` flaked on exactly that. They
are now ordered by schema, table and constraint name.

The view-column query was ordered by `oid`, which is creation order: two databases built from the
same SQL in a different sequence disagreed on the order of the foreign keys views add, and on which
column of a view that exposes one table column twice a key is built from. It is now ordered by
schema, view and column position, so the same SQL gives the same schema whatever order it was run
in.
