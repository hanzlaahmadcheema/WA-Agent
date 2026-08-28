import type { User, Project } from '../database/types.js';
import type { ParsedCommand } from '../router/lexer.js';

export interface CommandContext {
  user: User;
  project: Project;
  parsed: ParsedCommand;
}

export type CommandHandler = (ctx: CommandContext) => Promise<string> | string;
