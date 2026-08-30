/** @jsxImportSource react */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  readPageFromHash,
  hashBelongsToPage,
  resolveAppHashChange,
  SKILLS_TAB_HASHES,
  VALID_PAGES,
} from "../src/app-routing";
import MarkdownPreview from "../src/pages/skills-mcp/MarkdownPreview";
import SkillsMcp from "../src/pages/SkillsMcp";
import SkillsTab from "../src/pages/skills-mcp/SkillsTab";
import McpTab from "../src/pages/skills-mcp/McpTab";
import SkillDetailModal from "../src/pages/skills-mcp/SkillDetailModal";
import SkillsTrashModal from "../src/pages/skills-mcp/SkillsTrashModal";
import McpServerDialog from "../src/pages/skills-mcp/McpServerDialog";
import McpCloneDialog from "../src/pages/skills-mcp/McpCloneDialog";
import { LanguageProvider } from "../src/i18n/provider";
import type { SkillItem, UnifiedMcpServer, TrashRecord } from "../src/pages/skills-mcp/skills-mcp-types";

const globals = ["document", "window", "navigator", "localStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let active: Root | null = null;

const MOCK_SKILLS: SkillItem[] = [
  {
    name: "git-helper",
    path: "/home/.agents/skills/git-helper",
    isSymlink: false,
    content: "# Git Helper\n\nAutomate standard git workflows.\n\n```bash\ngit status\n```",
    linkedAgents: ["claude", "codex"],
    metadata: {
      name: "git-helper",
      description: "Automate git branch and PR tasks",
      tags: ["git", "workflow"],
      version: "1.2.0",
      author: "OpenCodex Team",
      disabled: false,
    },
  },
  {
    name: "doc-gen",
    path: "/home/.claude/skills/doc-gen",
    isSymlink: true,
    targetPath: "/home/.agents/skills/doc-gen",
    content: "# Doc Generator\n\nGenerate high quality documentation.",
    linkedAgents: ["claude", "antigravity"],
    metadata: {
      name: "doc-gen",
      description: "Auto-generate API documentation",
      tags: ["docs"],
      version: "0.9.0",
      author: "Community",
      disabled: true,
    },
  },
  {
    name: "system-imagegen",
    path: "/home/.codex/skills/.system/system-imagegen",
    isSymlink: false,
    isSystem: true,
    content: "# System Skill",
    linkedAgents: ["codex"],
    metadata: {
      name: "system-imagegen",
      description: "Builtin Codex runtime tool",
      tags: ["system"],
      version: "1.0.0",
      disabled: false,
    },
  },
];

const MOCK_TRASH: TrashRecord[] = [
  {
    trashId: "2026-08-30T10-00-00Z_old-skill",
    skillName: "old-skill",
    originalPath: "/home/.agents/skills/old-skill",
    deletedAt: "2026-08-30T10:00:00.000Z",
    linkedClients: ["claude"],
  },
];

const MOCK_MCP_SERVERS: UnifiedMcpServer[] = [
  {
    id: "memory",
    client: "codex",
    scope: "global",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
    env: { DEBUG: "true", API_KEY: "secret_123" },
    cwd: "/Users/dev",
    enabled: true,
  },
  {
    id: "context7",
    client: "claude_code",
    scope: "global",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@upstash/context7-mcp"],
    env: {},
    enabled: false,
  },
  {
    id: "remote-docs",
    client: "claude_desktop",
    scope: "global",
    transport: "sse",
    url: "https://mcp.example.com/sse",
    args: [],
    env: { AUTH_HEADER: "Bearer token_xyz" },
    enabled: true,
  },
  {
    id: "fast-context",
    client: "antigravity",
    scope: "global",
    transport: "stdio",
    command: "npx",
    args: ["-y", "fast-context-mcp@latest"],
    env: {},
    enabled: true,
  },
];

beforeEach(() => {
  previousGlobals = Object.fromEntries(
    globals.map(key => [key, Reflect.get(globalThis, key)])
  ) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#skills" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (active) {
    const root = active;
    active = null;
    await act(async () => {
      root.unmount();
    });
  }
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function enterInput(input: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const proto = input instanceof testWindow.HTMLTextAreaElement
      ? testWindow.HTMLTextAreaElement.prototype
      : testWindow.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
    input.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
  });
}

async function mountComponent(node: React.ReactNode): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  active = createRoot(container);
  await act(async () => {
    active?.render(<LanguageProvider>{node}</LanguageProvider>);
  });
  return container;
}

describe("1. Skills & MCP Routing Contracts", () => {
  test("Page union and VALID_PAGES contain skills", () => {
    expect(VALID_PAGES.has("skills")).toBe(true);
    expect(readPageFromHash("#skills")).toBe("skills");
    expect(readPageFromHash("#skills/skills")).toBe("skills");
    expect(readPageFromHash("#skills/mcp")).toBe("skills");
  });

  test("SKILLS_TAB_HASHES contains sub-tab routes", () => {
    expect(SKILLS_TAB_HASHES).toContain("skills/skills");
    expect(SKILLS_TAB_HASHES).toContain("skills/mcp");
  });

  test("hashBelongsToPage validates skills routes", () => {
    expect(hashBelongsToPage("skills", "skills")).toBe(true);
    expect(hashBelongsToPage("skills/skills", "skills")).toBe(true);
    expect(hashBelongsToPage("skills/mcp", "skills")).toBe(true);
    expect(hashBelongsToPage("skills/invalid", "skills")).toBe(false);
  });

  test("resolveAppHashChange retains valid skills sub-tabs", () => {
    expect(resolveAppHashChange("skills")).toEqual({ page: "skills", replaceTo: null });
    expect(resolveAppHashChange("skills/mcp")).toEqual({ page: "skills", replaceTo: null });
    expect(resolveAppHashChange("skills/skills")).toEqual({ page: "skills", replaceTo: null });
    expect(resolveAppHashChange("skills/bogus")).toEqual({ page: "skills", replaceTo: "skills" });
  });
});

describe("2. MarkdownPreview Component", () => {
  test("renders headers, code blocks, lists, bold, inline code, and tables", async () => {
    const md = [
      "# Header 1",
      "## Header 2",
      "### Header 3",
      "**bold text** and `inline code` and [link](https://example.com)",
      "> A wise quote",
      "- item 1",
      "- item 2",
      "1. ordered 1",
      "2. ordered 2",
      "```ts",
      "const a = 42;",
      "```",
      "| Col A | Col B |",
      "| --- | --- |",
      "| val1 | val2 |",
    ].join("\n");

    const container = await mountComponent(<MarkdownPreview content={md} />);
    expect(container.querySelector(".md-h1")?.textContent).toBe("Header 1");
    expect(container.querySelector(".md-h2")?.textContent).toBe("Header 2");
    expect(container.querySelector(".md-h3")?.textContent).toBe("Header 3");
    expect(container.querySelector("strong")?.textContent).toBe("bold text");
    expect(container.querySelector(".md-inline-code")?.textContent).toBe("inline code");
    expect(container.querySelector("a.md-link")?.getAttribute("href")).toBe("https://example.com");
    expect(container.querySelector(".md-blockquote")?.textContent).toContain("A wise quote");
    expect(container.querySelectorAll(".md-ul li").length).toBe(2);
    expect(container.querySelectorAll(".md-ol li").length).toBe(2);
    expect(container.querySelector(".md-code-block")?.textContent).toContain("const a = 42;");
    expect(container.querySelector(".md-code-lang")?.textContent).toBe("ts");
    expect(container.querySelectorAll(".md-table tr").length).toBe(2);
  });

  test("renders empty fallback when content is blank", async () => {
    const container = await mountComponent(<MarkdownPreview content="" />);
    expect(container.textContent).toContain("No content provided");
  });
});

describe("3. SkillsMcp Page Shell and Sub-Tabs", () => {
  test("renders tab strip and allows switching between Skills and MCP", async () => {
    globalThis.fetch = (async (url: string) => {
      if (url.includes("/api/skills")) return new Response(JSON.stringify({ skills: MOCK_SKILLS }));
      if (url.includes("/api/mcp")) return new Response(JSON.stringify({ servers: MOCK_MCP_SERVERS }));
      return new Response(JSON.stringify({}));
    }) as typeof fetch;

    const container = await mountComponent(<SkillsMcp apiBase="http://localhost:10100" />);
    
    // Check page header
    expect(container.querySelector(".page-head h2")?.textContent).toContain("Skills & MCP");
    
    // Check sub-tabs
    const tabs = container.querySelectorAll('.page-tab');
    expect(tabs.length).toBe(2);
    expect(tabs[0].textContent).toContain("Skills");
    expect(tabs[1].textContent).toContain("MCP");

    // Click MCP tab
    await act(async () => {
      (tabs[1] as HTMLButtonElement).click();
    });

    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    expect(window.location.hash).toBe("#skills/mcp");
  });
});

describe("4. SkillsTab Component", () => {
  let fetchCalls: Array<{ url: string; method?: string; body?: string }> = [];

  beforeEach(() => {
    fetchCalls = [];
    globalThis.fetch = (async (url: string, opts?: RequestInit) => {
      fetchCalls.push({
        url,
        method: opts?.method || "GET",
        body: opts?.body as string,
      });

      if (url.endsWith("/api/skills") && opts?.method === "POST") {
        return new Response(JSON.stringify({ ok: true, skill: MOCK_SKILLS[0] }));
      }
      if (url.includes("/api/skills/") && opts?.method === "PUT") {
        return new Response(JSON.stringify({ ok: true, skill: MOCK_SKILLS[0] }));
      }
      if (url.includes("/api/skills/") && opts?.method === "DELETE") {
        return new Response(JSON.stringify({ ok: true, trashId: "trash-1" }));
      }
      if (url.includes("/toggle") && opts?.method === "POST") {
        return new Response(JSON.stringify({ ok: true, enabled: true }));
      }
      if (url.endsWith("/api/skills/sync") && opts?.method === "POST") {
        return new Response(JSON.stringify({ synced: 5, migrated: ["git-helper"], deduped: ["doc-gen"], broken: [], conflicts: [] }));
      }
      if (url.endsWith("/api/skills/trash/restore") && opts?.method === "POST") {
        return new Response(JSON.stringify({ ok: true, restored: "old-skill" }));
      }
      if (url.endsWith("/api/skills/trash")) {
        return new Response(JSON.stringify({ items: MOCK_TRASH }));
      }
      if (url.endsWith("/api/skills")) {
        return new Response(JSON.stringify({ skills: MOCK_SKILLS }));
      }
      return new Response(JSON.stringify({}));
    }) as typeof fetch;
  });

  test("renders skills table and handles search filtering", async () => {
    const container = await mountComponent(<SkillsTab apiBase="http://localhost:10100" active={true} />);
    
    // Wait for data load
    await act(async () => {
      await new Promise(r => setTimeout(r, 20));
    });

    const rows = container.querySelectorAll(".skills-tbl tbody tr");
    expect(rows.length).toBe(3);
    expect(container.textContent).toContain("git-helper");
    expect(container.textContent).toContain("doc-gen");
    expect(container.textContent).toContain("system-imagegen");

    // Search for "git"
    const searchInput = container.querySelector(".skills-search-input") as HTMLInputElement;
    await enterInput(searchInput, "git");

    const filteredRows = container.querySelectorAll(".skills-tbl tbody tr");
    expect(filteredRows.length).toBe(1);
    expect(filteredRows[0].textContent).toContain("git-helper");
  });

  test("toggles a skill on click", async () => {
    const container = await mountComponent(<SkillsTab apiBase="http://localhost:10100" active={true} />);
    await act(async () => {
      await new Promise(r => setTimeout(r, 20));
    });

    const switches = container.querySelectorAll(".skills-tbl .switch");
    expect(switches.length).toBe(3);

    await act(async () => {
      (switches[0] as HTMLButtonElement).click();
    });

    const toggleCall = fetchCalls.find(c => c.url.includes("/toggle"));
    expect(toggleCall).toBeDefined();
    expect(toggleCall?.method).toBe("POST");
  });

  test("runs Sync All Symlinks on button click", async () => {
    const container = await mountComponent(<SkillsTab apiBase="http://localhost:10100" active={true} />);
    await act(async () => {
      await new Promise(r => setTimeout(r, 20));
    });

    const syncBtn = container.querySelector(".skills-toolbar-actions button") as HTMLButtonElement;
    expect(syncBtn.textContent).toContain("Sync All Symlinks");

    await act(async () => {
      syncBtn.click();
    });

    const syncCall = fetchCalls.find(c => c.url.endsWith("/api/skills/sync"));
    expect(syncCall).toBeDefined();
    expect(syncCall?.method).toBe("POST");
  });
});

describe("5. SkillDetailModal Component", () => {
  test("creates a new skill with validation", async () => {
    let savedData: unknown = null;
    const container = await mountComponent(
      <SkillDetailModal
        skill={null}
        isOpen={true}
        isCreateMode={true}
        onClose={() => {}}
        onSave={async (d) => { savedData = d; }}
      />
    );

    expect(container.querySelector("#skill-modal-title")?.textContent).toContain("Create New Skill");

    const nameInput = container.querySelector("#skill-field-name") as HTMLInputElement;
    const descInput = container.querySelector("#skill-field-desc") as HTMLInputElement;
    const submitBtn = container.querySelector("button[type='submit']") as HTMLButtonElement;

    await enterInput(nameInput, "my-new-skill");
    await enterInput(descInput, "Test description");

    await act(async () => {
      submitBtn.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(savedData).toEqual({
      name: "my-new-skill",
      description: "Test description",
      tags: [],
      version: "1.0.0",
      author: "",
      content: "# New Skill\n\nProvide clear instructions and triggers for this skill.\n",
      disabled: false,
    });
  });

  test("edits an existing skill and switches views", async () => {
    const container = await mountComponent(
      <SkillDetailModal
        skill={MOCK_SKILLS[0]}
        isOpen={true}
        isCreateMode={false}
        onClose={() => {}}
        onSave={async () => {}}
        onDelete={async () => {}}
      />
    );

    expect(container.querySelector("#skill-modal-title")?.textContent).toContain("git-helper");
    expect((container.querySelector("#skill-field-name") as HTMLInputElement).value).toBe("git-helper");

    // Segmented view controls: Switch to preview only
    const segBtns = container.querySelectorAll(".segmented-btn");
    expect(segBtns.length).toBe(3);

    await act(async () => {
      (segBtns[2] as HTMLButtonElement).click();
    });

    expect(container.querySelector(".skill-preview-pane")).not.toBeNull();
    expect(container.querySelector(".skill-editor-pane")).toBeNull();
  });
});

describe("6. SkillsTrashModal Component", () => {
  test("renders trash items and triggers restore", async () => {
    let restoredTrashId: string | null = null;
    const container = await mountComponent(
      <SkillsTrashModal
        isOpen={true}
        trashItems={MOCK_TRASH}
        isLoading={false}
        onClose={() => {}}
        onRestore={async (id) => { restoredTrashId = id; }}
        onRefresh={async () => {}}
      />
    );

    expect(container.querySelector("#skills-trash-modal-title")?.textContent).toContain("Trash & Recovery");
    expect(container.textContent).toContain("old-skill");

    const restoreBtn = container.querySelector(".trash-tbl button") as HTMLButtonElement;
    expect(restoreBtn.textContent).toContain("Restore");

    await act(async () => {
      restoreBtn.click();
    });

    expect(restoredTrashId).toBe("2026-08-30T10-00-00Z_old-skill");
  });
});

describe("7. McpTab & McpServerDialog & McpCloneDialog", () => {
  let fetchCalls: Array<{ url: string; method?: string; body?: string }> = [];

  beforeEach(() => {
    fetchCalls = [];
    globalThis.fetch = (async (url: string, opts?: RequestInit) => {
      fetchCalls.push({
        url,
        method: opts?.method || "GET",
        body: opts?.body as string,
      });

      if (url.includes("/api/mcp") && opts?.method === "POST") {
        return new Response(JSON.stringify({ ok: true, server: MOCK_MCP_SERVERS[0] }));
      }
      if (url.includes("/api/mcp/") && opts?.method === "PUT") {
        return new Response(JSON.stringify({ ok: true, server: MOCK_MCP_SERVERS[0] }));
      }
      if (url.includes("/api/mcp/") && opts?.method === "DELETE") {
        return new Response(JSON.stringify({ ok: true, message: "Deleted" }));
      }
      if (url.includes("/toggle") && opts?.method === "POST") {
        return new Response(JSON.stringify({ ok: true, enabled: false }));
      }
      if (url.endsWith("/api/mcp")) {
        return new Response(JSON.stringify({ servers: MOCK_MCP_SERVERS }));
      }
      return new Response(JSON.stringify({}));
    }) as typeof fetch;
  });

  test("renders categorized MCP server cards across 4 clients", async () => {
    const container = await mountComponent(<McpTab apiBase="http://localhost:10100" active={true} />);
    await act(async () => {
      await new Promise(r => setTimeout(r, 20));
    });

    const clientCards = container.querySelectorAll(".mcp-client-card");
    expect(clientCards.length).toBe(4);

    expect(container.textContent).toContain("Claude Desktop");
    expect(container.textContent).toContain("Claude Code");
    expect(container.textContent).toContain("OpenAI Codex");
    expect(container.textContent).toContain("Antigravity / Gemini");

    expect(container.textContent).toContain("memory");
    expect(container.textContent).toContain("context7");
    expect(container.textContent).toContain("remote-docs");
    expect(container.textContent).toContain("fast-context");
  });

  test("toggles MCP server enabled state", async () => {
    const container = await mountComponent(<McpTab apiBase="http://localhost:10100" active={true} />);
    await act(async () => {
      await new Promise(r => setTimeout(r, 20));
    });

    const switches = container.querySelectorAll(".mcp-server-item .switch");
    expect(switches.length).toBe(4);

    await act(async () => {
      (switches[0] as HTMLButtonElement).click();
    });

    const toggleCall = fetchCalls.find(c => c.url.includes("/toggle"));
    expect(toggleCall).toBeDefined();
    expect(toggleCall?.method).toBe("POST");
  });

  test("adds a new MCP server via McpServerDialog", async () => {
    let savedData: unknown = null;
    const container = await mountComponent(
      <McpServerDialog
        isOpen={true}
        server={null}
        defaultClient="claude_code"
        isCreateMode={true}
        onClose={() => {}}
        onSave={async (d) => { savedData = d; }}
      />
    );

    expect(container.querySelector("#mcp-dialog-title")?.textContent).toContain("Add MCP Server");

    const idInput = container.querySelector("#mcp-server-id") as HTMLInputElement;
    const cmdInput = container.querySelector("#mcp-command") as HTMLInputElement;
    const submitBtn = container.querySelector("button[type='submit']") as HTMLButtonElement;

    await enterInput(idInput, "my-tool");
    await enterInput(cmdInput, "uvx");

    await act(async () => {
      submitBtn.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(savedData).toEqual({
      client: "claude_code",
      id: "my-tool",
      transport: "stdio",
      command: "uvx",
      args: ["-y"],
      env: {},
      cwd: undefined,
      url: undefined,
      enabled: true,
    });
  });

  test("clones an MCP server to another client via McpCloneDialog", async () => {
    let clonedOptions: unknown = null;
    const container = await mountComponent(
      <McpCloneDialog
        isOpen={true}
        sourceServer={MOCK_MCP_SERVERS[0]} // Codex "memory"
        onClose={() => {}}
        onClone={async (opts) => { clonedOptions = opts; }}
      />
    );

    expect(container.querySelector("#mcp-clone-title")?.textContent).toContain("Clone MCP Server");
    expect(container.textContent).toContain("memory");

    const submitBtn = container.querySelector("button[type='submit']") as HTMLButtonElement;
    await act(async () => {
      submitBtn.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(clonedOptions).toEqual({
      fromClient: "codex",
      toClient: "claude_desktop",
      serverId: "memory",
      newId: undefined,
      overwrite: false,
    });
  });
});
