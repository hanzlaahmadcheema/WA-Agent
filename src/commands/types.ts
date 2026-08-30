import type { User, Project } from '../database/types.js';
import type { ParsedCommand } from '../router/lexer.js';

export interface CommandContext {
  user: User;
  project?: Project | null;
  parsed: ParsedCommand;
  navCwd: string;
}

export type CommandHandler = (ctx: CommandContext) => Promise<string> | string;
