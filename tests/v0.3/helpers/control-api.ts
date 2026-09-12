/**
 * Control API client helpers shared by the security (SEC-*) and E2E (L4)
 * contract suites. Both suites drive the same HTTP product surface: session
 * bootstrap → CSRF token → privileged mutations with valid Origin.
 */
export interface SessionCredentials {
  cookie: string;
  csrf: string;
}

/** Establish a browser session and return cookie + CSRF token credentials. */
export async function establishSession(baseUrl: string): Promise<SessionCredentials> {
  const sessionResponse = await fetch(`${baseUrl}/api/v1/session`);
  const setCookie = sessionResponse.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0] ?? "";
  const body = (await sessionResponse.json()) as { csrf_token?: string };
  return { cookie, csrf: body.csrf_token ?? "" };
}

export type ApiAuth = {
  cookie?: string;
  csrf?: string;
  origin?: string;
};

export async function apiRequest(
  baseUrl: string,
  route: string,
  body: unknown,
  auth: ApiAuth = {},
  method: "POST" | "PATCH" | "DELETE" | "GET" = "POST",
): Promise<Response> {
  return fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(auth.cookie ? { cookie: auth.cookie } : {}),
      ...(auth.csrf ? { "x-csrf-token": auth.csrf } : {}),
      ...(auth.origin ? { origin: auth.origin } : {}),
    },
    body: method === "GET" ? undefined : JSON.stringify(body),
  });
}
