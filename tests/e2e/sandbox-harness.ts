import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, readlinkSync, symlinkSync, rmSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { SkillMetadata, SkillItem, SyncResult, TrashRecord, UnifiedMcpServer, McpClientType, McpTransportType, McpCloneOptions } from "./types";

export * from "./types";

export interface SandboxPaths {
  root: string;
  centralSkillsDir: string;
  trashSkillsDir: string;
  claudeSkillsDir: string;
  codexSkillsDir: string;
  codexSystemSkillsDir: string;
  projectSkillsDir: string;
  claudeDesktopConfigFile: string;
  claudeCodeConfigFile: string;
  claudeSettingsConfigFile: string;
  codexConfigFile: string;
  geminiConfigFile: string;
  projectAgentsConfigFile: string;
  projectDir: string;
}

export interface SandboxEnv {
  paths: SandboxPaths;
  envBackup: Record<string, string | undefined>;
  cleanup: () => void;
  createSkillFile: (dir: string, name: string, metadata: Partial<SkillMetadata>, content?: string) => string;
  readSkillFile: (dir: string, name: string) => { raw: string; metadata: SkillMetadata; body: string };
  isSymlink: (targetPath: string) => boolean;
  getSymlinkTarget: (targetPath: string) => string;
  createSymlink: (targetPath: string, linkPath: string) => void;
}

/**
 * Creates an isolated sandbox environment in tmpdir with complete directory
 * structures for Claude, Codex, Antigravity, Gemini, and Project agents.
 */
export function createSandboxEnv(options: { withSamples?: boolean } = {}): SandboxEnv {
  const root = mkdtempSync(join(tmpdir(), "ocx-e2e-sandbox-"));

  const paths: SandboxPaths = {
    root,
    centralSkillsDir: join(root, ".agents", "skills"),
    trashSkillsDir: join(root, ".agents", ".trash", "skills"),
    claudeSkillsDir: join(root, ".claude", "skills"),
    codexSkillsDir: join(root, ".codex", "skills"),
    codexSystemSkillsDir: join(root, ".codex", "skills", ".system"),
    projectDir: join(root, "my-project"),
    projectSkillsDir: join(root, "my-project", ".agents", "skills"),
    claudeDesktopConfigFile: join(root, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    claudeCodeConfigFile: join(root, ".claude.json"),
    claudeSettingsConfigFile: join(root, ".claude", "settings.json"),
    codexConfigFile: join(root, ".codex", "config.toml"),
    geminiConfigFile: join(root, ".gemini", "config", "mcp_config.json"),
    projectAgentsConfigFile: join(root, "my-project", ".agents", "mcp_config.json"),
  };

  // Ensure directories exist
  mkdirSync(paths.centralSkillsDir, { recursive: true });
  mkdirSync(paths.trashSkillsDir, { recursive: true });
  mkdirSync(paths.claudeSkillsDir, { recursive: true });
  mkdirSync(paths.codexSkillsDir, { recursive: true });
  mkdirSync(paths.codexSystemSkillsDir, { recursive: true });
  mkdirSync(paths.projectSkillsDir, { recursive: true });
  mkdirSync(dirname(paths.claudeDesktopConfigFile), { recursive: true });
  mkdirSync(dirname(paths.geminiConfigFile), { recursive: true });
  mkdirSync(dirname(paths.projectAgentsConfigFile), { recursive: true });

  const envBackup: Record<string, string | undefined> = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    OPENCODEX_HOME: process.env.OPENCODEX_HOME,
    CODEX_HOME: process.env.CODEX_HOME,
    APPDATA: process.env.APPDATA,
  };

  // Override environment
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  process.env.OPENCODEX_HOME = join(root, ".agents");
  process.env.CODEX_HOME = join(root, ".codex");
  process.env.APPDATA = join(root, "AppData", "Roaming");

  const createSkillFile = (dir: string, name: string, metadata: Partial<SkillMetadata>, content = "## Instructions\nDefault instructions."): string => {
    const skillFolder = join(dir, name);
    mkdirSync(skillFolder, { recursive: true });
    const skillFilePath = join(skillFolder, "SKILL.md");

    const yamlLines = ["---"];
    yamlLines.push(`name: ${metadata.name ?? name}`);
    yamlLines.push(`description: ${metadata.description ?? `Skill ${name}`}`);
    if (metadata.version) yamlLines.push(`version: ${metadata.version}`);
    if (metadata.author) yamlLines.push(`author: ${metadata.author}`);
    if (metadata.source) yamlLines.push(`source: ${metadata.source}`);
    if (metadata.disabled !== undefined) yamlLines.push(`disabled: ${metadata.disabled}`);
    if (metadata.tags && metadata.tags.length > 0) {
      yamlLines.push("tags:");
      for (const t of metadata.tags) yamlLines.push(`  - ${t}`);
    }
    yamlLines.push("---");
    yamlLines.push("");
    yamlLines.push(content);

    writeFileSync(skillFilePath, yamlLines.join("\n"), "utf8");
    return skillFilePath;
  };

  const readSkillFile = (dir: string, name: string) => {
    const skillFilePath = join(dir, name, "SKILL.md");
    if (!existsSync(skillFilePath)) throw new Error(`SKILL.md not found at ${skillFilePath}`);
    const raw = readFileSync(skillFilePath, "utf8");
    const meta = parseSkillYaml(raw);
    return { raw, metadata: meta.metadata, body: meta.content };
  };

  const isSymlink = (targetPath: string): boolean => {
    try {
      const stat = lstatSync(targetPath);
      return stat.isSymbolicLink();
    } catch {
      return false;
    }
  };

  const getSymlinkTarget = (targetPath: string): string => {
    return readlinkSync(targetPath);
  };

  const createSymlink = (targetPath: string, linkPath: string): void => {
    mkdirSync(dirname(linkPath), { recursive: true });
    if (existsSync(linkPath) || isSymlink(linkPath)) {
      rmSync(linkPath, { recursive: true, force: true });
    }
    symlinkSync(targetPath, linkPath, "dir");
  };

  if (options.withSamples) {
    createSkillFile(paths.centralSkillsDir, "git-commit-helper", {
      name: "git-commit-helper",
      description: "Generates semantic commit messages",
      tags: ["git", "vcs"],
      version: "1.0.0",
      author: "OpenCodex Team",
    }, "## Workflow\nGenerate conventional commits.");

    createSkillFile(paths.codexSystemSkillsDir, "codex-system-core", {
      name: "codex-system-core",
      description: "Codex internal engine prompt instructions",
      tags: ["system", "internal"],
      version: "0.9.0",
      author: "Codex Internal",
    }, "## System\nInternal instructions.");

    const claudeDesktopMcp = {
      mcpServers: {
        "sqlite-explorer": {
          command: "uvx",
          args: ["mcp-server-sqlite", "--db-path", "test.db"],
          env: { SQLITE_TIMEOUT: "5000" },
        },
      },
    };
    writeFileSync(paths.claudeDesktopConfigFile, JSON.stringify(claudeDesktopMcp, null, 2), "utf8");

    const claudeCodeConfig = {
      model: "claude-3-7-sonnet",
      theme: "dark",
      customInstructions: "Be precise and fast",
      telemetry: false,
      mcpServers: {
        "filesystem-server": {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
          env: { NODE_ENV: "production" },
        },
      },
    };
    writeFileSync(paths.claudeCodeConfigFile, JSON.stringify(claudeCodeConfig, null, 2), "utf8");

    const codexToml = [
      'model = "gpt-4o"',
      'temperature = 0.2',
      "",
      "[editor]",
      'theme = "monokai"',
      "tab_size = 2",
      "",
      "[mcp_servers.weather-service]",
      'command = "python"',
      'args = ["-m", "weather_mcp"]',
      "enabled = true",
      "",
      "[mcp_servers.weather-service.env]",
      'API_KEY = "mock-weather-key"',
      'CACHE_TTL = "300"',
    ].join("\n");
    writeFileSync(paths.codexConfigFile, codexToml, "utf8");

    const antigravityMcp = {
      mcpServers: {
        "postgres-tool": {
          command: "docker",
          args: ["run", "-i", "--rm", "mcp/postgres"],
          env: { PG_HOST: "localhost" },
        },
      },
    };
    writeFileSync(paths.geminiConfigFile, JSON.stringify(antigravityMcp, null, 2), "utf8");
  }

  const cleanup = () => {
    for (const [k, v] of Object.entries(envBackup)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Swallowed: temp directory cleanup
    }
  };

  return {
    paths,
    envBackup,
    cleanup,
    createSkillFile,
    readSkillFile,
    isSymlink,
    getSymlinkTarget,
    createSymlink,
  };
}

/**
 * Parses a SKILL.md content with YAML frontmatter.
 */
export function parseSkillYaml(raw: string): { metadata: SkillMetadata; content: string } {
  if (!raw || typeof raw !== "string") {
    return { metadata: { name: "", description: "" }, content: "" };
  }

  const trimmed = raw.trimStart();
  if (!trimmed.startsWith("---")) {
    return { metadata: { name: "", description: "" }, content: raw.trim() };
  }

  const endIdx = trimmed.indexOf("\n---", 3);
  if (endIdx === -1) {
    return { metadata: { name: "", description: "" }, content: raw.trim() };
  }

  const front = trimmed.slice(3, endIdx).trim();
  const content = trimmed.slice(endIdx + 4).trim();
  const meta: Partial<SkillMetadata> = { name: "", description: "" };

  const lines = front.split("\n");
  let currentTags: string[] | null = null;

  for (const line of lines) {
    const l = line.trim();
    if (!l || l.startsWith("#")) continue;

    if (l.startsWith("tags:")) {
      currentTags = [];
      meta.tags = currentTags;
      const rest = l.slice(5).trim();
      if (rest.startsWith("[") && rest.endsWith("]")) {
        meta.tags = rest.slice(1, -1).split(",").map(s => s.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
        currentTags = null;
      }
      continue;
    }

    if (currentTags && l.startsWith("- ")) {
      currentTags.push(l.slice(2).trim().replace(/^['"]|['"]$/g, ""));
      continue;
    }

    currentTags = null;
    const colon = l.indexOf(":");
    if (colon !== -1) {
      const key = l.slice(0, colon).trim();
      let val = l.slice(colon + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }

      if (key === "name") meta.name = val;
      else if (key === "description") meta.description = val;
      else if (key === "version") meta.version = val;
      else if (key === "author") meta.author = val;
      else if (key === "source") meta.source = val;
      else if (key === "disabled") meta.disabled = val === "true" || val === "yes";
    }
  }

  return { metadata: meta as SkillMetadata, content };
}

/**
 * Serializes a SkillMetadata and Markdown body into SKILL.md format.
 */
export function serializeSkillYaml(metadata: SkillMetadata, content: string): string {
  const lines = ["---"];
  lines.push(`name: ${metadata.name}`);
  lines.push(`description: ${metadata.description}`);
  if (metadata.version) lines.push(`version: ${metadata.version}`);
  if (metadata.author) lines.push(`author: ${metadata.author}`);
  if (metadata.source) lines.push(`source: ${metadata.source}`);
  if (metadata.disabled !== undefined) lines.push(`disabled: ${metadata.disabled}`);
  if (metadata.tags && metadata.tags.length > 0) {
    lines.push("tags:");
    for (const tag of metadata.tags) lines.push(`  - ${tag}`);
  }
  lines.push("---");
  lines.push("");
  lines.push(content || "");
  return lines.join("\n");
}

/**
 * Computes SHA256 hash of a skill's content for deduplication.
 */
export function computeSkillHash(skillDir: string): string {
  const skillFile = join(skillDir, "SKILL.md");
  if (!existsSync(skillFile)) return "";
  const content = readFileSync(skillFile, "utf8");
  return createHash("sha256").update(content.trim()).digest("hex");
}

/**
 * Scans skills in all known directories in the sandbox.
 */
export function scanSandboxSkills(paths: SandboxPaths): SkillItem[] {
  const result: Map<string, SkillItem> = new Map();

  const scanDir = (dir: string, agentType: "claude" | "codex" | "project", isSystem = false) => {
    if (!existsSync(dir)) return;
    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.name.startsWith(".") && !isSystem) continue;

      const skillPath = join(dir, entry.name);
      let isSymlink = false;
      let targetPath: string | undefined = undefined;

      try {
        const lstat = lstatSync(skillPath);
        isSymlink = lstat.isSymbolicLink();
        if (isSymlink) {
          targetPath = readlinkSync(skillPath);
        }
      } catch {
        continue;
      }

      const skillFile = isSymlink && targetPath ? join(targetPath, "SKILL.md") : join(skillPath, "SKILL.md");
      if (!existsSync(skillFile)) continue;

      const raw = readFileSync(skillFile, "utf8");
      const { metadata, content } = parseSkillYaml(raw);
      const skillName = metadata.name || entry.name;

      if (result.has(skillName)) {
        const existing = result.get(skillName)!;
        if (!existing.linkedAgents.includes(agentType)) {
          existing.linkedAgents.push(agentType);
        }
      } else {
        result.set(skillName, {
          name: skillName,
          path: skillPath,
          isSymlink,
          targetPath,
          isSystem,
          metadata,
          content,
          linkedAgents: [agentType],
        });
      }
    }
  };

  // Scan central store
  if (existsSync(paths.centralSkillsDir)) {
    const entries = readdirSync(paths.centralSkillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillPath = join(paths.centralSkillsDir, entry.name);
      const skillFile = join(skillPath, "SKILL.md");
      if (!existsSync(skillFile)) continue;

      const raw = readFileSync(skillFile, "utf8");
      const { metadata, content } = parseSkillYaml(raw);
      result.set(metadata.name || entry.name, {
        name: metadata.name || entry.name,
        path: skillPath,
        isSymlink: false,
        isSystem: false,
        metadata,
        content,
        linkedAgents: [],
      });
    }
  }

  // Scan Claude, Codex, Codex System, Project
  scanDir(paths.claudeSkillsDir, "claude");
  scanDir(paths.codexSkillsDir, "codex");
  scanDir(paths.codexSystemSkillsDir, "codex", true);
  scanDir(paths.projectSkillsDir, "project");

  return Array.from(result.values());
}

/**
 * Deduplicates and migrates skills across client directories into central store.
 */
export function deduplicateSkills(paths: SandboxPaths): SyncResult {
  const syncResult: SyncResult = {
    synced: 0,
    migrated: [],
    deduped: [],
    broken: [],
    conflicts: [],
  };

  const centralHashes = new Map<string, string>(); // hash -> central skill name
  mkdirSync(paths.centralSkillsDir, { recursive: true });

  // Read existing central skills
  if (existsSync(paths.centralSkillsDir)) {
    for (const entry of readdirSync(paths.centralSkillsDir)) {
      const skillDir = join(paths.centralSkillsDir, entry);
      if (statSync(skillDir).isDirectory()) {
        const hash = computeSkillHash(skillDir);
        if (hash) centralHashes.set(hash, entry);
      }
    }
  }

  const clientDirs: { dir: string; agent: "claude" | "codex" | "project" }[] = [
    { dir: paths.claudeSkillsDir, agent: "claude" },
    { dir: paths.codexSkillsDir, agent: "codex" },
    { dir: paths.projectSkillsDir, agent: "project" },
  ];

  for (const { dir, agent } of clientDirs) {
    if (!existsSync(dir)) continue;

    for (const entry of readdirSync(dir)) {
      if (entry.startsWith(".")) continue;
      const clientSkillPath = join(dir, entry);
      let isSymlink = false;
      try {
        isSymlink = lstatSync(clientSkillPath).isSymbolicLink();
      } catch {
        continue;
      }

      if (isSymlink) {
        const target = readlinkSync(clientSkillPath);
        if (!existsSync(target)) {
          syncResult.broken.push(clientSkillPath);
        } else {
          syncResult.synced++;
        }
        continue;
      }

      // Physical directory: check hash and migrate/dedup
      const hash = computeSkillHash(clientSkillPath);
      if (!hash) continue;

      if (centralHashes.has(hash)) {
        // Duplicate exists in central store! Replace with symlink
        const centralName = centralHashes.get(hash)!;
        const centralTarget = join(paths.centralSkillsDir, centralName);
        rmSync(clientSkillPath, { recursive: true, force: true });
        symlinkSync(centralTarget, clientSkillPath, "dir");
        syncResult.deduped.push(entry);
        syncResult.synced++;
      } else {
        // Migrate to central store and symlink
        const targetCentral = join(paths.centralSkillsDir, entry);
        if (existsSync(targetCentral)) {
          syncResult.conflicts.push(entry);
          continue;
        }
        mkdirSync(targetCentral, { recursive: true });
        const skillFile = join(clientSkillPath, "SKILL.md");
        if (existsSync(skillFile)) {
          writeFileSync(join(targetCentral, "SKILL.md"), readFileSync(skillFile, "utf8"), "utf8");
        }
        rmSync(clientSkillPath, { recursive: true, force: true });
        symlinkSync(targetCentral, clientSkillPath, "dir");
        centralHashes.set(hash, entry);
        syncResult.migrated.push(entry);
        syncResult.synced++;
      }
    }
  }

  return syncResult;
}

let trashCounter = 0;

/**
 * Trash manager helper: moves skill to trash directory and cleans client symlinks.
 */
export function trashSkill(paths: SandboxPaths, skillName: string): { trashId: string } {
  // Protect Codex system skills
  const systemPath = join(paths.codexSystemSkillsDir, skillName);
  if (existsSync(systemPath)) {
    throw new Error(`Cannot delete system skill '${skillName}'`);
  }

  const centralPath = join(paths.centralSkillsDir, skillName);
  if (!existsSync(centralPath)) {
    throw new Error(`Skill '${skillName}' not found in central store`);
  }

  const timestamp = `${Date.now()}_${++trashCounter}`;
  const trashId = `${timestamp}_${skillName}`;
  const trashDest = join(paths.trashSkillsDir, trashId);
  mkdirSync(trashDest, { recursive: true });

  // Copy/move central skill to trash
  const skillMd = join(centralPath, "SKILL.md");
  if (existsSync(skillMd)) {
    writeFileSync(join(trashDest, "SKILL.md"), readFileSync(skillMd, "utf8"), "utf8");
  }
  rmSync(centralPath, { recursive: true, force: true });

  // Clean symlinks in agent directories
  const checkDirs = [paths.claudeSkillsDir, paths.codexSkillsDir, paths.projectSkillsDir];
  for (const d of checkDirs) {
    const linkPath = join(d, skillName);
    try {
      if (existsSync(linkPath) || lstatSync(linkPath).isSymbolicLink()) {
        rmSync(linkPath, { recursive: true, force: true });
      }
    } catch {
      // Swallowed
    }
  }

  return { trashId };
}

/**
 * Restore skill from trash back to central store and re-establish symlinks.
 */
export function restoreSkill(paths: SandboxPaths, trashId: string): { restored: string } {
  const trashFolder = join(paths.trashSkillsDir, trashId);
  if (!existsSync(trashFolder)) {
    throw new Error(`Trash item '${trashId}' not found`);
  }

  const skillName = trashId.includes("_") ? trashId.slice(trashId.lastIndexOf("_") + 1) : trashId;
  const centralDest = join(paths.centralSkillsDir, skillName);
  mkdirSync(centralDest, { recursive: true });

  const trashMd = join(trashFolder, "SKILL.md");
  if (existsSync(trashMd)) {
    writeFileSync(join(centralDest, "SKILL.md"), readFileSync(trashMd, "utf8"), "utf8");
  }
  rmSync(trashFolder, { recursive: true, force: true });

  // Re-establish symlinks in standard agent directories
  for (const d of [paths.claudeSkillsDir, paths.codexSkillsDir]) {
    const linkPath = join(d, skillName);
    if (!existsSync(linkPath)) {
      try {
        symlinkSync(centralDest, linkPath, "dir");
      } catch {
        // Swallowed
      }
    }
  }

  return { restored: skillName };
}

/**
 * Toggle active state of a skill without breaking symlinks.
 */
export function toggleSkillState(paths: SandboxPaths, skillName: string, enable?: boolean): boolean {
  const centralPath = join(paths.centralSkillsDir, skillName);
  const skillMd = join(centralPath, "SKILL.md");
  if (!existsSync(skillMd)) {
    throw new Error(`Skill '${skillName}' not found`);
  }

  const raw = readFileSync(skillMd, "utf8");
  const { metadata, content } = parseSkillYaml(raw);
  const newDisabled = enable !== undefined ? !enable : !metadata.disabled;
  metadata.disabled = newDisabled;

  const newYaml = serializeSkillYaml(metadata, content);
  writeFileSync(skillMd, newYaml, "utf8");
  return !newDisabled;
}

/**
 * MCP Parser for Claude Desktop JSON format.
 */
export function parseClaudeDesktopMcpFile(filePath: string): UnifiedMcpServer[] {
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, "utf8").trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  const servers = parsed.mcpServers || {};
  const result: UnifiedMcpServer[] = [];

  for (const [id, s] of Object.entries(servers) as [string, any][]) {
    result.push({
      id,
      client: "claude_desktop",
      scope: "global",
      transport: s.url ? "sse" : "stdio",
      command: s.command,
      args: s.args || [],
      env: s.env || {},
      url: s.url,
      enabled: s.enabled !== false,
      rawConfig: s,
    });
  }
  return result;
}

/**
 * MCP Writer for Claude Desktop JSON format.
 */
export function writeClaudeDesktopMcpFile(filePath: string, servers: UnifiedMcpServer[]): void {
  mkdirSync(dirname(filePath), { recursive: true });
  let existing: Record<string, any> = {};
  if (existsSync(filePath)) {
    try {
      existing = JSON.parse(readFileSync(filePath, "utf8"));
    } catch {
      existing = {};
    }
  }

  const mcpServers: Record<string, any> = {};
  for (const s of servers) {
    const entry: Record<string, any> = {};
    if (s.command) entry.command = s.command;
    if (s.args && s.args.length > 0) entry.args = s.args;
    if (s.env && Object.keys(s.env).length > 0) entry.env = s.env;
    if (s.url) entry.url = s.url;
    if (s.enabled === false) entry.enabled = false;
    mcpServers[s.id] = entry;
  }

  existing.mcpServers = mcpServers;
  writeFileSync(filePath, JSON.stringify(existing, null, 2), "utf8");
}

/**
 * MCP Parser for Claude Code JSON format (~/.claude.json).
 */
export function parseClaudeCodeMcpFile(filePath: string): UnifiedMcpServer[] {
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, "utf8").trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  const servers = parsed.mcpServers || {};
  const result: UnifiedMcpServer[] = [];

  for (const [id, s] of Object.entries(servers) as [string, any][]) {
    result.push({
      id,
      client: "claude_code",
      scope: "global",
      transport: s.url ? "sse" : (s.transport || "stdio"),
      command: s.command,
      args: s.args || [],
      env: s.env || {},
      url: s.url,
      headers: s.headers,
      enabled: s.enabled !== false,
      rawConfig: s,
    });
  }
  return result;
}

/**
 * MCP Writer for Claude Code JSON format preserving root configuration keys.
 */
export function writeClaudeCodeMcpFile(filePath: string, servers: UnifiedMcpServer[]): void {
  mkdirSync(dirname(filePath), { recursive: true });
  let rootConfig: Record<string, any> = {};
  if (existsSync(filePath)) {
    try {
      rootConfig = JSON.parse(readFileSync(filePath, "utf8"));
    } catch {
      rootConfig = {};
    }
  }

  const mcpServers: Record<string, any> = {};
  for (const s of servers) {
    const entry: Record<string, any> = {};
    if (s.command) entry.command = s.command;
    if (s.args && s.args.length > 0) entry.args = s.args;
    if (s.env && Object.keys(s.env).length > 0) entry.env = s.env;
    if (s.url) entry.url = s.url;
    if (s.headers) entry.headers = s.headers;
    if (s.enabled === false) entry.enabled = false;
    mcpServers[s.id] = entry;
  }

  rootConfig.mcpServers = mcpServers;
  writeFileSync(filePath, JSON.stringify(rootConfig, null, 2), "utf8");
}

/**
 * MCP Parser for Codex TOML format (~/.codex/config.toml).
 */
export function parseCodexTomlMcpFile(filePath: string): UnifiedMcpServer[] {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, "utf8");
  const servers: Map<string, UnifiedMcpServer> = new Map();

  const lines = content.split("\n");
  let currentServerId: string | null = null;
  let inEnv = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Matches [mcp_servers.<name>.env]
    const envMatch = trimmed.match(/^\[mcp_servers\.([^.]+)\.env\]$/);
    if (envMatch) {
      currentServerId = envMatch[1];
      inEnv = true;
      if (!servers.has(currentServerId)) {
        servers.set(currentServerId, {
          id: currentServerId,
          client: "codex",
          scope: "global",
          transport: "stdio",
          args: [],
          env: {},
          enabled: true,
        });
      }
      continue;
    }

    // Matches [mcp_servers.<name>]
    const serverMatch = trimmed.match(/^\[mcp_servers\.([^.]+)\]$/);
    if (serverMatch) {
      currentServerId = serverMatch[1];
      inEnv = false;
      if (!servers.has(currentServerId)) {
        servers.set(currentServerId, {
          id: currentServerId,
          client: "codex",
          scope: "global",
          transport: "stdio",
          args: [],
          env: {},
          enabled: true,
        });
      }
      continue;
    }

    // Key-value pairs
    if (currentServerId && trimmed.includes("=")) {
      const eqIdx = trimmed.indexOf("=");
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();

      const server = servers.get(currentServerId)!;
      if (inEnv) {
        if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
        server.env[key] = val;
      } else {
        if (key === "command") {
          server.command = val.replace(/^"|"$/g, "");
        } else if (key === "url") {
          server.url = val.replace(/^"|"$/g, "");
          server.transport = "sse";
        } else if (key === "enabled") {
          server.enabled = val === "true";
        } else if (key === "args" && val.startsWith("[") && val.endsWith("]")) {
          server.args = val.slice(1, -1).split(",").map(s => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
        }
      }
    }
  }

  return Array.from(servers.values());
}

/**
 * MCP Writer for Codex TOML format preserving other non-MCP tables.
 */
export function writeCodexTomlMcpFile(filePath: string, servers: UnifiedMcpServer[]): void {
  mkdirSync(dirname(filePath), { recursive: true });
  let originalContent = "";
  if (existsSync(filePath)) {
    originalContent = readFileSync(filePath, "utf8");
  }

  // Remove existing [mcp_servers...] blocks from original content
  const nonMcpLines: string[] = [];
  const lines = originalContent.split("\n");
  let skippingMcp = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[mcp_servers")) {
      skippingMcp = true;
      continue;
    }
    if (skippingMcp && trimmed.startsWith("[") && !trimmed.startsWith("[mcp_servers")) {
      skippingMcp = false;
    }
    if (!skippingMcp) {
      nonMcpLines.push(line);
    }
  }

  // Clean trailing blank lines
  while (nonMcpLines.length > 0 && nonMcpLines[nonMcpLines.length - 1].trim() === "") {
    nonMcpLines.pop();
  }

  const outLines = [...nonMcpLines];
  if (outLines.length > 0) outLines.push("");

  for (const s of servers) {
    outLines.push(`[mcp_servers.${s.id}]`);
    if (s.command) outLines.push(`command = "${s.command}"`);
    if (s.args && s.args.length > 0) {
      const argsFormatted = s.args.map(a => `"${a}"`).join(", ");
      outLines.push(`args = [${argsFormatted}]`);
    }
    if (s.url) outLines.push(`url = "${s.url}"`);
    if (s.enabled !== undefined) outLines.push(`enabled = ${s.enabled}`);
    outLines.push("");

    if (s.env && Object.keys(s.env).length > 0) {
      outLines.push(`[mcp_servers.${s.id}.env]`);
      for (const [k, v] of Object.entries(s.env)) {
        outLines.push(`${k} = "${v}"`);
      }
      outLines.push("");
    }
  }

  writeFileSync(filePath, outLines.join("\n").trimEnd() + "\n", "utf8");
}

/**
 * MCP Parser for Antigravity JSON configs.
 */
export function parseAntigravityMcpFile(filePath: string, scope: "global" | "project" = "global"): UnifiedMcpServer[] {
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, "utf8").trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  const servers = parsed.mcpServers || parsed;
  const result: UnifiedMcpServer[] = [];

  for (const [id, s] of Object.entries(servers) as [string, any][]) {
    if (typeof s !== "object" || s === null) continue;
    result.push({
      id,
      client: "antigravity",
      scope,
      transport: s.url ? "sse" : "stdio",
      command: s.command,
      args: s.args || [],
      env: s.env || {},
      url: s.url,
      enabled: s.enabled !== false,
      rawConfig: s,
    });
  }
  return result;
}

/**
 * MCP Writer for Antigravity JSON configs.
 */
export function writeAntigravityMcpFile(filePath: string, servers: UnifiedMcpServer[]): void {
  mkdirSync(dirname(filePath), { recursive: true });
  let existing: Record<string, any> = {};
  if (existsSync(filePath)) {
    try {
      existing = JSON.parse(readFileSync(filePath, "utf8"));
    } catch {
      existing = {};
    }
  }

  const mcpServers: Record<string, any> = {};
  for (const s of servers) {
    const entry: Record<string, any> = {};
    if (s.command) entry.command = s.command;
    if (s.args && s.args.length > 0) entry.args = s.args;
    if (s.env && Object.keys(s.env).length > 0) entry.env = s.env;
    if (s.url) entry.url = s.url;
    if (s.enabled === false) entry.enabled = false;
    mcpServers[s.id] = entry;
  }

  existing.mcpServers = mcpServers;
  writeFileSync(filePath, JSON.stringify(existing, null, 2), "utf8");
}

/**
 * Cross-client MCP server cloning logic.
 */
export function cloneMcpServer(paths: SandboxPaths, options: McpCloneOptions): UnifiedMcpServer {
  const getClientServers = (client: McpClientType): UnifiedMcpServer[] => {
    switch (client) {
      case "claude_desktop":
        return parseClaudeDesktopMcpFile(paths.claudeDesktopConfigFile);
      case "claude_code":
        return parseClaudeCodeMcpFile(paths.claudeCodeConfigFile);
      case "codex":
        return parseCodexTomlMcpFile(paths.codexConfigFile);
      case "antigravity":
        return parseAntigravityMcpFile(paths.geminiConfigFile);
    }
  };

  const saveClientServers = (client: McpClientType, servers: UnifiedMcpServer[]): void => {
    switch (client) {
      case "claude_desktop":
        return writeClaudeDesktopMcpFile(paths.claudeDesktopConfigFile, servers);
      case "claude_code":
        return writeClaudeCodeMcpFile(paths.claudeCodeConfigFile, servers);
      case "codex":
        return writeCodexTomlMcpFile(paths.codexConfigFile, servers);
      case "antigravity":
        return writeAntigravityMcpFile(paths.geminiConfigFile, servers);
    }
  };

  const sourceServers = getClientServers(options.fromClient);
  const sourceServer = sourceServers.find(s => s.id === options.serverId);
  if (!sourceServer) {
    throw new Error(`Source server '${options.serverId}' not found in client '${options.fromClient}'`);
  }

  const targetId = options.newId || options.serverId;
  const targetServers = getClientServers(options.toClient);
  const existingIdx = targetServers.findIndex(s => s.id === targetId);

  if (existingIdx !== -1 && !options.overwrite) {
    throw new Error(`Target server '${targetId}' already exists in client '${options.toClient}' and overwrite is false`);
  }

  const cloned: UnifiedMcpServer = {
    ...sourceServer,
    id: targetId,
    client: options.toClient,
  };

  if (existingIdx !== -1) {
    targetServers[existingIdx] = cloned;
  } else {
    targetServers.push(cloned);
  }

  saveClientServers(options.toClient, targetServers);
  return cloned;
}
