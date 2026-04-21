import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { plugin as supertokensPlugin } from "supertokens-node/framework/fastify/index.js";
import {
  FastifyRequest as STFastifyRequest,
  FastifyResponse as STFastifyResponse,
} from "supertokens-node/lib/build/framework/fastify/framework.js";
import Session from "supertokens-node/recipe/session/index.js";
import type { SessionContainer } from "supertokens-node/recipe/session/index.js";
import { isEmailVerified } from "./supertokens.js";

// ---------------------------------------------------------------------------
// Fastify plugin: SuperTokens middleware
// ---------------------------------------------------------------------------

/**
 * Registers the SuperTokens middleware on a Fastify instance.
 * This handles all /auth/* routes (signup, signin, signout, email verification, etc.).
 */
export async function registerAuthMiddleware(app: FastifyInstance): Promise<void> {
  await app.register(supertokensPlugin);
}

// ---------------------------------------------------------------------------
// Augment Fastify request with session
// ---------------------------------------------------------------------------

declare module "fastify" {
  interface FastifyRequest {
    session?: SessionContainer;
  }
}

// ---------------------------------------------------------------------------
// Session verification hook
// ---------------------------------------------------------------------------

/**
 * Fastify preHandler that verifies a SuperTokens session.
 * Attaches the session to `request.session`.
 * Returns 401 if no valid session.
 *
 * Uses SuperTokens' FastifyRequest/FastifyResponse wrappers for proper
 * cookie and header access, while preserving our custom error format.
 */
export async function verifySession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const wrappedReq = new STFastifyRequest(request as never);
    const wrappedRes = new STFastifyResponse(reply as never);
    const session = await Session.getSession(wrappedReq as never, wrappedRes as never, {
      overrideGlobalClaimValidators: () => [],
    });
    request.session = session;
  } catch {
    return reply.status(401).send({
      error: "ERR_AUTHENTICATION_FAILED",
      message: "Authentication required",
    });
  }
}

// ---------------------------------------------------------------------------
// Email verification guard
// ---------------------------------------------------------------------------

/**
 * Fastify preHandler that checks the current user has a verified email.
 * Must be used AFTER `verifySession`.
 * Returns 403 if email is not verified.
 */
export async function requireVerifiedEmail(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!request.session) {
    return reply.status(401).send({
      error: "ERR_AUTHENTICATION_FAILED",
      message: "Authentication required",
    });
  }

  const userId = request.session.getUserId();
  const verified = await isEmailVerified(userId);

  if (!verified) {
    return reply.status(403).send({
      error: "ERR_EMAIL_NOT_VERIFIED",
      message: "Email verification required to access this resource",
    });
  }
}
