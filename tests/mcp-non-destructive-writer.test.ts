import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeClaudeDesktopServer } from "../src/mcp/parsers/claude-desktop";
import { writeClaudeCodeServer } from "../src/mcp/parsers/claude-code";
import { writeCodexTomlServer } from "../src/mcp/parsers/codex-toml";
import { writeAntigravityServer } from "../src/mcp/parsers/antigravity";
import type { UnifiedMcpServer } from "../src/mcp/types";

describe("MCP Non-Destructive Writers", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ocx-mcp-non-destruct-test-"));
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("preserves non-MCP top-level keys in Claude Desktop config", () => {
    const configPath = join(tempDir, "claude_desktop_config.json");
    const initialConfig = {
      preferences: {
        theme: "dark",
        fontSize: 14,
        allowTelemetry: false,
      },
      globalShortcut: "Ctrl+Space",
      customModelEndpoints: ["http://127.0.0.1:8000"],
      mcpServers: {
        existing: {
          command: "existing-cmd",
          args: ["--flag"],
          env: { K1: "V1" },
          disabled: false,
        },
      },
    };
    writeFileSync(configPath, JSON.stringify(initialConfig, null, 2), "utf8");

    const newServer: UnifiedMcpServer = {
      id: "added-server",
      client: "claude_desktop",
      scope: "global",
      transport: "stdio",
      command: "node",
      args: ["./server.js"],
      env: { PORT: "3000" },
      enabled: true,
    };

    writeClaudeDesktopServer(configPath, newServer);

    const updated = JSON.parse(readFileSync(configPath, "utf8"));
    expect(updated.preferences).toEqual(initialConfig.preferences);
    expect(updated.globalShortcut).toBe("Ctrl+Space");
    expect(updated.customModelEndpoints).toEqual(["http://127.0.0.1:8000"]);
    expect(updated.mcpServers.existing).toEqual(initialConfig.mcpServers.existing);
    expect(updated.mcpServers["added-server"].command).toBe("node");

    // Test deleting existing server
    writeClaudeDesktopServer(configPath, { ...newServer, id: "existing" }, { remove: true });
    const afterDelete = JSON.parse(readFileSync(configPath, "utf8"));
    expect(afterDelete.preferences).toEqual(initialConfig.preferences);
    expect(afterDelete.mcpServers.existing).toBeUndefined();
    expect(afterDelete.mcpServers["added-server"]).toBeDefined();
  });

  it("preserves all 40+ user setting keys in ~/.claude.json", () => {
    const configPath = join(tempDir, ".claude.json");
    const initialConfig: Record<string, unknown> = {
      userID: "user_abc123xyz",
      numOpens: 42,
      hasCompletedOnboarding: true,
      theme: "system",
      autoUpdaterStatus: "enabled",
      preferredNotifChannel: "terminal_bell",
      mcpApprovals: {
        "server-1": ["tool-a", "tool-b"],
      },
      projects: {
        "/Users/test/work/proj1": {
          lastOpened: 1725000000,
          customInstructions: "Use TypeScript strict mode",
        },
        "/Users/test/work/proj2": {
          lastOpened: 1725001000,
        },
      },
      model: "claude-3-7-sonnet-20250219",
      fallbackModel: "claude-3-5-haiku-20241022",
      promptSuggestions: false,
      editorMode: "vim",
      oauthAccount: {
        email: "engineer@company.com",
        tenant: "corp",
      },
      mcpServers: {
        prior: {
          type: "stdio",
          command: "prior-cli",
          args: [],
          env: {},
        },
      },
    };

    // Generate 30 additional arbitrary user settings to simulate full 40+ keys
    for (let i = 1; i <= 30; i++) {
      initialConfig[`settingKey_${i}`] = `value_${i}_${i * 100}`;
    }

    writeFileSync(configPath, JSON.stringify(initialConfig, null, 2), "utf8");

    const newServer: UnifiedMcpServer = {
      id: "new-agent",
      client: "claude_code",
      scope: "global",
      transport: "stdio",
      command: "bun",
      args: ["run", "mcp.ts"],
      env: { NODE_ENV: "production" },
      cwd: "/app",
      enabled: true,
    };

    writeClaudeCodeServer(configPath, newServer);

    const updated = JSON.parse(readFileSync(configPath, "utf8"));
    expect(updated.userID).toBe("user_abc123xyz");
    expect(updated.numOpens).toBe(42);
    expect(updated.hasCompletedOnboarding).toBe(true);
    expect(updated.projects).toEqual(initialConfig.projects);
    expect(updated.oauthAccount).toEqual(initialConfig.oauthAccount);

    for (let i = 1; i <= 30; i++) {
      expect(updated[`settingKey_${i}`]).toBe(`value_${i}_${i * 100}`);
    }

    expect(updated.mcpServers.prior).toBeDefined();
    expect(updated.mcpServers["new-agent"]).toBeDefined();
    expect(updated.mcpServers["new-agent"].type).toBe("stdio");
  });

  it("preserves surrounding TOML tables, array of tables, and comments in ~/.codex/config.toml", () => {
    const configPath = join(tempDir, "config.toml");
    const initialToml = `# Codex Configuration File
model = "gpt-4o"
sqlite_home = "/Users/test/.codex/sqlite"

# Provider setup
[model_providers.custom_proxy]
base_url = "http://127.0.0.1:8080/v1"
api_key = "sk-test-secret-key"
stream = true

# Plugins
[plugins]
enabled = true
auto_update = false

# Array of skill configs
[[skills.config]]
path = "/Users/test/.codex/skills/skill-a/SKILL.md"
enabled = true

[[skills.config]]
path = "/Users/test/.codex/skills/skill-b/SKILL.md"
enabled = false

# Existing MCP server
[mcp_servers.existing_server]
command = "npx"
args = ["-y", "existing-mcp"]
enabled = true

[mcp_servers.existing_server.env]
LOG_LEVEL = "debug"
`;
    writeFileSync(configPath, initialToml, "utf8");

    const newServer: UnifiedMcpServer = {
      id: "added_service",
      client: "codex",
      scope: "global",
      transport: "stdio",
      command: "uvx",
      args: ["added-mcp-tool"],
      cwd: "/Users/test/proj",
      env: { TOOL_API_KEY: "secret_123" },
      enabled: true,
      timeoutSec: 90,
    };

    // Add new server
    writeCodexTomlServer(configPath, newServer);

    const updatedContent = readFileSync(configPath, "utf8");
    expect(updatedContent).toContain('model = "gpt-4o"');
    expect(updatedContent).toContain("[model_providers.custom_proxy]");
    expect(updatedContent).toContain('api_key = "sk-test-secret-key"');
    expect(updatedContent).toContain("[plugins]");
    expect(updatedContent).toContain("[[skills.config]]");
    expect(updatedContent).toContain('path = "/Users/test/.codex/skills/skill-a/SKILL.md"');
    expect(updatedContent).toContain('path = "/Users/test/.codex/skills/skill-b/SKILL.md"');
    expect(updatedContent).toContain("[mcp_servers.existing_server]");
    expect(updatedContent).toContain("[mcp_servers.added_service]");
    expect(updatedContent).toContain('TOOL_API_KEY = "secret_123"');
    expect(updatedContent).toContain("startup_timeout_sec = 90");

    // Verify it parses cleanly with Bun.TOML
    const parsed = Bun.TOML.parse(updatedContent) as Record<string, unknown>;
    expect(parsed.model).toBe("gpt-4o");
    expect((parsed.model_providers as Record<string, unknown>).custom_proxy).toBeDefined();
    expect(Array.isArray((parsed.skills as Record<string, unknown>).config)).toBe(true);
    expect(((parsed.skills as Record<string, unknown>).config as unknown[])).toHaveLength(2);
    expect((parsed.mcp_servers as Record<string, unknown>).existing_server).toBeDefined();
    expect((parsed.mcp_servers as Record<string, unknown>).added_service).toBeDefined();

    // Now delete the existing server and verify surrounding tables still remain
    writeCodexTomlServer(configPath, { ...newServer, id: "existing_server" }, { remove: true });

    const contentAfterDelete = readFileSync(configPath, "utf8");
    const parsedAfterDelete = Bun.TOML.parse(contentAfterDelete) as Record<string, unknown>;
    expect((parsedAfterDelete.mcp_servers as Record<string, unknown>).existing_server).toBeUndefined();
    expect((parsedAfterDelete.mcp_servers as Record<string, unknown>).added_service).toBeDefined();
    expect((parsedAfterDelete.model_providers as Record<string, unknown>).custom_proxy).toBeDefined();
    expect(((parsedAfterDelete.skills as Record<string, unknown>).config as unknown[])).toHaveLength(2);
  });

  it("preserves non-MCP keys in Antigravity mcp_config.json", () => {
    const configPath = join(tempDir, "mcp_config.json");
    const initialConfig = {
      version: "1.0",
      workspaceName: "MyWorkspace",
      securitySettings: {
        sandboxLevel: "strict",
      },
      mcpServers: {
        tool1: {
          command: "tool1",
          args: [],
          env: {},
        },
      },
    };
    writeFileSync(configPath, JSON.stringify(initialConfig, null, 2), "utf8");

    const newServer: UnifiedMcpServer = {
      id: "tool2",
      client: "antigravity",
      scope: "project",
      transport: "sse",
      url: "https://remote.mcp/sse",
      args: [],
      env: {},
      enabled: true,
    };

    writeAntigravityServer(configPath, newServer);

    const updated = JSON.parse(readFileSync(configPath, "utf8"));
    expect(updated.version).toBe("1.0");
    expect(updated.workspaceName).toBe("MyWorkspace");
    expect(updated.securitySettings.sandboxLevel).toBe("strict");
    expect(updated.mcpServers.tool1).toBeDefined();
    expect(updated.mcpServers.tool2).toBeDefined();
    expect(updated.mcpServers.tool2.serverUrl).toBe("https://remote.mcp/sse");
  });
});
