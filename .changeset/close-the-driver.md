---
"@tspg/rest": minor
"@tspg/query": minor
---

feat: `close()` closes the database driver, a new `onClose` option takes that over, and the `db`
option is now `adapter`

**Breaking**: the adapter is passed as `adapter`, not `db` -- it is a `DbAdapter`, which is also
what `onClose` is handed and what the docs call it:

```ts
const api = await createRest({ adapter: nodePostgresAdapter(pool), schemas: ["api"] });
```

`rest.close()` and `db.close()` now call the adapter's own `close()` — `pool.end()`, `sql.end()`,
`pglite.close()`; nothing for an adapter that has none — so the driver created for an instance no
longer has to be ended beside it. Closing twice closes once, and a driver something else has already
closed is not an error.

**Breaking** for a driver that must outlive the instance, or is shared: pass `onClose`, which is
handed the adapter and decides the whole of what closing does.

```ts
const adapter = nodePostgresAdapter(pool);
const api = await createRest({ adapter, onClose: () => {} }); // leaves the pool alone
const query = createQuery({ adapter });                       // this one ends it
```
