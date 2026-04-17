import type { WsManager } from "./manager.js";

// ---------------------------------------------------------------------------
// Domain event types
// ---------------------------------------------------------------------------

export type DomainEventType =
  | "order.placed"
  | "payment.succeeded"
  | "shipment.delivered"
  | "ticket.updated"
  | "inventory.low_stock"
  | "dispute.opened";

// ---------------------------------------------------------------------------
// Domain event publisher
// ---------------------------------------------------------------------------

export interface DomainEventPublisher {
  /**
   * Publish a domain event to WebSocket subscribers.
   *
   * - Publishes to `entity:entityId` (admins receive via wildcard `entity:*`)
   * - If `customerId` is provided, also publishes to `customer:customerId`
   *   so the customer receives the event on their channel.
   */
  publish(
    type: DomainEventType,
    entity: string,
    entityId: string,
    data: Record<string, unknown>,
    customerId?: string,
  ): void;
}

export function createDomainEventPublisher(wsManager: WsManager | undefined): DomainEventPublisher {
  return {
    publish(type, entity, entityId, data, customerId) {
      if (!wsManager) return;

      // Publish to the entity channel (admin gets via wildcard)
      wsManager.publish(entity, entityId, type, data);

      // Also publish to the customer channel if applicable
      if (customerId) {
        wsManager.publish("customer", customerId, type, data);
      }
    },
  };
}
