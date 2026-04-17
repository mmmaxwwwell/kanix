import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

/**
 * Simple connectivity check — executes `SELECT 1` against the database.
 * Returns true if the query succeeds, false otherwise.
 */
export async function checkDatabaseConnectivity(db: PostgresJsDatabase): Promise<boolean> {
  try {
    await db.execute(sql`SELECT 1`);
    return true;
  } catch {
    return false;
  }
}
