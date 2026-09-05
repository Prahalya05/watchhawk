// Must come first: config/env validates the environment the moment it is imported.
import "../../test/env";
import { describe, expect, it, vi } from "vitest";
import { env } from "../../config/env";
import { requireAuth } from "./auth.middleware";
import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";



function run(authorization?: string) {
  const req = { headers: authorization ? { authorization } : {} } as Request;
  const json = vi.fn();
  const res = { status: vi.fn().mockReturnValue({ json }), json } as unknown as Response;
  const next = vi.fn() as NextFunction;
  requireAuth(req, res, next);
  return { req, res, next, json, status: res.status as unknown as ReturnType<typeof vi.fn> };
}

const validToken = jwt.sign({ userId: "u1", email: "user@example.com" }, env.JWT_SECRET);

describe("requireAuth", () => {
  it("populates req.auth and continues for a valid token", () => {
    const { req, next } = run(`Bearer ${validToken}`);
    expect(next).toHaveBeenCalled();
    expect(req.auth).toEqual({ userId: "u1", email: "user@example.com" });
  });

  it("accepts the scheme case-insensitively, as RFC 7235 requires", () => {
    expect(run(`bearer ${validToken}`).next).toHaveBeenCalled();
  });

  it("rejects a request with no Authorization header", () => {
    const { next, status, json } = run();
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: "MISSING_TOKEN" });
  });

  // A client that stringifies an absent token sends the literal "Bearer null"; that is a
  // missing session, not a tampered token, and saying so keeps the client's retry logic
  // pointed at "log in" rather than "something is wrong with your token".
  it.each(["Bearer null", "Bearer undefined", "Bearer    ", "Basic abc123", validToken])(
    "rejects %j as a missing token",
    (header) => {
      const { next, json } = run(header);
      expect(next).not.toHaveBeenCalled();
      expect(json).toHaveBeenCalledWith({ error: "MISSING_TOKEN" });
    },
  );

  it("distinguishes an expired token from an invalid one", () => {
    const expired = jwt.sign({ userId: "u1", email: "user@example.com" }, env.JWT_SECRET, { expiresIn: "-1s" });
    expect(run(`Bearer ${expired}`).json).toHaveBeenCalledWith({ error: "TOKEN_EXPIRED" });
    expect(run("Bearer forged.token.value").json).toHaveBeenCalledWith({ error: "INVALID_TOKEN" });
  });
});
