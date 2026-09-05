import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { Prisma } from "@prisma/client";
import { prisma } from "../../infrastructure/db/prisma";
import { env } from "../../config/env";
import type { JwtPayload } from "../../domain/auth/auth.types";

const SALT_ROUNDS = 10;
const TOKEN_TTL = "7d";

export class EmailTakenError extends Error {}
export class InvalidCredentialsError extends Error {}
export class TokenExpiredError extends Error {}
export class InvalidTokenError extends Error {}

// Email is the login identifier, so it has to compare the way users expect it to:
// "Prahalya@Gmail.com" and "prahalya@gmail.com" are one account, not two. The unique
// constraint is a plain byte comparison, so normalizing has to happen before every
// create and every lookup — otherwise registering with a different capitalization
// silently makes a second account, and logging in with it reports bad credentials.
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function registerUser(rawEmail: string, password: string) {
  const email = normalizeEmail(rawEmail);

  // No upfront findUnique-then-create: bcrypt.hash below takes ~100ms+ by design,
  // which is more than enough time for two concurrent registrations with the same
  // email to both pass a preceding check. The unique constraint on User.email is the
  // actual source of truth — catching its violation (P2002) is what turns that race
  // into a clean 409 instead of an unhandled 500.
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  let user;
  try {
    user = await prisma.user.create({ data: { email, passwordHash } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new EmailTakenError();
    }
    throw err;
  }

  return { user: { id: user.id, email: user.email }, token: issueToken(user.id, user.email) };
}

export async function loginUser(rawEmail: string, password: string) {
  const email = normalizeEmail(rawEmail);
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new InvalidCredentialsError();

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) throw new InvalidCredentialsError();

  return { user: { id: user.id, email: user.email }, token: issueToken(user.id, user.email) };
}

function issueToken(userId: string, email: string): string {
  const payload: JwtPayload = { userId, email };
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: TOKEN_TTL });
}

// Signature-valid is not the same as usable: a token signed by this secret but carrying
// the wrong shape (an older payload, a string subject) would otherwise flow through as
// `req.auth.userId === undefined` and turn every downstream `where: { userId }` into a
// silent empty result rather than a 401. Expiry is separated from the rest so the client
// can tell "log in again" apart from "this token is junk".
export function verifyToken(token: string): JwtPayload {
  let decoded: unknown;
  try {
    decoded = jwt.verify(token, env.JWT_SECRET);
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) throw new TokenExpiredError();
    throw new InvalidTokenError();
  }

  if (
    typeof decoded !== "object" ||
    decoded === null ||
    typeof (decoded as JwtPayload).userId !== "string" ||
    typeof (decoded as JwtPayload).email !== "string"
  ) {
    throw new InvalidTokenError();
  }

  const { userId, email } = decoded as JwtPayload;
  return { userId, email };
}
