/**
 * Agent identity detection.
 *
 * The dashboard is used from several different AI coding tools (Claude Code,
 * Codex, Gemini CLI, Cursor, …), so nothing here may assume "Claude". Identity
 * is derived from the environment the MCP server was launched in, because each
 * tool spawns its MCP servers as child processes and leaks recognisable
 * environment variables into them.
 */

export interface AgentIdentity {
  /** Human-readable name shown on the board, e.g. "Claude Code" */
  name: string;
  /** Stable slug used for grouping/filtering, e.g. "claude-code" */
  type: string;
  /** Tool version when the environment exposes one */
  version?: string;
}

interface Rule {
  type: string;
  name: string;
  /** Environment variables that, if any is set, identify this tool */
  envAny: string[];
  /** Substrings matched against the generic AI_AGENT variable */
  aliases?: string[];
  /** Environment variable carrying the tool version */
  versionEnv?: string[];
}

/**
 * Ordered most-specific first. The first rule that matches wins.
 */
const RULES: Rule[] = [
  {
    type: 'claude-code',
    name: 'Claude Code',
    envAny: ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID'],
    aliases: ['claude-code', 'claude_code', 'claude'],
    // Deliberately not CLAUDE_AGENT_SDK_VERSION — that is the SDK's version,
    // not the tool's, and reporting it as the tool version is misleading.
    versionEnv: ['CLAUDE_CODE_VERSION'],
  },
  {
    type: 'codex',
    name: 'Codex',
    envAny: ['CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'CODEX_HOME', 'CODEX_THREAD_ID'],
    aliases: ['codex', 'openai-codex'],
    versionEnv: ['CODEX_VERSION'],
  },
  {
    type: 'gemini',
    name: 'Gemini CLI',
    envAny: ['GEMINI_CLI', 'GEMINI_SANDBOX', 'GEMINI_CODE_ASSIST', 'GEMINI_SESSION_ID'],
    aliases: ['gemini'],
    versionEnv: ['GEMINI_CLI_VERSION'],
  },
  {
    type: 'cursor',
    name: 'Cursor',
    envAny: ['CURSOR_AGENT', 'CURSOR_TRACE_ID', 'CURSOR_SESSION_ID'],
    aliases: ['cursor'],
  },
  {
    type: 'copilot',
    name: 'GitHub Copilot',
    envAny: ['COPILOT_AGENT_ID', 'GITHUB_COPILOT_AGENT', 'COPILOT_SESSION_ID'],
    aliases: ['copilot'],
  },
  {
    type: 'aider',
    name: 'Aider',
    envAny: ['AIDER_MODEL', 'AIDER_SESSION'],
    aliases: ['aider'],
  },
  {
    type: 'windsurf',
    name: 'Windsurf',
    envAny: ['WINDSURF_SESSION_ID', 'WINDSURF_AGENT'],
    aliases: ['windsurf', 'codeium'],
  },
  {
    type: 'cline',
    name: 'Cline',
    envAny: ['CLINE_SESSION_ID', 'CLINE_AGENT'],
    aliases: ['cline'],
  },
];

const isSet = (env: NodeJS.ProcessEnv, key: string): boolean => {
  const value = env[key];
  return typeof value === 'string' && value.length > 0 && value !== 'false' && value !== '0';
};

const firstValue = (env: NodeJS.ProcessEnv, keys: string[] = []): string | undefined => {
  for (const key of keys) {
    const value = env[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
};

/**
 * Turn a slug such as "claude-code" into a display name such as "Claude Code".
 */
function titleCase(slug: string): string {
  return slug
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Parse the generic AI_AGENT variable, which several tools set in the form
 * "<tool>_<version>_agent" (e.g. "claude-code_2-1-268_agent").
 */
function parseGenericAgentVar(raw: string): { slug: string; version?: string } | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  const parts = trimmed.split('_').filter((p) => p && p !== 'agent');
  if (parts.length === 0) return undefined;

  const slug = parts[0];
  // A version segment looks like "2-1-268" or "1.2.3"
  const versionPart = parts.slice(1).find((p) => /^[0-9]+([-.][0-9]+)*$/.test(p));

  return {
    slug,
    version: versionPart ? versionPart.replace(/-/g, '.') : undefined,
  };
}

/**
 * Detect which AI tool this MCP server is serving.
 *
 * Resolution order:
 *   1. AGENT_TRACK_AGENT_NAME / AGENT_TRACK_AGENT_TYPE explicit override
 *   2. Tool-specific environment variables
 *   3. The generic AI_AGENT variable
 *   4. "Unknown Agent"
 */
export function detectAgentIdentity(env: NodeJS.ProcessEnv = process.env): AgentIdentity {
  // 1. Explicit override always wins — lets a user label a tool we don't know.
  const overrideName = firstValue(env, ['AGENT_TRACK_AGENT_NAME']);
  const overrideType = firstValue(env, ['AGENT_TRACK_AGENT_TYPE']);
  if (overrideName || overrideType) {
    const type = overrideType || overrideName!.toLowerCase().replace(/\s+/g, '-');
    return {
      name: overrideName || titleCase(type),
      type,
      version: firstValue(env, ['AGENT_TRACK_AGENT_VERSION']),
    };
  }

  const generic = firstValue(env, ['AI_AGENT']);
  const parsedGeneric = generic ? parseGenericAgentVar(generic) : undefined;

  // 2. Tool-specific environment variables.
  for (const rule of RULES) {
    const matchedEnv = rule.envAny.some((key) => isSet(env, key));
    const matchedAlias =
      parsedGeneric !== undefined &&
      (rule.aliases ?? []).some((alias) => parsedGeneric.slug.toLowerCase().includes(alias));

    if (matchedEnv || matchedAlias) {
      return {
        name: rule.name,
        type: rule.type,
        version: firstValue(env, rule.versionEnv) ?? parsedGeneric?.version,
      };
    }
  }

  // 3. An AI_AGENT value we don't have a rule for — still better than "Claude".
  if (parsedGeneric) {
    return {
      name: titleCase(parsedGeneric.slug),
      type: parsedGeneric.slug.toLowerCase(),
      version: parsedGeneric.version,
    };
  }

  // 4. Nothing recognisable.
  return { name: 'Unknown Agent', type: 'unknown' };
}

/** Convenience: "Claude Code 2.1.268" or "Claude Code" when no version is known. */
export function describeAgent(identity: AgentIdentity): string {
  return identity.version ? `${identity.name} ${identity.version}` : identity.name;
}
