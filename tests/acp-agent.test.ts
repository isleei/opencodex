import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AcpAgentCore, buildAcpAgentApp } from "../src/acp/agent";

/**
 * The backend stub is a real child process emitting codex --json events, so the
 * spawn → parse → translate path runs for real; only the codex binary itself is
 * faked.
 */
const BACKEND_STUB = `
console.log(JSON.stringify({ type: "item.started", item: { id: "t1", type: "command_execution", command: "echo hi", status: "in_progress" } }));
console.log(JSON.stringify({ type: "item.completed", item: { id: "t1", type: "command_execution", command: "echo hi", status: "completed" } }));
console.log(JSON.stringify({ type: "item.completed", item: { id: "m1", type: "agent_message", text: "HELLO FROM BACKEND" } }));
`;

const BACKEND_SLOW = `
await new Promise(r => setTimeout(r, 30000));
console.log(JSON.stringify({ type: "item.completed", item: { id: "m1", type: "agent_message", text: "too late" } }));
`;

describe("ACP agent endpoint", () => {
  const base = mkdtempSync(join(tmpdir(), "ocx-acp-test-"));
  const updates: Array<Record<string, any>> = [];
  const conn = { sessionUpdate: async (u: any) => { updates.push(u); } };

  afterAll(() => {
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test("initialize negotiates protocol v1 with no fs/terminal capabilities", () => {
    const { core } = buildAcpAgentApp({});
    const res = core.initialize();
    expect(res.protocolVersion).toBe(1);
    expect(res.agentCapabilities.loadSession).toBe(false);
    expect(res.authMethods.length).toBe(0);
  });

  test("prompt drives the stub backend and translates codex events into ACP updates", async () => {
    const core = new AcpAgentCore({
      modelRef: "xai/grok-4.5",
      backendCommand: (prompt, model) => {
        expect(model).toBe("xai/grok-4.5");
        expect(prompt).toContain("do the thing");
        return { command: process.execPath, args: ["-e", BACKEND_STUB] };
      },
    });
    core.bindClient((method, params) => {
      if (method === "session/update") updates.push(params as Record<string, any>);
      return Promise.resolve();
    });
    const { sessionId } = core.newSession({ cwd: base });

    const res = await core.sessionPrompt({
      sessionId,
      prompt: [{ type: "text", text: "do the thing" }],
    });
    expect(res.stopReason).toBe("end_turn");

    const kinds = updates.map(u => u.update.sessionUpdate);
    expect(kinds).toContain("tool_call");
    expect(kinds).toContain("tool_call_update");
    expect(kinds).toContain("agent_message_chunk");

    const tool = updates.find(u => u.update.sessionUpdate === "tool_call");
    expect(tool.update.title).toBe("echo hi");
    expect(tool.update.kind).toBe("execute");
    expect(tool.sessionId).toBe(sessionId);

    const message = updates.find(u => u.update.sessionUpdate === "agent_message_chunk");
    expect(message.update.content.text).toBe("HELLO FROM BACKEND");
  });

  test("session/cancel interrupts a running backend turn", async () => {
    const core = new AcpAgentCore({
      modelRef: "xai/grok-4.5",
      backendCommand: () => ({ command: process.execPath, args: ["-e", BACKEND_SLOW] }),
    });
    core.bindClient((method, params) => {
      if (method === "session/update") updates.push(params as Record<string, any>);
      return Promise.resolve();
    });
    const { sessionId } = core.newSession({ cwd: base });

    const pending = core.sessionPrompt({
      sessionId,
      prompt: [{ type: "text", text: "slow turn" }],
    });
    await Bun.sleep(100);
    core.sessionCancel({ sessionId });
    const res = await pending;
    expect(res.stopReason).toBe("cancelled");
  });

  test("full stdio loop: spawn ocx acp and speak newline-delimited JSON-RPC", async () => {
    const proc = Bun.spawn([process.execPath, "run", "src/cli/index.ts", "acp", "--model", "xai/grok-4.5"], {
      cwd: join(import.meta.dir, ".."),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    const pending = new Map<number, (value: any) => void>();
    const notifications: Array<Record<string, any>> = [];
    let stderrSeen = "";
    void new Response(proc.stderr).text().then(t => { stderrSeen = t; });
    let lineBuffer = "";
    const reader = (async () => {
      const stream = proc.stdout.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await stream.read();
        if (done) return;
        lineBuffer += decoder.decode(value, { stream: true });
        let index = lineBuffer.indexOf("\n");
        while (index >= 0) {
          const line = lineBuffer.slice(0, index).trim();
          lineBuffer = lineBuffer.slice(index + 1);
          if (line) {
            try {
              const msg = JSON.parse(line);
              if (msg.id && pending.has(msg.id)) {
                pending.get(msg.id)!(msg);
                pending.delete(msg.id);
              } else if (msg.method === "session/update") {
                notifications.push(msg.params);
              }
            } catch {
              // non-JSON line (banner noise) is ignored
            }
          }
          index = lineBuffer.indexOf("\n");
        }
      }
    })();

    const request = (id: number, method: string, params: Record<string, unknown>) =>
      new Promise<any>((resolve, reject) => {
        pending.set(id, resolve);
        proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`request ${id} (${method}) timed out; stderr: ${stderrSeen.slice(0, 300)}`));
          }
        }, 20_000);
      });

    try {
      const init = await request(1, "initialize", { protocolVersion: 1, clientCapabilities: {} });
      expect(init.result.protocolVersion).toBe(1);

      const created = await request(2, "session/new", { cwd: base, mcpServers: [] });
      const sessionId = created.result.sessionId;

      const promptPromise = request(3, "session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "stdio loop" }],
      });
      proc.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } }) + "\n",
      );
      const done = await promptPromise;
      expect(done.result.stopReason).toBe("cancelled");
    } finally {
      proc.kill();
    }
    void reader;
  }, 30_000);

  test("backend failures surface as an agent message and still end the turn", async () => {
    const core = new AcpAgentCore({
      modelRef: "xai/grok-4.5",
      backendCommand: () => ({ command: process.execPath, args: ["-e", "process.exit(3)"] }),
    });
    core.bindClient((method, params) => {
      if (method === "session/update") updates.push(params as Record<string, any>);
      return Promise.resolve();
    });
    const { sessionId } = core.newSession({ cwd: base });
    const res = await core.sessionPrompt({
      sessionId,
      prompt: [{ type: "text", text: "boom" }],
    });
    expect(res.stopReason).toBe("end_turn");
    const message = updates.reverse().find(u => u.update.sessionUpdate === "agent_message_chunk");
    expect(message.update.content.text).toContain("backend failed");
  });
});

