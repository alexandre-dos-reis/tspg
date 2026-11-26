---
"@tspg/rest": minor
"@tspg/query": minor
---

fix: an upsert counts the rows it inserted instead of reading `xmax`, so views work

A `Prefer: resolution=merge-duplicates` upsert used to return `(relation.xmax = 0)` alongside the
rows, to tell an inserted tuple from an updated one and answer `200` rather than `201` when nothing
was inserted. `xmax` is a **table** system column: through a view -- the usual PostgREST arrangement,
an exposed view over a table in a schema that is not exposed -- every upsert failed with
`42703 column <name>.xmax does not exist`. Partitioned and foreign tables have no usable `xmax`
either, and the marker was not optional: no combination of preferences could turn it off.

The rows really inserted are now counted the way PostgREST counts them: a predicate that is always
true, on the `WHERE` of the insert's source and on the `WHERE` of `DO UPDATE`, moving a
transaction-local `set_config('pgrst.inserted', …)` up once per candidate row and down once per row
that turned out to exist. No system column is read, so an upsert works on any relation that can be
inserted into.

Two statuses move with it, both towards PostgREST (pinned by the differential suite):

- a `merge-duplicates` upsert whose payload has nothing to insert -- `[]` -- answers `200`, where it
  used to answer `201`;
- a `PUT` that **inserts** its row answers `201` with `Prefer: return=representation`, where it used
  to answer `200`. Replacing an existing row still answers `200`, and without a representation it is
  `204` either way.
