import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  FastifyRequest as STFastifyRequest,
  FastifyResponse as STFastifyResponse,
} from "supertokens-node/lib/build/framework/fastify/framework.js";
import Session from "supertokens-node/recipe/session/index.js";
import { insertAuthEvent } from "../db/queries/auth-event.js";

// ---------------------------------------------------------------------------
// Augment Fastify request to carry captured auth response bodies
// ---------------------------------------------------------------------------

declare module "fastify" {
  interface FastifyRequest {
    __authEventResponseBody?: unknown;
    __authEventSessionUserId?: string;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractIp(request: FastifyRequest): string {
  return (request.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ?? request.ip;
}

function extractUserAgent(request: FastifyRequest): string {
  return (request.headers["user-agent"] as string) ?? "";
}

function extractEmailFromFormFields(request: FastifyRequest): string | undefined {
  const body = request.body as { formFields?: Array<{ id: string; value: string }> } | undefined;
  return body?.formFields?.find((f) => f.id === "email")?.value;
}

// ---------------------------------------------------------------------------
// Auth event hook registration
// ---------------------------------------------------------------------------

/**
 * Registers hooks on auth routes that log auth events
 * (login, logout, signup, failed_login) to the auth_event_log table.
 *
 * Uses an onSend hook to capture the response body (before it's flushed),
 * then an onResponse hook to persist the event asynchronously.
 */
export function registerAuthEventLogger(app: FastifyInstance, db: PostgresJsDatabase): void {
  // Capture the session user ID before signout clears it.
  // We use onRequest (earliest hook) and Session.getSession directly because
  // the SuperTokens plugin handles /auth/signout and request.session is not
  // populated by our verifySession preHandler on that route.
  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (request.url.startsWith("/auth/signout") && request.method === "POST") {
      try {
        const wrappedReq = new STFastifyRequest(request as never);
        const wrappedRes = new STFastifyResponse(reply as never);
        const session = await Session.getSession(wrappedReq as never, wrappedRes as never, {
          overrideGlobalClaimValidators: () => [],
          sessionRequired: false,
        });
        if (session) {
          request.__authEventSessionUserId = session.getUserId();
        }
      } catch {
        // Session may already be invalid — that's fine, we just won't log a user ID
      }
    }
  });

  // Capture response body for auth routes so the onResponse hook can read it
  app.addHook(
    "onSend",
    async (request: FastifyRequest, _reply: FastifyReply, payload: unknown): Promise<unknown> => {
      if (!request.url.startsWith("/auth/")) return payload;
      if (request.method !== "POST") return payload;

      try {
        if (typeof payload === "string") {
          request.__authEventResponseBody = JSON.parse(payload);
        }
      } catch {
        // Not JSON — ignore
      }
      return payload;
    },
  );

  // Write the auth event log entry after the response is sent
  app.addHook("onResponse", async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const url = request.url;
    const method = request.method;

    if (!url.startsWith("/auth/") || method !== "POST") return;

    const ip = extractIp(request);
    const userAgent = extractUserAgent(request);

    try {
      const responseBody = request.__authEventResponseBody as
        | { status: string; user?: { id: string } }
        | undefined;

      // Signup
      if (url.startsWith("/auth/signup")) {
        if (reply.statusCode === 200 && responseBody?.status === "OK" && responseBody.user) {
          await insertAuthEvent(db, {
            eventType: "signup",
            actorId: responseBody.user.id,
            ipAddress: ip,
            userAgent,
            metadataJson: { email: extractEmailFromFormFields(request) },
          });
        }
        return;
      }

      // Sign-in
      if (url.startsWith("/auth/signin")) {
        if (reply.statusCode === 200) {
          if (responseBody?.status === "OK" && responseBody.user) {
            await insertAuthEvent(db, {
              eventType: "login",
              actorId: responseBody.user.id,
              ipAddress: ip,
              userAgent,
              metadataJson: { email: extractEmailFromFormFields(request) },
            });
          } else if (responseBody?.status === "WRONG_CREDENTIALS_ERROR") {
            await insertAuthEvent(db, {
              eventType: "failed_login",
              actorId: extractEmailFromFormFields(request) ?? "unknown",
              ipAddress: ip,
              userAgent,
              metadataJson: { reason: "wrong_credentials" },
            });
          }
        }
        return;
      }

      // Sign-out
      if (url.startsWith("/auth/signout")) {
        if (reply.statusCode === 200 && request.__authEventSessionUserId) {
          await insertAuthEvent(db, {
            eventType: "logout",
            actorId: request.__authEventSessionUserId,
            ipAddress: ip,
            userAgent,
          });
        }
        return;
      }
    } catch (err) {
      // Auth event logging failures should not break the request
      request.log?.error?.({ err }, "Failed to write auth event log entry");
    }
  });
}
