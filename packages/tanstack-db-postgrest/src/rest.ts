// For a server that runs the API itself (`@tspg/rest`, or anything with a `handle(Request) => Response`): a
// `fetch` that hands each request straight to it, in the same process, with no network and no second server.
// It names no package: `handle` is all it needs, so it is the only thing of this package that is not about HTTP.

/** What serves the API: `createRest(...)` of `@tspg/rest` is one. */
export interface RestHandler {
  handle(request: Request): Promise<Response>;
}

export interface RestFetchOptions {
  /**
   * What a relative URL (`/api/todos`) is resolved against. It is never requested: `handle` is called
   * directly. Default `"http://localhost"`.
   */
  base?: string;
  /**
   * The headers of the incoming request that say who is calling, copied onto each request made on its behalf.
   * Default `["cookie", "authorization"]`. Leave a header out and the API does not see it.
   */
  forward?: readonly string[];
}

/**
 * A `fetch` that calls `rest.handle(...)` directly. Give it the incoming request, and the API sees the same
 * caller as that request did (`resolveContext` reads the same cookie or token): without it, the calls are
 * anonymous.
 *
 * It belongs to the server: it holds `rest`, so keep it out of code that reaches the browser, and make one per
 * incoming request (it carries that request's identity).
 *
 * ```ts ignore
 * import { restFetch } from "@tspg/tanstack-db-postgrest/rest";
 * import { pgRest } from "./rest.server";
 *
 * export const serverTodos = (request: Request) => todos({ url: "/api", fetch: restFetch(pgRest, request) });
 * ```
 */
export function restFetch(rest: RestHandler, incoming?: Request, options: RestFetchOptions = {}): typeof fetch {
  const base = options.base ?? "http://localhost";
  const forward = options.forward ?? ["cookie", "authorization"];
  return ((input: string | URL | Request, init?: RequestInit) => {
    const request =
      input instanceof Request ? new Request(input, init) : new Request(new URL(input, base).toString(), init);
    if (incoming) {
      for (const name of forward) {
        const value = incoming.headers.get(name);
        if (value !== null && !request.headers.has(name)) request.headers.set(name, value);
      }
    }
    return rest.handle(request);
  }) as typeof fetch;
}
