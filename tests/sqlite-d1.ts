import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

const MIGRATIONS = resolve(import.meta.dirname, "../migrations");

/** What D1 accepts as a bound value; booleans become 1 or 0, as D1 stores them. */
type D1Value = string | number | boolean | null | ArrayBuffer | Uint8Array;

function toSqlite(v: unknown, i: number): SQLInputValue {
  if (v === undefined) throw new Error(`D1_TYPE_ERROR: Type 'undefined' not supported for value at position ${i + 1}`);
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return v as SQLInputValue;
}

/**
 * A D1-shaped test double over Node's built-in SQLite, with every file in migrations/ applied in
 * order. It covers `prepare(sql).bind(...).first()/run()/all()`, as the Worker uses them; anything
 * else throws. Calls run one at a time, as D1's do. `sqlite` is the database itself, for checks.
 */
export function sqliteD1(): D1Database & { sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  }
  const meta = (changes: number) => ({ changes, duration: 0, last_row_id: 0, changed_db: changes > 0 });

  function statement(sql: string, values: SQLInputValue[] = []) {
    const run = () => sqlite.prepare(sql);
    return {
      bind: (...next: D1Value[]) => statement(sql, next.map(toSqlite)),
      async first<T>(column?: string): Promise<T | null> {
        const row = run().get(...values) as Record<string, unknown> | undefined;
        if (!row) return null;
        return (column === undefined ? { ...row } : row[column]) as T;
      },
      async run() {
        const { changes } = run().run(...values);
        return { success: true, results: [], meta: meta(Number(changes)) };
      },
      async all<T>() {
        const rows = run().all(...values).map((r) => ({ ...r }) as T);
        return { success: true, results: rows, meta: meta(0) };
      },
    };
  }

  const unsupported = () => {
    throw new Error("not supported by the sqlite D1 test double");
  };
  return {
    sqlite,
    prepare: (sql: string) => statement(sql),
    batch: unsupported,
    exec: unsupported,
    dump: unsupported,
    withSession: unsupported,
  } as unknown as D1Database & { sqlite: DatabaseSync };
}
