export interface ParsedCommand {
  raw: string;
  command: string;           // e.g. 'cd', 'session', 'run', 'menu'
  subcommand?: string;       // e.g. 'new', 'list', 'resume', 'model'
  args: string[];            // tokenized arguments
  rawTrailing?: string;      // remaining text after command/subcommand (for /run)
}

/**
 * Tokenizes an input command string respecting quotes and escapes.
 */
export function tokenizeArguments(text: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuotes = false;
  let quoteChar = '';
  let escape = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (escape) {
      current += char;
      escape = false;
      continue;
    }

    if (char === '\\') {
      escape = true;
      continue;
    }

    if (inQuotes) {
      if (char === quoteChar) {
        inQuotes = false;
        quoteChar = '';
      } else {
        current += char;
      }
    } else {
      if (char === '"' || char === "'") {
        inQuotes = true;
        quoteChar = char;
      } else if (/\s/.test(char)) {
        if (current.length > 0) {
          tokens.push(current);
          current = '';
        }
      } else {
        current += char;
      }
    }
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

/**
 * Parses user message into canonical command, subcommand, and arguments.
 */
export function parseCommand(input: string): ParsedCommand | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Handle plain numbers (e.g. typing "1" for menu or selection)
  if (/^\d+$/.test(trimmed)) {
    return {
      raw: trimmed,
      command: 'select_numeric',
      args: [trimmed],
    };
  }

  if (!trimmed.startsWith('/')) {
    return null;
  }

  // Remove leading slash
  const withoutSlash = trimmed.slice(1).trim();
  const allTokens = tokenizeArguments(withoutSlash);
  if (allTokens.length === 0) return null;

  const firstToken = allTokens[0].toLowerCase();
  const remainingTokens = allTokens.slice(1);

  // Shorthand alias mappings to canonical categories
  const aliases: Record<string, { command: string; subcommand?: string }> = {
    menu: { command: 'menu' },
    pwd: { command: 'navigation', subcommand: 'pwd' },
    ls: { command: 'navigation', subcommand: 'ls' },
    cd: { command: 'navigation', subcommand: 'cd' },
    up: { command: 'navigation', subcommand: 'up' },
    tree: { command: 'navigation', subcommand: 'tree' },
    view: { command: 'files', subcommand: 'view' },
    head: { command: 'files', subcommand: 'head' },
    tail: { command: 'files', subcommand: 'tail' },
    grep: { command: 'files', subcommand: 'grep' },
    agents: { command: 'agent', subcommand: 'list' },
    agent: { command: 'agent' },
    session: { command: 'session' },
    resume: { command: 'session', subcommand: 'resume' },
    config: { command: 'config' },
    model: { command: 'config', subcommand: 'model' },
    permission: { command: 'config', subcommand: 'permission' },
    tools: { command: 'config', subcommand: 'tools' },
    output: { command: 'config', subcommand: 'output' },
    turns: { command: 'config', subcommand: 'turns' },
    budget: { command: 'config', subcommand: 'budget' },
    worktree: { command: 'config', subcommand: 'worktree' },
    mcp: { command: 'config', subcommand: 'mcp' },
    render: { command: 'config', subcommand: 'render' },
    run: { command: 'task', subcommand: 'run' },
    jobs: { command: 'task', subcommand: 'jobs' },
    job: { command: 'task', subcommand: 'job' },
    cancel: { command: 'task', subcommand: 'cancel' },
    status: { command: 'system', subcommand: 'status' },
    help: { command: 'system', subcommand: 'help' },
  };

  let command = firstToken;
  let subcommand: string | undefined = undefined;
  let args = remainingTokens;

  if (aliases[firstToken]) {
    const mapping = aliases[firstToken];
    command = mapping.command;
    if (mapping.subcommand) {
      subcommand = mapping.subcommand;
      args = remainingTokens;
    } else if (remainingTokens.length > 0) {
      subcommand = remainingTokens[0].toLowerCase();
      args = remainingTokens.slice(1);
    }
  } else if (['navigation', 'files', 'agent', 'session', 'config', 'task', 'system'].includes(firstToken)) {
    command = firstToken;
    if (remainingTokens.length > 0) {
      subcommand = remainingTokens[0].toLowerCase();
      args = remainingTokens.slice(1);
    }
  }

  // Extract rawTrailing for prompts (e.g. /run or /task run)
  let rawTrailing: string | undefined = undefined;
  if ((command === 'task' && subcommand === 'run') || firstToken === 'run') {
    // Find where the command prefix ends in the original string
    const match = trimmed.match(/^\/(?:task\s+run|run)\s+(.*)$/i);
    if (match) {
      let promptText = match[1].trim();
      // If user quoted the prompt, strip the surrounding quotes
      if (
        (promptText.startsWith('"') && promptText.endsWith('"')) ||
        (promptText.startsWith("'") && promptText.endsWith("'"))
      ) {
        promptText = promptText.slice(1, -1);
      }
      rawTrailing = promptText;
    }
  }

  return {
    raw: trimmed,
    command,
    subcommand,
    args,
    rawTrailing,
  };
}
