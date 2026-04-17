import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type pino from "pino";
import { releaseExpiredReservations } from "../db/queries/reservation.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReservationCleanupOptions {
  db: PostgresJsDatabase;
  logger: pino.Logger;
  /** Cleanup interval in milliseconds (default: 60 000 — 1 minute). */
  intervalMs?: number;
}

export interface ReservationCleanupHandle {
  /** Stop the periodic cleanup. Safe to call multiple times. */
  stop(): void;
}

// ---------------------------------------------------------------------------
// Default interval — 1 minute
// ---------------------------------------------------------------------------

const DEFAULT_INTERVAL_MS = 60_000;

// ---------------------------------------------------------------------------
// Start / stop
// ---------------------------------------------------------------------------

export function startReservationCleanup(
  options: ReservationCleanupOptions,
): ReservationCleanupHandle {
  const { db, logger, intervalMs = DEFAULT_INTERVAL_MS } = options;

  let timer: ReturnType<typeof setInterval> | null = null;

  async function tick(): Promise<void> {
    try {
      const count = await releaseExpiredReservations(db);
      if (count > 0) {
        logger.info(`Released ${count} expired reservations`);
      }
    } catch (err) {
      logger.error({ err }, "Reservation cleanup failed");
    }
  }

  timer = setInterval(() => void tick(), intervalMs);
  // Allow the Node process to exit even if the timer is still active
  timer.unref();

  logger.info(`Reservation cleanup cron started (interval: ${intervalMs}ms)`);

  return {
    stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
        logger.info("Reservation cleanup cron stopped");
      }
    },
  };
}
