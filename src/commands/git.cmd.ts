import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CommandContext } from './types.js';
import { InvalidArgumentError } from '../router/errors.js';

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, { cwd, timeout: 15000 });
    return { stdout: stdout.trim(), stderr: stderr.trim(), code: 0 };
  } catch (err: any) {
    return {
      stdout: (err.stdout || '').trim(),
      stderr: (err.stderr || err.message || '').trim(),
      code: err.code || 1,
    };
  }
}

export async function handleGit(ctx: CommandContext): Promise<string> {
  const cwd = ctx.project?.root_path || ctx.project?.cwd || ctx.navCwd;
  const { subcommand, args, rawTrailing } = ctx.parsed;

  switch (subcommand) {
    case 'diff':
      return handleGitDiff(cwd, args[0]);
    case 'commit':
      return handleGitCommit(cwd, rawTrailing || args.join(' '));
    case 'push':
      return handleGitPush(cwd, args);
    case 'status':
      return handleGitStatus(cwd);
    case 'log':
      return handleGitLog(cwd, args[0]);
    default:
      if (!subcommand) {
        return handleGitStatus(cwd);
      }
      return handleGitCustom(cwd, [subcommand, ...args]);
  }
}

export async function handleGitDiff(cwd: string, targetFile?: string): Promise<string> {
  const statusRes = await runGit(cwd, ['status', '--short']);
  if (statusRes.code !== 0 && statusRes.stderr.includes('not a git repository')) {
    return '⚠️ *Not a Git Repository*\n\nThis directory or project is not initialized with Git. Use `/project` or `/cd` to navigate to a git repository.';
  }

  const statRes = await runGit(cwd, targetFile ? ['diff', '--stat', targetFile] : ['diff', '--stat']);

  if (!statusRes.stdout && !statRes.stdout) {
    return [
      '🌿 *Git Status: Clean*',
      '',
      'No uncommitted changes in this project.',
    ].join('\n');
  }

  const patchArgs = targetFile ? ['diff', targetFile] : ['diff'];
  const patchRes = await runGit(cwd, patchArgs);

  const lines: string[] = [
    '📝 *Git Diffs & Changes*',
    '',
    '*Files Modified:*',
    statusRes.stdout || 'None',
    '',
  ];

  if (statRes.stdout) {
    lines.push('*Summary:*', statRes.stdout, '');
  }

  if (patchRes.stdout) {
    const snippet = patchRes.stdout.length > 1200
      ? patchRes.stdout.slice(0, 1200) + '\n... (truncated)'
      : patchRes.stdout;
    lines.push('*Diff Snippet:*', '```diff', snippet, '```', '');
  }

  lines.push(
    '_Use `/commit <message>` to commit these changes, or `/push` to push._'
  );

  return lines.join('\n');
}

export async function handleGitCommit(cwd: string, message?: string): Promise<string> {
  const cleanMsg = (message || '').trim();
  if (!cleanMsg) {
    throw new InvalidArgumentError(
      'Commit message is required.',
      'Specify a message: `/commit "Fix header styles"`'
    );
  }

  // 1. Stage all changes
  const addRes = await runGit(cwd, ['add', '-A']);
  if (addRes.code !== 0) {
    if (addRes.stderr.includes('not a git repository')) {
      return '⚠️ *Not a Git Repository*\n\nThis directory or project is not initialized with Git.';
    }
    return `❌ *Git Add Failed*:\n${addRes.stderr}`;
  }

  // 2. Commit
  const commitRes = await runGit(cwd, ['commit', '-m', cleanMsg]);
  if (commitRes.code !== 0) {
    if (commitRes.stdout.includes('nothing to commit') || commitRes.stderr.includes('nothing to commit')) {
      return '🌿 *Nothing to commit*: Working tree is clean.';
    }
    return `❌ *Git Commit Failed*:\n${commitRes.stderr || commitRes.stdout}`;
  }

  // 3. Get latest commit info
  const logRes = await runGit(cwd, ['log', '-1', '--oneline']);

  return [
    '✅ *Git Commit Created*',
    '',
    `📌 *Commit*: \`${logRes.stdout || cleanMsg}\``,
    `📁 *Project*: \`${cwd.split('/').pop()}\``,
    '',
    '_Next: Type `/push` to push this commit to your remote branch._',
  ].join('\n');
}

export async function handleGitPush(cwd: string, extraArgs: string[] = []): Promise<string> {
  const pushRes = await runGit(cwd, ['push', ...extraArgs]);

  if (pushRes.code !== 0) {
    if (pushRes.stderr.includes('not a git repository')) {
      return '⚠️ *Not a Git Repository*\n\nThis directory or project is not initialized with Git.';
    }
    return [
      '❌ *Git Push Failed*',
      '',
      `Reason: ${pushRes.stderr || pushRes.stdout}`,
      '_Ensure your branch has upstream set or you have write permissions._',
    ].join('\n');
  }

  return [
    '🚀 *Git Push Successful*',
    '',
    pushRes.stderr || pushRes.stdout || 'Changes pushed to remote branch.',
  ].join('\n');
}

export async function handleGitStatus(cwd: string): Promise<string> {
  const branchRes = await runGit(cwd, ['branch', '--show-current']);
  if (branchRes.code !== 0 && branchRes.stderr.includes('not a git repository')) {
    return '⚠️ *Not a Git Repository*\n\nThis directory or project is not initialized with Git.';
  }
  const statusRes = await runGit(cwd, ['status', '--short', '--branch']);

  return [
    '🌿 *Git Repository Status*',
    '',
    `• *Branch*: \`${branchRes.stdout || 'unknown'}\``,
    `• *Working Tree*:`,
    statusRes.stdout || '  (Clean)',
    '',
    '_Commands: `/diff`, `/commit <msg>`, `/push`, `/git log`_',
  ].join('\n');
}

export async function handleGitLog(cwd: string, countStr?: string): Promise<string> {
  const n = parseInt(countStr || '5', 10) || 5;
  const logRes = await runGit(cwd, ['log', `-${Math.min(n, 15)}`, '--pretty=format:%h · %s (%cr)']);

  if (logRes.code !== 0 && logRes.stderr.includes('not a git repository')) {
    return '⚠️ *Not a Git Repository*\n\nThis directory or project is not initialized with Git.';
  }

  return [
    `📜 *Recent Commits (last ${Math.min(n, 15)})*`,
    '',
    logRes.stdout || 'No commits found.',
  ].join('\n');
}

async function handleGitCustom(cwd: string, args: string[]): Promise<string> {
  const res = await runGit(cwd, args);
  if (res.code !== 0) {
    return `❌ *git ${args.join(' ')} failed*:\n${res.stderr || res.stdout}`;
  }
  return `🌿 *git ${args.join(' ')}*:\n${res.stdout || 'Success.'}`;
}
