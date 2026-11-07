import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  createAgentSessionServices,
  createAgentSessionFromServices,
  AgentSessionRuntime,
} from "@earendil-works/pi-coding-agent";
import {
  installSubagentForkSupport,
  findSubagentTurnEndEntryId,
  formatSubagentForkLabel,
} from "../src/fork-compat";

describe("Subagent /fork Support Integration", () => {
  let tmpDir: string;
  let prevDepth: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fork-test-"));
    prevDepth = process.env.PI_SUBAGENT_DEPTH;
    process.env.PI_SUBAGENT_DEPTH = "0";
    installSubagentForkSupport();
  });

  afterEach(() => {
    if (prevDepth !== undefined) {
      process.env.PI_SUBAGENT_DEPTH = prevDepth;
    } else {
      delete process.env.PI_SUBAGENT_DEPTH;
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("findSubagentTurnEndEntryId correctly resolves turn boundaries", () => {
    // 1. Simple CM1 -> A2
    const entries1 = [
      { id: "cm1", type: "custom_message", customType: "subagent-response", parentId: "a1" },
      { id: "a2", type: "message", message: { role: "assistant", content: [{ type: "text", text: "Done" }] }, parentId: "cm1" },
    ];
    expect(findSubagentTurnEndEntryId(entries1, "cm1")).toBe("a2");

    // 2. CM1 -> A2_call -> TR -> A2_final -> U2
    const entries2 = [
      { id: "cm1", type: "custom_message", customType: "subagent-response", parentId: "a1" },
      { id: "a2_call", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "tc1" }] }, parentId: "cm1" },
      { id: "tr1", type: "message", message: { role: "toolResult", toolCallId: "tc1" }, parentId: "a2_call" },
      { id: "a2_final", type: "message", message: { role: "assistant", content: [{ type: "text", text: "Answer" }] }, parentId: "tr1" },
      { id: "u2", type: "message", message: { role: "user", content: [{ type: "text", text: "Next" }] }, parentId: "a2_final" },
    ];
    expect(findSubagentTurnEndEntryId(entries2, "cm1")).toBe("a2_final");

    // 3. CM1 -> CM2 -> A2 (multiple subagent responses steered back-to-back before assistant replied)
    const entries3 = [
      { id: "cm1", type: "custom_message", customType: "subagent-response", parentId: "a1" },
      { id: "cm2", type: "custom_message", customType: "subagent-response", parentId: "cm1" },
      { id: "a2", type: "message", message: { role: "assistant", content: [{ type: "text", text: "Both subagents done" }] }, parentId: "cm2" },
    ];
    expect(findSubagentTurnEndEntryId(entries3, "cm1")).toBe("a2");
    expect(findSubagentTurnEndEntryId(entries3, "cm2")).toBe("a2");

    // 4. CM1 -> A2 -> CM2 -> A3 (stops at A2 when second subagent finished after assistant replied)
    const entries4 = [
      { id: "cm1", type: "custom_message", customType: "subagent-response", parentId: "a1" },
      { id: "a2", type: "message", message: { role: "assistant", content: [{ type: "text", text: "First reply" }] }, parentId: "cm1" },
      { id: "cm2", type: "custom_message", customType: "subagent-response", parentId: "a2" },
      { id: "a3", type: "message", message: { role: "assistant", content: [{ type: "text", text: "Second reply" }] }, parentId: "cm2" },
    ];
    expect(findSubagentTurnEndEntryId(entries4, "cm1")).toBe("a2");
    expect(findSubagentTurnEndEntryId(entries4, "cm2")).toBe("a3");
  });

  it("formatSubagentForkLabel extracts concise human-readable labels", () => {
    // With assistant reply
    const cmEntry1 = {
      id: "cm1",
      details: { id: "subagent_1", description: "Search routes" },
    };
    const endEntry1 = {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Discovered 5 endpoints in routes/api.ts" }],
      },
    };
    const label1 = formatSubagentForkLabel(cmEntry1, endEntry1);
    expect(label1).toBe("[Subagent subagent_1: Search routes] → Discovered 5 endpoints in routes/api.ts");

    // With summary fallback
    const cmEntry2 = {
      id: "cm2",
      details: { id: "subagent_2", task: "Run benchmark tests" },
      content: "<subagent>All 10 benchmark tests passed</subagent>",
    };
    const label2 = formatSubagentForkLabel(cmEntry2, undefined);
    expect(label2).toContain("[Subagent subagent_2: Run benchmark tests]");
    expect(label2).toContain("All 10 benchmark tests passed");
    expect(label2).not.toContain("<subagent>");
  });

  it("is idempotent when installSubagentForkSupport is invoked repeatedly", () => {
    expect(() => {
      installSubagentForkSupport();
      installSubagentForkSupport();
      installSubagentForkSupport();
    }).not.toThrow();
  });

  it("integrates with real Pi AgentSession and AgentSessionRuntime to fork background subagent turns", async () => {
    const services = await createAgentSessionServices({ cwd: tmpDir });
    const { session } = await createAgentSessionFromServices({ services });

    const runtime = new AgentSessionRuntime(session, services, async (opts) => {
      const { session: sess } = await createAgentSessionFromServices({
        services,
        sessionManager: opts.sessionManager,
      });
      return { session: sess, services, diagnostics: [] };
    });

    const sm = session.sessionManager;

    // Simulate Turn 1: User message U1 -> Assistant message A1
    const u1Id = sm.appendMessage({ role: "user", content: [{ type: "text", text: "Launch test subagent" }] });
    const a1Id = sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "Launched subagent in background." }] });

    // Simulate Background Subagent Completion: record entry -> custom message CM1 -> Assistant reply A2
    sm.appendCustomEntry("subagent_record", { id: "sub_bg_1", task: "Explore auth module" });
    const cm1Id = sm.appendCustomMessageEntry(
      "subagent-response",
      "<subagent>Discovered 3 auth controllers</subagent>",
      true,
      { id: "sub_bg_1", description: "Explore auth", summary: "Discovered 3 auth controllers" }
    );
    const a2Id = sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Subagent finished; found 3 controllers in src/auth." }],
    });

    // 1. Verify getUserMessagesForForking includes U1 followed by CM1 as the latest choice
    const forkingMessages = session.getUserMessagesForForking();
    expect(forkingMessages.length).toBe(2);
    expect(forkingMessages[0].entryId).toBe(u1Id);
    expect(forkingMessages[0].text).toBe("Launch test subagent");

    expect(forkingMessages[1].entryId).toBe(cm1Id);
    expect(forkingMessages[1].text).toContain("[Subagent sub_bg_1: Explore auth]");
    expect(forkingMessages[1].text).toContain("Subagent finished; found 3 controllers in src/auth.");

    // 2. Fork from CM1 (as /fork does when selecting the latest subagent turn)
    const forkResult = await runtime.fork(cm1Id);
    expect(forkResult.cancelled).toBe(false);
    expect(forkResult.selectedText).toBeUndefined(); // Editor should start clean, not dump XML envelope!

    // Verify forked session has entries including U1, A1, CM1, and A2
    const forkedEntries = runtime.session.sessionManager.getEntries();
    const entryIds = forkedEntries.map((e) => e.id);
    expect(entryIds).toContain(u1Id);
    expect(entryIds).toContain(a1Id);
    expect(entryIds).toContain(cm1Id);
    expect(entryIds).toContain(a2Id);

    // Verify leaf entry of forked session is A2
    const leaf = runtime.session.sessionManager.getLeafEntry();
    expect(leaf?.id).toBe(a2Id);

    // 3. Fork from U1 (verifying standard user message forking is intact)
    const forkU1Result = await runtime.fork(u1Id);
    expect(forkU1Result.cancelled).toBe(false);
    expect(forkU1Result.selectedText).toBe("Launch test subagent");
    const u1ForkedEntries = runtime.session.sessionManager.getEntries();
    const u1ForkedIds = u1ForkedEntries.map((e) => e.id);
    expect(u1ForkedIds).not.toContain(u1Id); // Rewound before U1
    expect(u1ForkedIds).not.toContain(cm1Id);
  });

  it("handles multi-subagent and subsequent user turns (U1 -> A1 -> CM1 -> A2 -> U2 -> A3)", async () => {
    const services = await createAgentSessionServices({ cwd: tmpDir });
    const { session } = await createAgentSessionFromServices({ services });

    const runtime = new AgentSessionRuntime(session, services, async (opts) => {
      const { session: sess } = await createAgentSessionFromServices({
        services,
        sessionManager: opts.sessionManager,
      });
      return { session: sess, services, diagnostics: [] };
    });

    const sm = session.sessionManager;

    // Turn 1
    const u1Id = sm.appendMessage({ role: "user", content: [{ type: "text", text: "Run subagent 1" }] });
    const a1Id = sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "Started subagent 1" }] });
    const cm1Id = sm.appendCustomMessageEntry("subagent-response", "<subagent>1 done</subagent>", true, {
      id: "sub_1",
      description: "Task 1",
    });
    const a2Id = sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "Answer 1" }] });

    // Turn 2
    const u2Id = sm.appendMessage({ role: "user", content: [{ type: "text", text: "Run subagent 2" }] });
    const a3Id = sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "Started subagent 2" }] });
    const cm2Id = sm.appendCustomMessageEntry("subagent-response", "<subagent>2 done</subagent>", true, {
      id: "sub_2",
      description: "Task 2",
    });
    const a4Id = sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "Answer 2" }] });

    // Verify getUserMessagesForForking returns all 4 in exact chronological sequence
    const forkingMessages = session.getUserMessagesForForking();
    expect(forkingMessages.length).toBe(4);
    expect(forkingMessages.map((m) => m.entryId)).toEqual([u1Id, cm1Id, u2Id, cm2Id]);

    // Fork from CM1 (subagent 1 turn)
    const forkCM1Result = await runtime.fork(cm1Id);
    expect(forkCM1Result.cancelled).toBe(false);
    expect(forkCM1Result.selectedText).toBeUndefined();

    // The forked session must contain up to A2, and must NOT contain U2, A3, CM2, or A4
    const entries = runtime.session.sessionManager.getEntries();
    const ids = entries.map((e) => e.id);
    expect(ids).toContain(u1Id);
    expect(ids).toContain(a1Id);
    expect(ids).toContain(cm1Id);
    expect(ids).toContain(a2Id);
    expect(ids).not.toContain(u2Id);
    expect(ids).not.toContain(a3Id);
    expect(ids).not.toContain(cm2Id);
    expect(ids).not.toContain(a4Id);
  });
});
