import { describe, it, expect } from "vitest";
import { defineRoute, dispatch } from "./router";
import type { Env } from "../config/schema";

const dummyEnv = {} as Env;

function makeRequest(method: string, url = "https://example.com"): Request {
  return new Request(url, { method });
}

describe("defineRoute", () => {
  it("creates a route with no params for a static path", () => {
    const route = defineRoute("GET", "/api/bots", async () => new Response("ok"));
    expect(route.method).toBe("GET");
    expect(route.paramNames).toEqual([]);
    expect(route.pattern.test("/api/bots")).toBe(true);
    expect(route.pattern.test("/api/bots/123")).toBe(false);
  });

  it("extracts param names from path", () => {
    const route = defineRoute("GET", "/api/bots/:botId", async () => new Response("ok"));
    expect(route.paramNames).toEqual(["botId"]);
    expect(route.pattern.test("/api/bots/abc-123")).toBe(true);
    expect(route.pattern.test("/api/bots")).toBe(false);
  });

  it("supports multiple params", () => {
    const route = defineRoute("GET", "/api/:ownerId/bots/:botId", async () => new Response("ok"));
    expect(route.paramNames).toEqual(["ownerId", "botId"]);
    const match = "/api/owner1/bots/bot2".match(route.pattern);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("owner1");
    expect(match![2]).toBe("bot2");
  });

  it("uppercases the method", () => {
    const route = defineRoute("post", "/api/bots", async () => new Response("ok"));
    expect(route.method).toBe("POST");
  });
});

describe("dispatch", () => {
  it("returns response from matching route", async () => {
    const routes = [
      defineRoute("GET", "/api/bots", async () => new Response("list")),
    ];
    const res = await dispatch(routes, makeRequest("GET"), dummyEnv, "/api/bots", "test-owner");
    expect(res).not.toBeNull();
    expect(await res!.text()).toBe("list");
  });

  it("passes extracted params to handler", async () => {
    const routes = [
      defineRoute("GET", "/api/bots/:botId", async (_req, _env, params) => {
        return new Response(params.botId);
      }),
    ];
    const res = await dispatch(routes, makeRequest("GET"), dummyEnv, "/api/bots/xyz", "test-owner");
    expect(await res!.text()).toBe("xyz");
  });

  it("returns null when method does not match", async () => {
    const routes = [
      defineRoute("POST", "/api/bots", async () => new Response("created")),
    ];
    const res = await dispatch(routes, makeRequest("GET"), dummyEnv, "/api/bots", "test-owner");
    expect(res).toBeNull();
  });

  it("returns null when path does not match", async () => {
    const routes = [
      defineRoute("GET", "/api/bots", async () => new Response("list")),
    ];
    const res = await dispatch(routes, makeRequest("GET"), dummyEnv, "/api/users", "test-owner");
    expect(res).toBeNull();
  });

  it("matches the first route when multiple could match", async () => {
    const routes = [
      defineRoute("GET", "/api/bots", async () => new Response("first")),
      defineRoute("GET", "/api/bots", async () => new Response("second")),
    ];
    const res = await dispatch(routes, makeRequest("GET"), dummyEnv, "/api/bots", "test-owner");
    expect(await res!.text()).toBe("first");
  });
});
