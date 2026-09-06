import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "http";
import { AddressInfo } from "net";
import { createApp } from "../../../src/interfaces/http/app";
import { redis } from "../../../src/infrastructure/db/redis";

// Boots the real Express app on an ephemeral port and drives it over real HTTP. Nothing
// here is stubbed: the routers, the auth middleware, the JSON body parser and both
// fallback handlers are the ones the server runs in production.
//
// Every case below is deliberately chosen to be answerable without Postgres or Redis, so
// this tier stays runnable in a bare CI checkout. That is a real limit, not a claim of
// full coverage: anything that reads a watchlist or a market state needs the compose
// stack up and belongs in a tier that declares those services.
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  // Importing the app pulls in the Redis client, which ioredis connects eagerly and
  // then retries forever. Without this the handle keeps the event loop alive and the
  // run hangs after the last assertion passes.
  redis.disconnect();
});

describe("GET /health", () => {
  it("reports ok and the market data mode the process actually resolved", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { status: string; marketDataMode: string };
    expect(body.status).toBe("ok");
    // Not asserted as a literal: the mode depends on whether an API key is configured,
    // and pinning it here would make the suite fail on a machine that has one.
    expect(["live", "replay"]).toContain(body.marketDataMode);
  });
});

describe("unknown /api routes", () => {
  it("answers with JSON rather than Express's HTML page", async () => {
    const res = await fetch(`${baseUrl}/api/definitely-not-a-route`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "NOT_FOUND" });
  });

  it("applies to every verb, not just GET", async () => {
    const res = await fetch(`${baseUrl}/api/definitely-not-a-route`, { method: "POST" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "NOT_FOUND" });
  });
});

describe("malformed request bodies", () => {
  it("reports a broken JSON body as 400, not 500", async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });
    // The distinction matters to the client: 500 invites a retry against a server that
    // is working fine, 400 tells it to fix the request.
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "INVALID_JSON" });
  });
});

describe("authentication boundary", () => {
  it("rejects an unauthenticated watchlist read before it reaches the database", async () => {
    const res = await fetch(`${baseUrl}/api/watchlist`);
    expect(res.status).toBe(401);
  });

  it("rejects a token this server did not sign", async () => {
    const res = await fetch(`${baseUrl}/api/watchlist`, {
      headers: { authorization: "Bearer not.a.real.token" },
    });
    expect(res.status).toBe(401);
  });

  // The WS ticket endpoint is the only way to obtain a socket credential now, so an
  // unauthenticated caller reaching it would hand out exactly what moving the JWT out of
  // the socket URL was meant to protect. Rejected by requireAuth, before Redis.
  it("refuses to mint a WebSocket ticket without a session", async () => {
    const res = await fetch(`${baseUrl}/api/auth/ws-ticket`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("refuses to mint a WebSocket ticket for a token this server did not sign", async () => {
    const res = await fetch(`${baseUrl}/api/auth/ws-ticket`, {
      method: "POST",
      headers: { authorization: "Bearer not.a.real.token" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects an admin trigger with no admin key", async () => {
    const res = await fetch(`${baseUrl}/api/admin/trigger`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ symbol: "RELIANCE", type: "NEWS" }),
    });
    expect(res.status).toBe(401);
  });
});
