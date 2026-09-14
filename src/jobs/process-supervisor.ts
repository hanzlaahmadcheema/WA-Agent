import { spawn, type ChildProcess } from 'node:child_process';

export function spawnDetachedAgent(
  command: string,
  args: string[],
  cwd: string
): ChildProcess {
  const homeDir = process.env.USER_HOME || process.env.DEFAULT_CWD || '/home/hanzlaahmad';
  return spawn(command, args, {
    cwd,
    detached: true, // Creates a new process group on POSIX
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOME: homeDir,
      CODEX_HOME: process.env.CODEX_HOME || '/var/lib/wa-agent/.codex',
    },
  });
}

export async function terminateProcessGroup(
  pid: number,
  gracePeriodMs: number = 3000
): Promise<void> {
  try {
    // Send SIGTERM to the process group leader (-pid)
    process.kill(-pid, 'SIGTERM');
  } catch (err: any) {
    if (err.code === 'ESRCH') {
      // Process already dead
      return;
    }
    throw err;
  }

  // Grace period before SIGKILL
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // Ignore if already dead
      }
      resolve();
    }, gracePeriodMs);

    timer.unref();
  });
}
