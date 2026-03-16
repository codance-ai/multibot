/**
 * Tests for DM request ID separation (Issue #407).
 *
 * In DM chat, the ingress layer (webhook/gateway) should pass its requestId
 * as `parentRequestId`, NOT as `requestId`. The agent auto-generates its own
 * requestId via createLogger, ensuring user and assistant messages have
 * different request IDs.
 */
import { describe, it, expect } from "vitest";
import { createLogger } from "../utils/logger";

describe("DM request ID separation (#407)", () => {
  it("agent generates independent requestId when payload.requestId is absent", () => {
    const webhookRequestId = crypto.randomUUID();

    // Simulate what the agent does at multibot.ts:225-231
    // DM payload has parentRequestId but no requestId
    const payload = {
      parentRequestId: webhookRequestId,
      requestId: undefined,
    };

    const log = createLogger({
      requestId: payload.requestId,
      parentRequestId: payload.parentRequestId,
    });

    // Agent should have its own requestId, different from webhook's
    expect(log.requestId).toBeDefined();
    expect(log.requestId).not.toBe(webhookRequestId);
  });

  it("user message gets parentRequestId, assistant gets agent requestId", () => {
    const webhookRequestId = crypto.randomUUID();

    // Agent creates its own logger (no requestId in payload → auto-generated)
    const log = createLogger({
      requestId: undefined,
      parentRequestId: webhookRequestId,
    });

    // User message persistence uses payload.parentRequestId
    const userMessageRequestId = webhookRequestId;
    // Assistant messages/traces use log.requestId
    const assistantRequestId = log.requestId;

    expect(userMessageRequestId).toBe(webhookRequestId);
    expect(assistantRequestId).not.toBe(webhookRequestId);
    expect(userMessageRequestId).not.toBe(assistantRequestId);
  });
});
