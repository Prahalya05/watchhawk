import { afterAll, describe, expect, it } from "vitest";
import type { IncomingMessage } from "http";
import { WS_TICKET_SUBPROTOCOL, extractTicket } from "../../../../src/interfaces/ws/ws.auth";
import { redeemWsTicket } from "../../../../src/application/auth/ws-ticket.service";
import { redis } from "../../../../src/infrastructure/db/redis";

// ws.auth pulls in the ticket service, which pulls in the Redis client, and ioredis
// connects eagerly and then retries forever. Without this the handle keeps the event loop
// alive and the run hangs after the last assertion. No test below reaches Redis: the
// header parsing is pure, and the malformed-ticket cases are rejected by shape before any
// command is issued.
afterAll(() => {
  redis.disconnect();
});

function upgradeRequest(protocolHeader?: string | string[]): IncomingMessage {
  return {
    headers: protocolHeader === undefined ? {} : { "sec-websocket-protocol": protocolHeader },
  } as IncomingMessage;
}

describe("extractTicket", () => {
  it("reads the ticket that follows the scheme marker", () => {
    expect(extractTicket(upgradeRequest(`${WS_TICKET_SUBPROTOCOL}, abc123`))).toBe("abc123");
  });

  it("tolerates a header with no spacing", () => {
    expect(extractTicket(upgradeRequest(`${WS_TICKET_SUBPROTOCOL},abc123`))).toBe("abc123");
  });

  it("flattens repeated headers, which is how some proxies split the list", () => {
    expect(extractTicket(upgradeRequest([WS_TICKET_SUBPROTOCOL, "abc123"]))).toBe("abc123");
  });

  it("returns null when the header is absent entirely", () => {
    expect(extractTicket(upgradeRequest())).toBeNull();
  });

  it("returns null when the marker is offered with no ticket after it", () => {
    expect(extractTicket(upgradeRequest(WS_TICKET_SUBPROTOCOL))).toBeNull();
  });

  it("returns null for an unrelated subprotocol rather than treating its value as a ticket", () => {
    expect(extractTicket(upgradeRequest("chat, superchat"))).toBeNull();
  });

  it("takes the value after the marker, not the first value in the list", () => {
    expect(extractTicket(upgradeRequest(`chat, ${WS_TICKET_SUBPROTOCOL}, abc123`))).toBe("abc123");
  });
});

describe("redeemWsTicket input guarding", () => {
  // Rejected on shape before the value is hashed or looked up, so a hostile client cannot
  // make the server do work — or build a Redis key — out of arbitrary input.
  it.each([
    ["an empty string", ""],
    ["a ticket of the wrong length", "short"],
    ["a ticket containing characters outside base64url", "a".repeat(42) + "+"],
    ["an over-long value", "a".repeat(4096)],
  ])("rejects %s without touching Redis", async (_label, ticket) => {
    await expect(redeemWsTicket(ticket)).resolves.toBeNull();
  });
});
