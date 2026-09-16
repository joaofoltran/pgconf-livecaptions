import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { AppConfig } from "./config.js";

const COOKIE = "lc_admin";
const SESSION_MAX_AGE_SECONDS = 24 * 60 * 60;

function sign(secret: string, value: string): string {
  const h = createHmac("sha256", secret).update(value).digest("hex");
  return `${value}.${h}`;
}

function verify(secret: string, cookie: string | undefined, now: number): boolean {
  if (!cookie || !secret) return false;
  const i = cookie.lastIndexOf(".");
  if (i < 0) return false;
  const value = cookie.slice(0, i);
  const expected = sign(secret, value);
  const a = Buffer.from(cookie);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  if (!timingSafeEqual(a, b)) return false;

  const expiresAt = Number(value.slice(value.lastIndexOf(".") + 1));
  return Number.isSafeInteger(expiresAt) && expiresAt > now;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    try {
      out[k] = decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      // Ignore malformed cookies instead of failing the whole request.
    }
  }
  return out;
}

export function isAdmin(
  req: Request,
  config: AppConfig,
  now = Date.now()
): boolean {
  const cookies = parseCookies(req.headers.cookie);
  return verify(config.sessionSecret, cookies[COOKIE], now);
}

export function requireAdmin(config: AppConfig) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (isAdmin(req, config)) {
      next();
      return;
    }
    res.status(401).json({ error: "unauthorized" });
  };
}

function cookieAttributes(secure: boolean): string {
  return `HttpOnly; SameSite=Lax; Path=/;${secure ? " Secure;" : ""}`;
}

export function loginAdmin(res: Response, config: AppConfig, secure: boolean): void {
  const nonce = randomBytes(16).toString("hex");
  const expiresAt = Date.now() + SESSION_MAX_AGE_SECONDS * 1000;
  const cookie = sign(config.sessionSecret, `${nonce}.${expiresAt}`);
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=${encodeURIComponent(cookie)}; ${cookieAttributes(secure)} Max-Age=${SESSION_MAX_AGE_SECONDS}`
  );
}

export function logoutAdmin(res: Response, secure: boolean): void {
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=; ${cookieAttributes(secure)} Max-Age=0`
  );
}

export function requireSameOrigin(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const origin = req.get("origin");
  const host = req.get("host");
  if (!origin || !host) {
    res.status(403).json({ error: "invalid origin" });
    return;
  }

  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== `${req.protocol}:` || parsed.host !== host) {
      res.status(403).json({ error: "invalid origin" });
      return;
    }
  } catch {
    res.status(403).json({ error: "invalid origin" });
    return;
  }

  next();
}

type Attempt = { count: number; resetAt: number };

export type LoginRateLimitResult = {
  allowed: boolean;
  retryAfterSeconds: number;
};

export class LoginRateLimiter {
  private readonly attempts = new Map<string, Attempt>();

  constructor(
    private readonly maxAttempts = 5,
    private readonly windowMs = 15 * 60 * 1000
  ) {}

  consume(key: string, now = Date.now()): LoginRateLimitResult {
    let attempt = this.attempts.get(key);
    if (!attempt || attempt.resetAt <= now) {
      attempt = { count: 0, resetAt: now + this.windowMs };
      this.attempts.set(key, attempt);
    }
    attempt.count += 1;

    if (this.attempts.size > 10_000) {
      for (const [attemptKey, value] of this.attempts) {
        if (value.resetAt <= now) this.attempts.delete(attemptKey);
      }
      if (this.attempts.size > 10_000) {
        const oldestKey = this.attempts.keys().next().value as string | undefined;
        if (oldestKey) this.attempts.delete(oldestKey);
      }
    }

    return {
      allowed: attempt.count <= this.maxAttempts,
      retryAfterSeconds: Math.max(1, Math.ceil((attempt.resetAt - now) / 1000)),
    };
  }

  reset(key: string): void {
    this.attempts.delete(key);
  }

  middleware(): RequestHandler {
    return (req: Request, res: Response, next: NextFunction) => {
      const key = req.ip || req.socket.remoteAddress || "unknown";
      const result = this.consume(key);
      if (result.allowed) {
        next();
        return;
      }
      res.setHeader("Retry-After", String(result.retryAfterSeconds));
      res.status(429).json({ error: "too many login attempts" });
    };
  }
}
