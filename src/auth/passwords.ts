/**
 * Password hashing (PBKDF2-HMAC-SHA256, 600k iterations -- OWASP's 2023
 * floor) plus the one demo user. Set DEMO_USERNAME and either DEMO_PASSWORD
 * (plaintext, hashed once at startup -- the simplest path, e.g. for handing
 * this off to someone else to run) or DEMO_PASSWORD_HASH (pre-hashed, for
 * when you don't want the plaintext sitting in .env at all, even briefly).
 * If neither is set, a random one-time password is generated and printed
 * to stderr.
 */

import { pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";

const ITERATIONS = 600_000;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = pbkdf2Sync(password, salt, ITERATIONS, 32, "sha256");
  return `${ITERATIONS}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [iterStr, saltHex, hashHex] = stored.split("$");
  if (!iterStr || !saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const candidate = pbkdf2Sync(password, salt, Number(iterStr), expected.length, "sha256");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

const USERNAME = process.env.DEMO_USERNAME ?? "demo";
// Hashed against this (instead of short-circuiting) for an unknown
// username too, so "no such user" and "wrong password" cost the same time.
const DUMMY_HASH = hashPassword(randomBytes(16).toString("base64url"));
let PASSWORD_HASH = process.env.DEMO_PASSWORD ? hashPassword(process.env.DEMO_PASSWORD) : process.env.DEMO_PASSWORD_HASH;
if (!PASSWORD_HASH) {
  const generated = randomBytes(9).toString("base64url");
  PASSWORD_HASH = hashPassword(generated);
  console.error(`[auth] Neither DEMO_PASSWORD nor DEMO_PASSWORD_HASH is set; one-time login -> username=${USERNAME} password=${generated}`);
}

export function authenticate(username: string, password: string): boolean {
  const known = username === USERNAME;
  const valid = verifyPassword(password, known ? PASSWORD_HASH! : DUMMY_HASH);
  return known && valid;
}
