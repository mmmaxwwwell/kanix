import type pino from "pino";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A shutdown hook — a named async cleanup function. */
export interface ShutdownHook {
  name: string;
  fn: () => Promise<void>;
}

/** Options for creating a shutdown manager. */
export interface ShutdownManagerOptions {
  logger: pino.Logger;
  timeoutMs?: number;
  exitFn?: (code: number) => void;
  processRef?: NodeJS.Process;
}

// ---------------------------------------------------------------------------
// Readiness state — used by /ready endpoint
// ---------------------------------------------------------------------------

let shutdownInitiated = false;

export function isShuttingDown(): boolean {
  return shutdownInitiated;
}

// ---------------------------------------------------------------------------
// Shutdown Manager
// ---------------------------------------------------------------------------

export interface ShutdownManager {
  register(hook: ShutdownHook): void;
  shutdown(): Promise<void>;
}

export function createShutdownManager(options: ShutdownManagerOptions): ShutdownManager {
  const {
    logger,
    timeoutMs = 30_000,
    exitFn = process.exit.bind(process),
    processRef = process,
  } = options;

  const hooks: ShutdownHook[] = [];
  let running = false;

  function register(hook: ShutdownHook): void {
    hooks.push(hook);
  }

  async function shutdown(): Promise<void> {
    if (running) return;
    running = true;
    shutdownInitiated = true;

    logger.info("Shutdown initiated");

    // Set a hard timeout — force exit 1 if shutdown takes too long
    const timer = setTimeout(() => {
      logger.fatal(`Shutdown timed out after ${timeoutMs}ms, forcing exit`);
      exitFn(1);
    }, timeoutMs);
    // Allow the process to exit even if the timer is still active
    if (typeof timer === "object" && "unref" in timer) {
      timer.unref();
    }

    // Execute hooks in reverse registration order
    const reversed = [...hooks].reverse();
    for (const hook of reversed) {
      try {
        logger.info(`Shutdown hook: ${hook.name}`);
        await hook.fn();
      } catch (err) {
        logger.error({ err, hook: hook.name }, `Shutdown hook failed: ${hook.name}`);
      }
    }

    logger.info("Shutdown complete");
    exitFn(0);
  }

  // Register signal handlers
  const onSignal = () => {
    void shutdown();
  };
  processRef.on("SIGTERM", onSignal);
  processRef.on("SIGINT", onSignal);

  return { register, shutdown };
}
