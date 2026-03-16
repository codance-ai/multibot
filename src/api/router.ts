import type { Env } from "../config/schema";

export interface RouteParams {
  [key: string]: string;
}

export type RouteHandler = (
  request: Request,
  env: Env,
  params: RouteParams
) => Promise<Response>;

export interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

/**
 * Define a route with a path pattern like `/api/bots/:botId`.
 * Colons in the path become named capture groups.
 */
export function defineRoute(
  method: string,
  pathPattern: string,
  handler: RouteHandler
): Route {
  const paramNames: string[] = [];
  const regexStr = pathPattern.replace(/:([^/]+)/g, (_match, name) => {
    paramNames.push(name);
    return "([^/]+)";
  });
  return {
    method: method.toUpperCase(),
    pattern: new RegExp(`^${regexStr}$`),
    paramNames,
    handler,
  };
}

/**
 * Match a request against the route list. Returns the Response from the
 * first matching route, or null if nothing matched.
 */
export async function dispatch(
  routes: Route[],
  request: Request,
  env: Env,
  pathname: string,
  ownerId: string
): Promise<Response | null> {
  for (const route of routes) {
    if (route.method !== request.method) continue;
    const match = pathname.match(route.pattern);
    if (!match) continue;

    const params: RouteParams = { ownerId };
    route.paramNames.forEach((name, i) => {
      params[name] = match[i + 1];
    });
    return route.handler(request, env, params);
  }
  return null;
}
