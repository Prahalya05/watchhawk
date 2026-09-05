// Must come first: config/env validates the environment the moment it is imported.
import "../../../setup/env";
import { describe, expect, it } from "vitest";
import { env } from "../../../../src/config/env";
import { InvalidTokenError, TokenExpiredError, normalizeEmail, verifyToken } from "../../../../src/application/auth/auth.service";
import jwt from "jsonwebtoken";



describe("normalizeEmail", () => {
  it("folds case so one address is one account", () => {
    expect(normalizeEmail("Prahalya@Gmail.COM")).toBe("prahalya@gmail.com");
  });

  it("strips surrounding whitespace a paste or autofill can leave behind", () => {
    expect(normalizeEmail("  user@example.com \n")).toBe("user@example.com");
  });
});

describe("verifyToken", () => {
  const sign = (payload: object, opts?: jwt.SignOptions) => jwt.sign(payload, env.JWT_SECRET, opts);

  it("accepts a token this server issued", () => {
    const token = sign({ userId: "u1", email: "user@example.com" });
    expect(verifyToken(token)).toEqual({ userId: "u1", email: "user@example.com" });
  });

  it("rejects a token signed with a different secret", () => {
    const token = jwt.sign({ userId: "u1", email: "user@example.com" }, "not-the-real-secret");
    expect(() => verifyToken(token)).toThrow(InvalidTokenError);
  });

  it("rejects a structurally invalid token", () => {
    expect(() => verifyToken("not.a.jwt")).toThrow(InvalidTokenError);
  });

  // The regression this guards: an unchecked `as JwtPayload` cast let a correctly signed
  // token with the wrong payload through, so req.auth.userId was undefined and every
  // downstream `where: { userId }` quietly matched nothing instead of returning 401.
  it("rejects a correctly signed token whose payload is the wrong shape", () => {
    expect(() => verifyToken(sign({ sub: "u1" }))).toThrow(InvalidTokenError);
    expect(() => verifyToken(sign({ userId: 42, email: "user@example.com" }))).toThrow(InvalidTokenError);
    expect(() => verifyToken(sign({ userId: "u1" }))).toThrow(InvalidTokenError);
  });

  it("reports expiry distinctly, so the client can say 'log in again'", () => {
    const token = sign({ userId: "u1", email: "user@example.com" }, { expiresIn: "-1s" });
    expect(() => verifyToken(token)).toThrow(TokenExpiredError);
  });

  it("returns only the fields the app trusts, not arbitrary claims", () => {
    const token = sign({ userId: "u1", email: "user@example.com", isAdmin: true });
    expect(verifyToken(token)).toEqual({ userId: "u1", email: "user@example.com" });
  });
});
