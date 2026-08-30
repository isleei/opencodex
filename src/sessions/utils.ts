/**
 * Shared utility functions for sessions parsing and extraction.
 */

export function extractProjectName(cwdOrPath?: string): string | undefined {
  if (!cwdOrPath) return undefined;
  const clean = cwdOrPath.replace(/^["']|["']$/g, "").trim();
  if (!clean) return undefined;

  // 1. Check for work/<lang>/<proj> or work/<proj>
  const langMatch = clean.match(/\/work\/(?:js|ts|php|python|golang|go|java|rust|cpp|c|frontend|backend|apps|packages)\/([^/]+)/i);
  if (langMatch) return langMatch[1];

  const workMatch = clean.match(/\/work\/([^/]+)/i);
  if (workMatch) return workMatch[1];

  // 2. Check for projects/<folder>
  const projMatch = clean.match(/\/projects\/([^/]+)/i);
  if (projMatch) {
    const raw = projMatch[1];
    const subMatch = raw.match(/-(?:js|ts|php|python|golang|go|java|rust|cpp|c|frontend|backend|apps|packages)-([^-]+)$/i);
    if (subMatch) return subMatch[1];
    const generalSub = raw.split("-").filter(Boolean).pop();
    if (generalSub) return generalSub;
    return raw;
  }

  // 3. Fallback to basename
  const base = clean.split("/").filter(Boolean).pop();
  return base || undefined;
}

export function cleanCodexUserPrompt(raw: string): string {
  let text = raw;
  const userReqMatch = text.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
  if (userReqMatch) {
    text = userReqMatch[1].trim();
  }
  const cleanMatch = text
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, "")
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, "")
    .replace(/<recommended_plugins>[\s\S]*?<\/recommended_plugins>/gi, "")
    .replace(/<app-context>[\s\S]*?<\/app-context>/gi, "")
    .replace(/<collaboration_mode>[\s\S]*?<\/collaboration_mode>/gi, "")
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, "")
    .replace(/<instructions>[\s\S]*?<\/instructions>/gi, "")
    .trim();

  if (
    cleanMatch.startsWith("# AGENTS.md instructions") ||
    cleanMatch.startsWith("The following is the Codex agent history") ||
    cleanMatch.startsWith("You are running inside the Codex") ||
    cleanMatch.startsWith("<multi_agent_mode>")
  ) {
    return "";
  }
  return cleanMatch || "";
}

export function cleanAgyUserPrompt(raw: string): string {
  let text = raw;
  const userReqMatch = text.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
  if (userReqMatch) {
    text = userReqMatch[1].trim();
  }
  return (
    text
      .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, "")
      .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, "")
      .trim() || raw.trim()
  );
}

export function cleanClaudeText(raw: string): string {
  return raw
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/gi, "")
    .replace(/<command-name>[\s\S]*?<\/command-name>/gi, "")
    .replace(/<command-message>[\s\S]*?<\/command-message>/gi, "")
    .replace(/<command-args>[\s\S]*?<\/command-args>/gi, "")
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/gi, "")
    .replace(/<local-command-stderr>[\s\S]*?<\/local-command-stderr>/gi, "")
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\[\d+m/g, "")
    .trim();
}
