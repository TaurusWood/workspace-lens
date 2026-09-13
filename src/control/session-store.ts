/**
 * Ephemeral browser-control session store
 * (`docs/v0.3-control-plane-security-contract.md` §5).
 *
 * One in-memory session per browser for the runtime's lifetime: generated
 * from cryptographically secure randomness, stored only in runtime memory,
 * invalidated when the runtime exits or restarts. The session authorizes the
 * local administration UI; it is never an MCP credential and is never
 * accepted on `/mcp`.
 *
 * `Secure` is intentionally omitted: the surface is loopback HTTP, and the
 * localhost exception is documented in the security contract (§5). The
 * HttpOnly + SameSite=Strict attributes are non-negotiable (SEC-009).
 */
import { randomBytes } from "node:crypto";

export const SESSION_COOKIE_NAME = "wl_session";

export interface BrowserSession {
  token: string;
  csrfToken: string;
}

export class SessionStore {
  private readonly sessions = new Map<string, string>();

  /** Return the session for a presented token, or create a fresh one. */
  ensure(presentedToken: string | undefined): BrowserSession {
    if (presentedToken !== undefined) {
      const csrf = this.sessions.get(presentedToken);
      if (csrf !== undefined) {
        return { token: presentedToken, csrfToken: csrf };
      }
    }
    return this.create();
  }

  /** Look up a session without creating one. */
  get(token: string | undefined): BrowserSession | undefined {
    if (token === undefined) {
      return undefined;
    }
    const csrf = this.sessions.get(token);
    return csrf === undefined ? undefined : { token, csrfToken: csrf };
  }

  create(): BrowserSession {
    const session: BrowserSession = {
      token: randomBytes(32).toString("base64url"),
      csrfToken: randomBytes(32).toString("base64url"),
    };
    this.sessions.set(session.token, session.csrfToken);
    return session;
  }

  clear(): void {
    this.sessions.clear();
  }
}

/** Parse a Cookie header into name/value pairs (bounded, no URL decoding). */
export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (header === undefined) {
    return cookies;
  }
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) {
      continue;
    }
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name !== "" && name.length <= 128 && value.length <= 512) {
      cookies[name] = value;
    }
  }
  return cookies;
}
