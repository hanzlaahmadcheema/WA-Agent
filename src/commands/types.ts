import type { User, Project } from '../database/types.js';
import type { ParsedCommand } from '../router/lexer.js';
import type { FileSendResult } from './send-file.cmd.js';

export interface CommandContext {
  user: User;
  project?: Project | null;
  parsed: ParsedCommand;
  navCwd: string;
}

export type CommandResult = string | FileSendResult;
export type CommandHandler = (ctx: CommandContext) => Promise<CommandResult> | CommandResult;
