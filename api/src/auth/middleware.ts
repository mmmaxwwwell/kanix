import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import supertokens from "supertokens-node";
import { plugin as supertokensPlugin } from "supertokens-node/framework/fastify/index.js";
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
 */
export async function verifySession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const session = await Session.getSession(request as never, reply as never);
    request.session = session;
  } catch (err) {
    if (supertokens.Error.isErrorFromSuperTokens(err as Error)) {
      return reply.status(401).send({
        error: "ERR_AUTHENTICATION_FAILED",
        message: "Authentication required",
      });
    }
    throw err;
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
