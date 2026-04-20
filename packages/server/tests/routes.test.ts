import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer } from "../src/index.js";
import type { FastifyInstance } from "fastify";
import type { Agent } from "@microagent/core";

let app: FastifyInstance;
let agent: Agent;

beforeAll(async () => {
  const result = await createServer({
    config: {
      provider: { type: "ollama", model: "test" },
      systemPrompt: "test",
    },
  });
  app = result.app;
  agent = result.agent;
});

afterAll(async () => {
  await app.close();
  await agent.shutdown();
});

describe("server routes", () => {
  it("GET /health returns ok", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.provider).toBeDefined();
    expect(typeof body.tools).toBe("number");
  });

  it("GET /tools returns tool list", async () => {
    const res = await app.inject({ method: "GET", url: "/tools" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.tools)).toBe(true);
  });

  it("GET /stats returns usage stats", async () => {
    const res = await app.inject({ method: "GET", url: "/stats" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.requests).toBe("number");
    expect(typeof body.totalTokens).toBe("number");
    expect(typeof body.toolCalls).toBe("number");
  });

  it("POST /chat rejects missing message", async () => {
    const res = await app.inject({ method: "POST", url: "/chat", payload: {} });
    expect(res.statusCode).toBe(400);
  });
});
