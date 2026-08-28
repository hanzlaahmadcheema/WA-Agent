// Database Entity Models & Types

export interface User {
  id: string;                                         // WhatsApp JID (e.g. 1234567890@s.whatsapp.net)
  phone_number: string;
  display_name: string | null;
  is_authorized: number;                              // 1 or 0
  created_at: number;
  updated_at: number;
}

export interface Project {
  id: string;
  user_id: string;
  name: string;
  root_path: string;
  cwd: string;
  selected_agent: string;
  is_active: number;                                  // 1 or 0
  created_at: number;
  updated_at: number;
}

export interface ProjectConfig {
  project_id: string;
  model: string;
  permission_mode: 'plan' | 'default' | 'accept-all' | 'bypass';
  allowed_tools: string;                              // JSON array string
  denied_tools: string;                               // JSON array string
  agent_output_format: 'json' | 'text' | 'stream-json';
  max_turns: number;
  max_budget_usd: number | null;
  worktree_enabled: number;
  worktree_branch: string | null;
  mcp_config_path: string | null;
  render_mode: 'compact' | 'full' | 'file';
  render_show_diff: number;
  render_max_excerpt_lines: number;
  render_notify_progress: number;
  updated_at: number;
}

export type SessionStatus = 'ACTIVE' | 'CLOSED';

export interface Session {
  id: string;
  project_id: string;
  user_id: string;
  name: string;
  agent_name: string;
  agent_session_ref: string | null;
  working_dir: string;
  status: SessionStatus;
  turn_count: number;
  tokens_in: number | null;
  tokens_out: number | null;
  total_cost_usd: number | null;
  created_at: number;
  last_active_at: number;
}

export type JobStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'CANCEL_REQUESTED'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'TIMED_OUT';

export type JobFailureReason =
  | 'SERVER_RESTART'
  | 'TIMEOUT'
  | 'USER_CANCEL'
  | 'PROCESS_ERROR';

export interface Job {
  id: number;
  session_id: string;
  project_id: string;
  user_id: string;
  prompt: string;
  command_args: string;                               // JSON array string
  status: JobStatus;
  pid: number | null;
  exit_code: number | null;
  failure_reason: JobFailureReason | null;
  error_message: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  duration_ms: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  turns_used: number | null;
  summary: string | null;
  files_changed: string | null;                       // JSON array string
  stdout_bytes: number;
  stderr_bytes: number;
  stdout_truncated: number;
  stderr_truncated: number;
}

export interface JobOutput {
  job_id: number;
  stdout: string | null;
  stderr: string | null;
  raw_output_path: string | null;
  created_at: number;
}
