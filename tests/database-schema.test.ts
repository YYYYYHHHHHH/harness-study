import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const schema = readFileSync(new URL('../database/schema.sql', import.meta.url), 'utf8');
let db: DatabaseSync;
const task = (id: string) => db.prepare('INSERT INTO tasks(taskid, description) VALUES (?, ?)').run(id, `Task ${id}`);
const edge = (id: string, dependency: string) => db.prepare('INSERT INTO task_dependencies VALUES (?, ?)').run(id, dependency);

beforeEach(() => { db = new DatabaseSync(':memory:'); db.exec(schema); });
afterEach(() => db.close());

describe('SQLite task schema', () => {
  it('initializes repeatedly without losing data and preserves API fields', () => {
    task('a');
    db.exec(schema);
    expect(db.prepare('SELECT * FROM tasks').get()).toEqual({ taskid: 'a', description: 'Task a', status: 'wait', owner: null });
    for (const status of ['procing', 'compleate']) {
      db.prepare('UPDATE tasks SET status = ?, owner = ?').run(status, 'agent-1');
      expect(db.prepare('SELECT status, owner FROM tasks').get()).toEqual({ status, owner: 'agent-1' });
    }
  });

  it('rejects duplicate IDs, blank fields, invalid statuses and owners', () => {
    task('a');
    expect(() => task('a')).toThrow();
    expect(() => task(' ')).toThrow();
    expect(() => db.exec("INSERT INTO tasks(taskid, description) VALUES ('b', ' ')")).toThrow();
    expect(() => db.exec("UPDATE tasks SET status = 'done'")).toThrow();
    expect(() => db.exec("UPDATE tasks SET owner = ' '")).toThrow();
    expect(() => db.exec('UPDATE tasks SET description = NULL')).toThrow();
  });

  it('enforces dependency uniqueness, foreign keys and self-dependency checks', () => {
    task('a'); task('b'); edge('b', 'a');
    expect(() => edge('b', 'a')).toThrow();
    expect(() => edge('a', 'a')).toThrow();
    expect(() => edge('a', 'missing')).toThrow();
    expect(() => edge('missing', 'a')).toThrow();
    expect(() => db.exec("DELETE FROM tasks WHERE taskid = 'a'")).toThrow();
    db.exec("DELETE FROM tasks WHERE taskid = 'b'");
    expect(db.prepare('SELECT * FROM task_dependencies').all()).toEqual([]);
  });

  it('rejects indirect cycles on inserts and updates without altering edges', () => {
    for (const id of ['a', 'b', 'c', 'd']) task(id);
    edge('a', 'b'); edge('b', 'c'); edge('d', 'a');
    expect(() => edge('c', 'a')).toThrow('task dependency cycle');
    expect(() => db.exec("UPDATE task_dependencies SET taskid = 'c' WHERE taskid = 'd'")).toThrow('task dependency cycle');
    db.exec("UPDATE task_dependencies SET depends_on = 'c' WHERE taskid = 'd'");
    expect(db.prepare("SELECT depends_on FROM task_dependencies WHERE taskid = 'd'").get()).toEqual({ depends_on: 'c' });
  });

  it('supports atomic batch creation with forward references and rollback', () => {
    db.exec('BEGIN');
    task('dependent'); task('prerequisite'); edge('dependent', 'prerequisite');
    db.exec('COMMIT');
    db.exec('BEGIN');
    task('temporary');
    expect(() => edge('temporary', 'missing')).toThrow();
    db.exec('ROLLBACK');
    expect(db.prepare('SELECT taskid FROM tasks ORDER BY taskid').all()).toEqual([
      { taskid: 'dependent' }, { taskid: 'prerequisite' },
    ]);
  });
});
