import type { WsManager } from "./manager.js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { domainEvent } from "../db/schema/domain-event.js";

// ---------------------------------------------------------------------------
// Domain event types
// ---------------------------------------------------------------------------

export type DomainEventType =
  | "order.placed"
  | "payment.succeeded"
  | "shipment.delivered"
  | "ticket.updated"
  | "inventory.low_stock"
  | "dispute.opened"
  | "settings.changed"
  | "milestone.reached";

// ---------------------------------------------------------------------------
// Subscriber support
// ---------------------------------------------------------------------------

export type DomainEventSubscriber = (
  type: DomainEventType,
  entity: string,
  entityId: string,
  data: Record<string, unknown>,
  customerId?: string,
) => void | Promise<void>;

// ---------------------------------------------------------------------------
// Domain event publisher
// ---------------------------------------------------------------------------

export interface DomainEventPublisher {
  /**
   * Publish a domain event to WebSocket subscribers and persistent store.
   *
   * - Publishes to `entity:entityId` (admins receive via wildcard `entity:*`)
   * - If `customerId` is provided, also publishes to `customer:customerId`
   *   so the customer receives the event on their channel.
   * - Persists the event to the `domain_event` table for audit replay.
   * - Notifies all registered subscribers; a failing subscriber does not
   *   block other subscribers or the publish call.
   */
  publish(
    type: DomainEventType,
    entity: string,
    entityId: string,
    data: Record<string, unknown>,
    customerId?: string,
  ): void;

  /**
   * Register a subscriber that is called on every published event.
   * Returns an unsubscribe function.
   */
  subscribe(subscriber: DomainEventSubscriber): () => void;
}

export interface CreateDomainEventPublisherOptions {
  wsManager?: WsManager;
  db?: PostgresJsDatabase;
}

export function createDomainEventPublisher(
  wsManagerOrOptions?: WsManager | CreateDomainEventPublisherOptions,
): DomainEventPublisher {
  let wsManager: WsManager | undefined;
  let db: PostgresJsDatabase | undefined;

  if (wsManagerOrOptions && "publish" in wsManagerOrOptions) {
    // Legacy signature: createDomainEventPublisher(wsManager)
    wsManager = wsManagerOrOptions;
  } else if (wsManagerOrOptions) {
    wsManager = wsManagerOrOptions.wsManager;
    db = wsManagerOrOptions.db;
  }

  const subscribers = new Set<DomainEventSubscriber>();

  return {
    publish(type, entity, entityId, data, customerId) {
      // Capture the sequence ID from WS publish for the persistent record
      let sequenceId = 0;

      if (wsManager) {
        // Publish to the entity channel (admin gets via wildcard)
        wsManager.publish(entity, entityId, type, data);
        sequenceId = wsManager.getSequence();

        // Also publish to the customer channel if applicable
        if (customerId) {
          wsManager.publish("customer", customerId, type, data);
        }
      }

      // Persist to domain_event table (fire-and-forget, don't block publisher)
      if (db) {
        db.insert(domainEvent)
          .values({
            eventType: type,
            entity,
            entityId,
            payloadJson: data,
            customerId: customerId ?? null,
            sequenceId,
          })
          .catch(() => {
            // Log but don't block — persistence failure must not break event flow
          });
      }

      // Notify subscribers — each subscriber is isolated; failure in one
      // does not block others.
      for (const sub of subscribers) {
        try {
          const result = sub(type, entity, entityId, data, customerId);
          if (result && typeof result.catch === "function") {
            result.catch(() => {
              // async subscriber failure — silently caught
            });
          }
        } catch {
          // sync subscriber failure — silently caught
        }
      }
    },

    subscribe(subscriber) {
      subscribers.add(subscriber);
      return () => {
        subscribers.delete(subscriber);
      };
    },
  };
}
