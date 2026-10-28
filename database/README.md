# Task database schema

`schema.sql` provides an optional SQLite schema based on the existing `Task` model in `src/tools/tasks.ts`. It does **not** switch the active JSON-backed `TaskStore` to SQLite or import `.task` files. No application database engine was specified in the task; SQLite provides a standalone, locally verifiable foundation without adding dependencies.

Apply to a new database using SQLite 3.37+ (STRICT table support):

```sh
sqlite3 /path/to/tasks.sqlite < database/schema.sql
```

The schema runs transactionally and can be reapplied without deleting existing data. This is an initial schema, not a migration mechanism for future schema changes. Enable `PRAGMA foreign_keys = ON` on every application connection before beginning transactions.

- `tasks`: `taskid` primary key, nonempty `description`, `status` (`wait`, `procing`, `compleate`), nullable nonempty `owner`. Status spellings match the existing API. Unowned non-wait tasks are allowed, as in the JSON store.
- `task_dependencies`: unique `(taskid, depends_on)` edges, foreign keys, no self-dependencies, and triggers rejecting indirect cycles on insert or update. Deleting a dependent removes its edges; deleting a referenced prerequisite is rejected.
- Indexes support status/owner filtering and reverse dependency lookups.

Insert all tasks in a batch before inserting dependency edges, inside one transaction. Future API/storage integration must claim tasks atomically only when status is `wait`, owner is null, and every prerequisite is `compleate`; completion should preserve owner. The schema enforces data integrity, not ownership authorization or lifecycle transitions.

Run schema verification with `npx vitest run tests/database-schema.test.ts`. Tests use Node's built-in experimental `node:sqlite` module; no SQLite npm package or external service is required.
