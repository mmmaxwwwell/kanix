import type { FastifyInstance, FastifyRequest } from "fastify";
import websocket from "@fastify/websocket";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { adminUser } from "../db/schema/admin.js";
import { customer } from "../db/schema/customer.js";
import { cart } from "../db/schema/cart.js";
import Session from "supertokens-node/recipe/session/index.js";
import type { WebSocket } from "ws";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WsMessage {
  type: string;
  entity: string;
  entityId: string;
  data: Record<string, unknown>;
  sequenceId: number;
}

export type ConnectionRole = "admin" | "customer" | "guest";

export interface WsConnection {
  id: string;
  role: ConnectionRole;
  /** admin user ID, customer ID, or cart token */
  subjectId: string;
  socket: WebSocket;
  /** Entity channels this connection subscribes to, e.g. ["order:*", "cart:abc123"] */
  channels: Set<string>;
  lastSequenceId: number;
}

export interface WsManager {
  /** All active connections (exposed for testing). */
  connections: Map<string, WsConnection>;
  /** Publish a message to all subscribers of the given entity channel. */
  publish(entity: string, entityId: string, type: string, data: Record<string, unknown>): void;
  /** Global monotonic sequence counter (exposed for testing). */
  getSequence(): number;
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

async function authenticateAdmin(
  db: PostgresJsDatabase,
  authSubject: string,
): Promise<{ adminUserId: string } | null> {
  const rows = await db
    .select({ id: adminUser.id, status: adminUser.status })
    .from(adminUser)
    .where(eq(adminUser.authSubject, authSubject))
    .limit(1);
  const admin = rows[0];
  if (!admin || admin.status !== "active") return null;
  return { adminUserId: admin.id };
}

async function authenticateCustomer(
  db: PostgresJsDatabase,
  authSubject: string,
): Promise<{ customerId: string } | null> {
  const rows = await db
    .select({ id: customer.id })
    .from(customer)
    .where(eq(customer.authSubject, authSubject))
    .limit(1);
  const cust = rows[0];
  if (!cust) return null;
  return { customerId: cust.id };
}

async function authenticateCartToken(
  db: PostgresJsDatabase,
  token: string,
): Promise<{ cartId: string } | null> {
  const rows = await db.select({ id: cart.id }).from(cart).where(eq(cart.token, token)).limit(1);
  const c = rows[0];
  if (!c) return null;
  return { cartId: c.id };
}

// ---------------------------------------------------------------------------
// Reconnection guidance message
// ---------------------------------------------------------------------------

function reconnectionGuidance(): Record<string, unknown> {
  return {
    strategy: "exponential_backoff",
    initialDelayMs: 1000,
    maxDelayMs: 30000,
    multiplier: 2,
  };
}

// ---------------------------------------------------------------------------
// WebSocket manager factory
// ---------------------------------------------------------------------------

export interface RegisterWsOptions {
  app: FastifyInstance;
  db: PostgresJsDatabase;
}

export async function registerWebSocket(options: RegisterWsOptions): Promise<WsManager> {
  const { app, db } = options;

  await app.register(websocket);

  const connections = new Map<string, WsConnection>();
  let sequenceCounter = 0;

  function nextSequence(): number {
    return ++sequenceCounter;
  }

  function publish(
    entity: string,
    entityId: string,
    type: string,
    data: Record<string, unknown>,
  ): void {
    const channel = `${entity}:${entityId}`;
    const wildcardChannel = `${entity}:*`;
    const seq = nextSequence();
    const message: WsMessage = { type, entity, entityId, data, sequenceId: seq };
    const payload = JSON.stringify(message);

    for (const conn of connections.values()) {
      if (conn.channels.has(channel) || conn.channels.has(wildcardChannel)) {
        if (conn.socket.readyState === 1) {
          conn.socket.send(payload);
          conn.lastSequenceId = seq;
        }
      }
    }
  }

  app.get("/ws", { websocket: true }, async (socket: WebSocket, request: FastifyRequest) => {
    const url = new URL(request.url, `http://${request.hostname}`);
    const token = url.searchParams.get("token");
    const cartToken = url.searchParams.get("cart_token");

    let role: ConnectionRole;
    let subjectId: string;
    let channels: Set<string>;

    // Try session token auth (admin or customer)
    if (token) {
      try {
        const session = await Session.getSessionWithoutRequestResponse(token);
        const authSubject = session.getUserId();

        // Check if admin
        const adminResult = await authenticateAdmin(db, authSubject);
        if (adminResult) {
          role = "admin";
          subjectId = adminResult.adminUserId;
          channels = new Set([
            "order:*",
            "payment:*",
            "shipment:*",
            "ticket:*",
            "inventory:*",
            "dispute:*",
            "cart:*",
          ]);
        } else {
          // Check if customer
          const customerResult = await authenticateCustomer(db, authSubject);
          if (customerResult) {
            role = "customer";
            subjectId = customerResult.customerId;
            channels = new Set([`customer:${customerResult.customerId}`]);
          } else {
            socket.close(4001, "Unauthorized: user not found");
            return;
          }
        }
      } catch {
        socket.close(4001, "Unauthorized: invalid token");
        return;
      }
    } else if (cartToken) {
      // Guest auth via cart token
      const cartResult = await authenticateCartToken(db, cartToken);
      if (!cartResult) {
        socket.close(4001, "Unauthorized: invalid cart token");
        return;
      }
      role = "guest";
      subjectId = cartToken;
      channels = new Set([`cart:${cartResult.cartId}`]);
    } else {
      socket.close(4001, "Unauthorized: no credentials provided");
      return;
    }

    const connId = randomUUID();
    const conn: WsConnection = {
      id: connId,
      role,
      subjectId,
      socket,
      channels,
      lastSequenceId: 0,
    };
    connections.set(connId, conn);

    // Send welcome message with reconnection guidance
    const welcome: WsMessage = {
      type: "connected",
      entity: "system",
      entityId: connId,
      data: {
        role,
        channels: [...channels],
        reconnection: reconnectionGuidance(),
      },
      sequenceId: nextSequence(),
    };
    socket.send(JSON.stringify(welcome));
    conn.lastSequenceId = welcome.sequenceId;

    // Handle incoming messages (for future use — e.g., subscribe to specific entities)
    socket.on("message", (raw: Buffer | string) => {
      try {
        const msg = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf-8")) as {
          action?: string;
          entity?: string;
          entityId?: string;
        };

        if (msg.action === "subscribe" && msg.entity && msg.entityId) {
          if (role === "admin" || role === "customer") {
            conn.channels.add(`${msg.entity}:${msg.entityId}`);
          }
          // Guests cannot dynamically subscribe
        }
      } catch {
        // Ignore invalid messages
      }
    });

    socket.on("close", () => {
      connections.delete(connId);
    });

    socket.on("error", () => {
      connections.delete(connId);
    });
  });

  const manager: WsManager = {
    connections,
    publish,
    getSequence: () => sequenceCounter,
  };

  return manager;
}
