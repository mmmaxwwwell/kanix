import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "./config.js";

// ---------------------------------------------------------------------------
// CORS middleware
// ---------------------------------------------------------------------------

export function registerCors(app: FastifyInstance, config: Config): void {
  const allowedOrigins = new Set(config.CORS_ALLOWED_ORIGINS);

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    const origin = request.headers.origin;

    if (request.method === "OPTIONS") {
      // Preflight request
      if (origin && allowedOrigins.has(origin)) {
        void reply
          .header("Access-Control-Allow-Origin", origin)
          .header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
          .header(
            "Access-Control-Allow-Headers",
            "Content-Type, Authorization, X-Correlation-Id, X-Cart-Token",
          )
          .header("Access-Control-Max-Age", "86400")
          .header("Vary", "Origin")
          .status(204)
          .send();
      } else {
        void reply.status(403).send({ error: "Origin not allowed" });
      }
      return;
    }

    // Non-preflight: set CORS headers if origin is allowed
    if (origin) {
      if (allowedOrigins.has(origin)) {
        void reply.header("Access-Control-Allow-Origin", origin).header("Vary", "Origin");
      } else {
        void reply.status(403).send({ error: "Origin not allowed" });
        return;
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Rate limiting middleware (in-memory, per-IP)
// ---------------------------------------------------------------------------

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

export interface RateLimiterState {
  clients: Map<string, RateLimitEntry>;
  cleanupTimer?: ReturnType<typeof setInterval>;
}

export function createRateLimiterState(): RateLimiterState {
  const state: RateLimiterState = {
    clients: new Map(),
  };

  // Periodically clean up expired entries to prevent memory leaks
  state.cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of state.clients) {
      if (now >= entry.resetTime) {
        state.clients.delete(key);
      }
    }
  }, 60_000);

  // Allow the timer to not keep the process alive
  if (state.cleanupTimer.unref) {
    state.cleanupTimer.unref();
  }

  return state;
}

export function clearRateLimiterState(state: RateLimiterState): void {
  if (state.cleanupTimer) {
    clearInterval(state.cleanupTimer);
  }
  state.clients.clear();
}

export function registerRateLimiting(
  app: FastifyInstance,
  config: Config,
  state: RateLimiterState,
): void {
  const { RATE_LIMIT_MAX: max, RATE_LIMIT_WINDOW_MS: windowMs } = config;

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    const ip = request.ip;
    const now = Date.now();

    let entry = state.clients.get(ip);

    if (!entry || now >= entry.resetTime) {
      entry = { count: 0, resetTime: now + windowMs };
      state.clients.set(ip, entry);
    }

    entry.count++;

    const remaining = Math.max(0, max - entry.count);
    const resetSeconds = Math.ceil((entry.resetTime - now) / 1000);

    void reply
      .header("X-RateLimit-Limit", String(max))
      .header("X-RateLimit-Remaining", String(remaining))
      .header("X-RateLimit-Reset", String(resetSeconds));

    if (entry.count > max) {
      void reply
        .header("Retry-After", String(resetSeconds))
        .status(429)
        .send({ error: "Rate limit exceeded" });
      return;
    }
  });
}

// ---------------------------------------------------------------------------
// Security headers middleware
// ---------------------------------------------------------------------------

export function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook("onSend", async (_request: FastifyRequest, reply: FastifyReply) => {
    void reply
      .header("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload")
      .header(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'",
      )
      .header("X-Content-Type-Options", "nosniff")
      .header("X-Frame-Options", "DENY")
      .header("Referrer-Policy", "strict-origin-when-cross-origin");
  });
}

// ---------------------------------------------------------------------------
// Convenience: register all security middleware
// ---------------------------------------------------------------------------

export interface SecurityState {
  rateLimiter: RateLimiterState;
}

export function registerSecurityMiddleware(app: FastifyInstance, config: Config): SecurityState {
  const rateLimiter = createRateLimiterState();

  registerCors(app, config);
  registerRateLimiting(app, config, rateLimiter);
  registerSecurityHeaders(app);

  return { rateLimiter };
}
