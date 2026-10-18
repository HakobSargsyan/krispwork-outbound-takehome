/** CSRF (double-submit cookie) + a per-IP login rate limiter. */

import { randomBytes, timingSafeEqual } from "node:crypto";

export const CSRF_COOKIE = "login_csrf";

export function issueCsrfToken(): string {
  return randomBytes(24).toString("base64url");
}

export function csrfMatches(cookie?: string, form?: string): boolean {
  if (!cookie || !form) return false;
  const a = Buffer.from(cookie);
  const b = Buffer.from(form);
  return a.length === b.length && timingSafeEqual(a, b);
}

const loginAttempts = new Map<string, number[]>();

export function rateLimitOk(ip: string): boolean {
  const now = Date.now();
  const recent = (loginAttempts.get(ip) ?? []).filter((t) => now - t < 5 * 60_000);
  loginAttempts.set(ip, recent);
  return recent.length < 5;
}

export function recordAttempt(ip: string): void {
  const attempts = loginAttempts.get(ip) ?? [];
  attempts.push(Date.now());
  loginAttempts.set(ip, attempts);
}
