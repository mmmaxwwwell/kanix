import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DatabaseConnection {
  db: PostgresJsDatabase;
  sql: postgres.Sql;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Connection factory
// ---------------------------------------------------------------------------

export function createDatabaseConnection(databaseUrl: string): DatabaseConnection {
  const sql = postgres(databaseUrl);
  const db = drizzle(sql);

  return {
    db,
    sql,
    async close() {
      await sql.end();
    },
  };
}
