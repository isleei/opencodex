/**
 * ACP (Agent Client Protocol) agent endpoint — `ocx acp`.
 *
 * Exposes ocx as an external coding agent over ACP's newline-delimited JSON-RPC
 * stdio transport, so any ACP-compatible editor (Zed, JetBrains, Neovim, …) can
 * drive it with whatever model the operator routes through ocx. This is the
 * open-protocol alternative to credential-reusing upstream bridges: ocx never
 * touches vendor auth material — model calls run through the operator's own
 * configured providers.
 *
 * v1 backend: `codex exec --json` (a full tool-loop coding agent) — its JSONL
 * event stream is translated into ACP session/update notifications
 * (agent_message_chunk / agent_thought_chunk / tool_call). Because the backend
 * executes its own tools, the agent declares no fs/terminal capabilities and
 * never asks the client for permissions.
 */

import { agent, ndJsonStream, type Stream } from "@agentclientprotocol/sdk";
import { Writable, Readable } from "node:stream";
import { spawn, type ChildProcess } from "node:child_process";
import { loadConfig } from "../config";

export interface AcpAgentOptions {
  /** Pinned model ref; empty resolves to the operator's default model. */
  modelRef?: string;
  /** Backend launcher, injectable for tests. Default: `codex exec --json`. */
  backendCommand?: (prompt: string, model: string, cwd: string) => { command: string; args: string[] };
}

type SendUpdate = (update: Record<string, unknown>) => Promise<void>;

interface AcpSession {
  cwd: string;
  child: ChildProcess | null;
  cancelled: boolean;
}

export class AcpAgentCore {
  private readonly sessions = new Map<string, AcpSession>();
  private sessionCounter = 0;
  private sendUpdate: SendUpdate = async () => {};

  constructor(private readonly opts: AcpAgentOptions = {}) {}

  /** The client context becomes available only after the connection opens. */
  bindClient(notify: (method: string, params: unknown) => Promise<void>): void {
    this.sendUpdate = async (update: Record<string, unknown>) => {
      await notify("session/update", update);
    };
  }

  async defaultModelRef(): Promise<string> {
    if (this.opts.modelRef) return this.opts.modelRef;
    const config = await loadConfig();
    const providerName = config.defaultProvider;
    const provider = providerName ? config.providers?.[providerName] : undefined;
    const model = provider?.defaultModel?.trim();
    if (model) {
      if (providerName === "openai" || /^(gpt-|o[134]-)/i.test(model)) return model;
      return `${providerName}/${model}`;
    }
    // Any provider with a defaultModel — the operator maintains these as their lanes.
    for (const [name, p] of Object.entries(config.providers ?? {})) {
      const candidate = (p as { defaultModel?: string } | undefined)?.defaultModel?.trim();
      if (candidate) {
        return name === "openai" || /^(gpt-|o[134]-)/i.test(candidate) ? candidate : `${name}/${candidate}`;
      }
    }
    throw new Error(
      "no default model configured — pass --model <provider/model|combo/id|policy/id> to `ocx acp` or set a provider defaultModel",
    );
  }

  initialize(): {
    protocolVersion: number;
    agentCapabilities: { loadSession: boolean; promptCapabilities: { embeddedContext: boolean } };
    authMethods: never[];
  } {
    // No fs/terminal callbacks: the backend executes its own tools, so the editor
    // is never asked for permissions. loadSession false → clients never send
    // session/load; each session/prompt maps to one headless backend turn.
    return {
      protocolVersion: 1,
      agentCapabilities: { loadSession: false, promptCapabilities: { embeddedContext: true } },
      authMethods: [],
    };
  }

  newSession(params: { cwd?: string; mcpServers?: unknown[] }): { sessionId: string } {
    this.sessionCounter += 1;
    const sessionId = `ocx-${this.sessionCounter}-${Math.random().toString(36).slice(2, 8)}`;
    this.sessions.set(sessionId, {
      cwd: params.cwd || process.cwd(),
      child: null,
      cancelled: false,
    });
    return { sessionId };
  }

  async sessionPrompt(
    params: { sessionId: string; prompt: Array<{ type: string; text?: string }> },
  ): Promise<{ stopReason: "end_turn" | "cancelled" }> {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw new Error(`unknown session: ${params.sessionId}`);
    if (session.child) throw new Error(`session ${params.sessionId} already has a turn in flight`);

    const text = params.prompt
      .filter(block => block.type === "text" && typeof block.text === "string")
      .map(block => block.text)
      .join("\n\n");
    if (!text.trim()) throw new Error("prompt carried no text content");

    const model = await this.defaultModelRef();
    session.cancelled = false;

    // ACP session/update notifications carry {sessionId, update} on the wire.
    const sendUpdate = async (u: Record<string, unknown>) => {
      await this.sendUpdate({ sessionId: params.sessionId, update: u });
    };

    const result = await this.runBackend(text, model, session, sendUpdate);
    if (session.cancelled) return { stopReason: "cancelled" };
    if (!result.ok) {
      await sendUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `ocx acp: backend failed — ${result.error}` },
      });
    }
    return { stopReason: session.cancelled ? "cancelled" : "end_turn" };
  }

  sessionCancel(params: { sessionId: string }): void {
    const session = this.sessions.get(params.sessionId);
    if (!session) return;
    session.cancelled = true;
    session.child?.kill("SIGTERM");
  }

  /** Spawn the backend agent and translate its JSONL events into ACP updates. */
  private runBackend(
    prompt: string,
    model: string,
    session: AcpSession,
    sendUpdate: SendUpdate,
  ): Promise<{ ok: boolean; error?: string }> {
    const sendChunk = (kind: "agent_message_chunk" | "agent_thought_chunk", text: string) => {
      if (!text.trim() || session.cancelled) return;
      void sendUpdate({ sessionUpdate: kind, content: { type: "text", text } });
    };
    const sendTool = (
      toolCallId: string,
      title: string,
      kind: string,
      status: "in_progress" | "completed",
      rawInput?: unknown,
    ) => {
      if (session.cancelled) return;
      void sendUpdate({
        sessionUpdate: status === "in_progress" ? "tool_call" : "tool_call_update",
        toolCallId,
        title,
        kind,
        status,
        ...(rawInput !== undefined ? { rawInput } : {}),
      });
    };

    const launcher =
      this.opts.backendCommand ??
      ((p: string, m: string) => ({
        command: process.env.OCX_ACP_CODEX_BIN || "codex",
        args: ["exec", "--json", "--skip-git-repo-check", "-m", m, p],
      }));
    const { command, args } = launcher(prompt, model, session.cwd);

    return new Promise(resolve => {
      let child: ChildProcess;
      try {
        child = spawn(command, args, {
          cwd: session.cwd,
          shell: process.platform === "win32",
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
        return;
      }
      session.child = child;

      let settled = false;
      const finish = (result: { ok: boolean; error?: string }) => {
        if (settled) return;
        settled = true;
        session.child = null;
        resolve(result);
      };

      let buffer = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        let index = buffer.indexOf("\n");
        while (index >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (line) this.handleBackendLine(line, sendChunk, sendTool);
          index = buffer.indexOf("\n");
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        // codex exec writes human progress to stderr; surface it as thought text.
        const text = chunk.toString().trim();
        if (text && !session.cancelled) sendChunk("agent_thought_chunk", text.slice(0, 2000));
      });
      child.on("error", err => finish({ ok: false, error: err.message }));
      child.on("close", code => {
        if (session.cancelled) return finish({ ok: true });
        if (code === 0 || code === null) return finish({ ok: true });
        finish({ ok: false, error: `backend exited with code ${code}` });
      });
    });
  }

  /** Translate one codex --json event line into ACP notifications. */
  private handleBackendLine(
    line: string,
    sendChunk: (kind: "agent_message_chunk" | "agent_thought_chunk", text: string) => void,
    sendTool: (toolCallId: string, title: string, kind: string, status: "in_progress" | "completed", rawInput?: unknown) => void,
  ): void {
    let event: {
      type?: string;
      message?: string;
      item?: { id?: string; type?: string; text?: string; command?: string; status?: string; files?: Array<{ path?: string }>; summary?: string };
    };
    try {
      event = JSON.parse(line);
    } catch {
      return; // non-JSON noise on stdout is ignored
    }

    const item = event.item && typeof event.item === "object" ? event.item : undefined;
    const itemId = item?.id || `call-${Math.random().toString(36).slice(2, 8)}`;

    switch (event.type) {
      case "error":
        sendChunk("agent_message_chunk", event.message ?? "backend reported an error");
        return;
      case "item.started":
      case "item.updated":
      case "item.completed": {
        const status = (event.type === "item.completed" ? "completed" : "in_progress") as "in_progress" | "completed";
        if (!item) return;
        switch (item.type) {
          case "agent_message":
            if (event.type === "item.completed" && item.text) sendChunk("agent_message_chunk", item.text);
            return;
          case "reasoning":
            if (item.summary && event.type !== "item.completed") sendChunk("agent_thought_chunk", item.summary);
            return;
          case "command_execution":
            sendTool(itemId, item.command || "command", "execute", status, { command: item.command });
            return;
          case "file_change":
            sendTool(
              itemId,
              item.files?.map(f => f.path).filter(Boolean).join(", ") || "file change",
              "edit",
              status,
              { files: item.files },
            );
            return;
          case "mcp_tool_call":
            sendTool(itemId, "mcp tool call", "other", status);
            return;
          case "web_search":
            sendTool(itemId, "web search", "search", status);
            return;
          default:
            return;
        }
      }
      default:
        return;
    }
  }
}

/**
 * Build the ACP agent app. The connection's client context is bound into the core
 * as soon as it exists, so prompt turns can stream session/update notifications.
 */
export function buildAcpAgentApp(
  opts: AcpAgentOptions = {},
): { app: ReturnType<typeof agent>; core: AcpAgentCore } {
  const core = new AcpAgentCore(opts);
  const app = agent({ name: "ocx" });
  app
    .onRequest("initialize", () => core.initialize())
    .onRequest("session/new", ctx => core.newSession(ctx.params))
    .onRequest("authenticate", () => ({}))
    .onRequest("session/prompt", ctx => core.sessionPrompt(ctx.params))
    .onNotification("session/cancel", ctx => core.sessionCancel(ctx.params));
  app.onConnect(conn => {
    core.bindClient((method, params) => conn.client.notify(method as never, params as never));
  });
  return { app, core };
}

/** Run the ACP agent over stdio (resolves when the client disconnects). */
export async function runAcpAgentOverStdio(opts: AcpAgentOptions = {}): Promise<void> {
  // SDK stream order: the writable the agent writes (stdout) first, then the
  // readable the agent reads (stdin).
  const output = Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>;
  const input = Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>;
  const stream: Stream = ndJsonStream(output, input);
  const { app, core } = buildAcpAgentApp(opts);
  const connection = app.connect(stream);
  await connection.closed.catch(error => {
    // A client hanging up is a normal end for a stdio agent; real setup errors
    // must be visible on stderr.
    console.error("[acp] connection closed with error:", error instanceof Error ? error.message : error);
  });
}

/** `ocx acp [--model <ref>]` — parse flags and run over stdio. */
export function runAcpCli(argv: string[] = []): Promise<void> {
  let modelRef: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--model") {
      modelRef = argv[i + 1];
      i++;
    }
  }
  return runAcpAgentOverStdio({ modelRef });
}
