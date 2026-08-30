import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { SkillMetadata } from "./types";

/**
 * Parses YAML frontmatter from Markdown text.
 */
export function parseSkillFrontmatter(
  rawContent: string,
  fallbackName?: string
): { metadata: SkillMetadata; content: string } {
  const normalized = rawContent.replace(/\r\n/g, "\n");
  const trimmed = normalized.trimStart();

  if (!trimmed.startsWith("---")) {
    return {
      metadata: {
        name: fallbackName ?? "unnamed",
        description: "",
        disabled: false,
      },
      content: rawContent,
    };
  }

  // Find end delimiter for frontmatter
  const delimiterIndex = trimmed.indexOf("\n---", 3);
  if (delimiterIndex === -1) {
    return {
      metadata: {
        name: fallbackName ?? "unnamed",
        description: "",
        disabled: false,
      },
      content: rawContent,
    };
  }

  const yamlBlock = trimmed.slice(4, delimiterIndex).trim();
  const restIndex = trimmed.indexOf("\n", delimiterIndex + 4);
  const body = restIndex === -1 ? "" : trimmed.slice(restIndex + 1).replace(/^\n+/, "");

  let parsed: Record<string, unknown> = {};
  if (yamlBlock.length > 0) {
    try {
      if (typeof Bun !== "undefined" && Bun.YAML && typeof Bun.YAML.parse === "function") {
        parsed = (Bun.YAML.parse(yamlBlock) as Record<string, unknown>) ?? {};
      } else {
        parsed = parseSimpleYaml(yamlBlock);
      }
    } catch {
      // If YAML parser fails, fall back to simple key-value parser
      parsed = parseSimpleYaml(yamlBlock);
    }
  }

  // Normalize fields
  const name =
    typeof parsed.name === "string" && parsed.name.trim().length > 0
      ? parsed.name.trim()
      : fallbackName ?? "unnamed";

  const description =
    typeof parsed.description === "string"
      ? parsed.description.trim()
      : typeof parsed.description === "number"
        ? String(parsed.description)
        : "";

  let tags: string[] | undefined;
  if (Array.isArray(parsed.tags)) {
    tags = parsed.tags.map((t) => String(t).trim()).filter(Boolean);
  } else if (typeof parsed.tags === "string" && parsed.tags.trim().length > 0) {
    tags = parsed.tags.split(",").map((t) => t.trim()).filter(Boolean);
  }

  const version = typeof parsed.version === "string" ? parsed.version.trim() : undefined;
  const author = typeof parsed.author === "string" ? parsed.author.trim() : undefined;
  const source = typeof parsed.source === "string" ? parsed.source.trim() : undefined;
  const disabled = typeof parsed.disabled === "boolean" ? parsed.disabled : Boolean(parsed.disabled === "true");

  const metadata: SkillMetadata = {
    ...parsed,
    name,
    description,
    tags,
    version,
    author,
    source,
    disabled,
  };

  // Remove undefined fields for cleanliness
  for (const key of Object.keys(metadata)) {
    if (metadata[key] === undefined) {
      delete metadata[key];
    }
  }

  return { metadata, content: body };
}

/**
 * Serializes metadata and Markdown body into a unified SKILL.md content string with YAML frontmatter.
 */
export function serializeSkill(metadata: SkillMetadata, content: string): string {
  const lines: string[] = ["---"];

  // Essential fields in canonical order
  lines.push(`name: ${formatYamlValue(metadata.name ?? "unnamed")}`);
  lines.push(`description: ${formatYamlValue(metadata.description ?? "")}`);

  if (metadata.tags && metadata.tags.length > 0) {
    lines.push("tags:");
    for (const tag of metadata.tags) {
      lines.push(`  - ${formatYamlValue(tag)}`);
    }
  }

  if (metadata.version !== undefined && metadata.version !== "") {
    lines.push(`version: ${formatYamlValue(metadata.version)}`);
  }

  if (metadata.author !== undefined && metadata.author !== "") {
    lines.push(`author: ${formatYamlValue(metadata.author)}`);
  }

  if (metadata.source !== undefined && metadata.source !== "") {
    lines.push(`source: ${formatYamlValue(metadata.source)}`);
  }

  if (metadata.disabled !== undefined) {
    lines.push(`disabled: ${metadata.disabled ? "true" : "false"}`);
  }

  // Any custom extra fields
  const standardKeys = new Set(["name", "description", "tags", "version", "author", "source", "disabled"]);
  for (const [key, value] of Object.entries(metadata)) {
    if (!standardKeys.has(key) && value !== undefined) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        lines.push(`${key}: ${formatYamlValue(value)}`);
      } else if (Array.isArray(value)) {
        lines.push(`${key}:`);
        for (const item of value) {
          lines.push(`  - ${formatYamlValue(item)}`);
        }
      }
    }
  }

  lines.push("---");
  lines.push("");

  const bodyContent = content.trim();
  if (bodyContent.length > 0) {
    lines.push(bodyContent);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Formats a scalar value for YAML serialization.
 */
function formatYamlValue(val: unknown): string {
  if (val === null || val === undefined) return '""';
  if (typeof val === "boolean") return val ? "true" : "false";
  if (typeof val === "number") return String(val);

  const str = String(val);
  if (str.length === 0) return '""';

  // If string contains newlines, quotes, colons, or special characters, quote it safely
  if (
    str.includes("\n") ||
    str.includes(":") ||
    str.includes("#") ||
    str.includes('"') ||
    str.includes("'") ||
    str.startsWith(" ") ||
    str.endsWith(" ") ||
    /^(?:true|false|null|yes|no|on|off)$/i.test(str)
  ) {
    return JSON.stringify(str);
  }

  return str;
}

/**
 * Fallback simple YAML parser for key-value pairs and string lists.
 */
function parseSimpleYaml(yamlText: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yamlText.split("\n");
  let currentKey: string | null = null;
  let currentList: string[] | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // List item
    if (trimmed.startsWith("- ") && currentKey) {
      const item = trimmed.slice(2).trim().replace(/^["'](.*)["']$/, "$1");
      if (!currentList) {
        currentList = [];
        result[currentKey] = currentList;
      }
      currentList.push(item);
      continue;
    }

    // Key-value pair
    const colonIndex = line.indexOf(":");
    if (colonIndex !== -1) {
      const key = line.slice(0, colonIndex).trim();
      const rawValue = line.slice(colonIndex + 1).trim();

      currentKey = key;
      currentList = null;

      if (!rawValue) {
        // Key might precede a list
        result[key] = [];
        currentList = result[key] as string[];
      } else {
        let val: unknown = rawValue;
        if (rawValue === "true") val = true;
        else if (rawValue === "false") val = false;
        else if (rawValue === "null") val = null;
        else if (/^-?\d+(\.\d+)?$/.test(rawValue)) val = Number(rawValue);
        else if ((rawValue.startsWith('"') && rawValue.endsWith('"')) || (rawValue.startsWith("'") && rawValue.endsWith("'"))) {
          try {
            val = JSON.parse(rawValue);
          } catch {
            val = rawValue.slice(1, -1);
          }
        }
        result[key] = val;
      }
    }
  }

  return result;
}

/**
 * Reads and parses SKILL.md from a skill directory.
 */
export function readSkillFromDir(
  dirPath: string
): { metadata: SkillMetadata; content: string; skillFile: string } | null {
  if (!existsSync(dirPath)) return null;

  const candidates = ["SKILL.md", "skill.md", "Skill.md"];
  for (const candidate of candidates) {
    const filePath = join(dirPath, candidate);
    if (existsSync(filePath)) {
      try {
        const raw = readFileSync(filePath, "utf8");
        const parsed = parseSkillFrontmatter(raw, basename(dirPath));
        return { ...parsed, skillFile: filePath };
      } catch {
        return null;
      }
    }
  }

  // If directory exists but no SKILL.md, synthesize metadata with fallback name
  return {
    metadata: {
      name: basename(dirPath),
      description: "",
      disabled: false,
    },
    content: "",
    skillFile: join(dirPath, "SKILL.md"),
  };
}

/**
 * Writes SKILL.md to the specified skill directory.
 */
export function writeSkillToDir(dirPath: string, metadata: SkillMetadata, content: string): string {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true, mode: 0o755 });
  }

  const skillFilePath = join(dirPath, "SKILL.md");
  const serialized = serializeSkill(metadata, content);
  writeFileSync(skillFilePath, serialized, "utf8");
  return skillFilePath;
}
