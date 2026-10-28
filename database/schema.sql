-- Optional SQLite task schema; the current TaskStore remains file-backed.
-- Enable foreign_keys on EVERY connection, before starting transactions.
PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;

CREATE TABLE IF NOT EXISTS tasks (
  taskid TEXT PRIMARY KEY NOT NULL CHECK (length(trim(taskid)) > 0),
  description TEXT NOT NULL CHECK (length(trim(description)) > 0),
  -- Preserve the public task API's existing spellings.
  status TEXT NOT NULL DEFAULT 'wait'
    CHECK (status IN ('wait', 'procing', 'compleate')),
  owner TEXT CHECK (owner IS NULL OR length(trim(owner)) > 0)
) STRICT;

CREATE TABLE IF NOT EXISTS task_dependencies (
  taskid TEXT NOT NULL REFERENCES tasks(taskid) ON DELETE CASCADE,
  depends_on TEXT NOT NULL REFERENCES tasks(taskid) ON DELETE RESTRICT,
  PRIMARY KEY (taskid, depends_on),
  CHECK (taskid <> depends_on)
) STRICT;

CREATE INDEX IF NOT EXISTS tasks_status_owner_idx ON tasks(status, owner);
CREATE INDEX IF NOT EXISTS task_dependencies_depends_on_idx
  ON task_dependencies(depends_on);

CREATE TRIGGER IF NOT EXISTS task_dependencies_no_cycle_insert
BEFORE INSERT ON task_dependencies
BEGIN
  SELECT RAISE(ABORT, 'task dependency cycle')
  WHERE EXISTS (
    WITH RECURSIVE reachable(taskid) AS (
      SELECT NEW.depends_on
      UNION
      SELECT d.depends_on FROM task_dependencies AS d
      JOIN reachable AS r ON d.taskid = r.taskid
    )
    SELECT 1 FROM reachable WHERE taskid = NEW.taskid
  );
END;

CREATE TRIGGER IF NOT EXISTS task_dependencies_no_cycle_update
BEFORE UPDATE ON task_dependencies
BEGIN
  SELECT RAISE(ABORT, 'task dependency cycle')
  WHERE EXISTS (
    WITH RECURSIVE reachable(taskid) AS (
      SELECT NEW.depends_on
      UNION
      SELECT d.depends_on FROM task_dependencies AS d
      JOIN reachable AS r ON d.taskid = r.taskid
      WHERE NOT (d.taskid = OLD.taskid AND d.depends_on = OLD.depends_on)
    )
    SELECT 1 FROM reachable WHERE taskid = NEW.taskid
  );
END;

COMMIT;
