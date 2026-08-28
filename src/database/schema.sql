-- ============================================================================
-- WhatsApp Control Plane SQLite Schema (Production v1)
-- Strictly Ordered DAG: users -> projects -> project_configs -> sessions -> jobs -> job_outputs
-- Zero circular dependencies or forward table references
-- ============================================================================

-- 1. USERS
CREATE TABLE IF NOT EXISTS users (
    id                 TEXT PRIMARY KEY,              -- WhatsApp JID (e.g. '1234567890@s.whatsapp.net')
    phone_number       TEXT NOT NULL UNIQUE,          -- Normalized phone number without symbols
    display_name       TEXT,                          -- WhatsApp push name / alias
    is_authorized      INTEGER NOT NULL DEFAULT 0,    -- 1 = Whitelisted, 0 = Blocked
    created_at         INTEGER NOT NULL,              -- Epoch ms
    updated_at         INTEGER NOT NULL               -- Epoch ms
);

CREATE INDEX IF NOT EXISTS idx_users_authorized ON users(is_authorized);

-- 2. PROJECTS (References users)
CREATE TABLE IF NOT EXISTS projects (
    id                 TEXT PRIMARY KEY,              -- Deterministic slug or UUID (e.g. 'proj_friendhub')
    user_id            TEXT NOT NULL,                 -- Owner
    name               TEXT NOT NULL,                 -- Friendly project name
    root_path          TEXT NOT NULL,                 -- Canonical host directory
    cwd                TEXT NOT NULL,                 -- Current working directory within root_path
    selected_agent     TEXT NOT NULL DEFAULT 'claude',-- e.g. 'claude', 'codex'
    is_active          INTEGER NOT NULL DEFAULT 0,    -- 1 = Active project for user, 0 = Inactive
    created_at         INTEGER NOT NULL,              -- Epoch ms
    updated_at         INTEGER NOT NULL,              -- Epoch ms
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(user_id, root_path)
);

CREATE INDEX IF NOT EXISTS idx_projects_user_active ON projects(user_id, is_active);

-- 3. PROJECT CONFIGURATIONS (References projects)
CREATE TABLE IF NOT EXISTS project_configs (
    project_id               TEXT PRIMARY KEY,
    -- Agent CLI Flags
    model                    TEXT NOT NULL DEFAULT 'claude-3-7-sonnet',
    permission_mode          TEXT NOT NULL DEFAULT 'plan',    -- 'plan', 'default', 'accept-all', 'bypass'
    allowed_tools            TEXT NOT NULL DEFAULT '[]',      -- JSON array of strings
    denied_tools             TEXT NOT NULL DEFAULT '[]',      -- JSON array of strings
    agent_output_format      TEXT NOT NULL DEFAULT 'json',    -- CLI format: 'json', 'text', 'stream-json'
    max_turns                INTEGER NOT NULL DEFAULT 10,
    max_budget_usd           REAL,                            -- NULL = unlimited
    worktree_enabled         INTEGER NOT NULL DEFAULT 0,      -- 1 = Enabled, 0 = Disabled
    worktree_branch          TEXT,                            -- Worktree branch name
    mcp_config_path          TEXT,                            -- Custom .mcp.json path
    -- WhatsApp Presentation Flags
    render_mode              TEXT NOT NULL DEFAULT 'compact', -- 'compact', 'full', 'file'
    render_show_diff         INTEGER NOT NULL DEFAULT 1,      -- 1 = Show diff stats
    render_max_excerpt_lines INTEGER NOT NULL DEFAULT 15,     -- Max terminal lines in preview
    render_notify_progress   INTEGER NOT NULL DEFAULT 0,      -- 1 = Send progress pings
    updated_at               INTEGER NOT NULL,                -- Epoch ms
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- 4. SESSIONS (References projects and users)
CREATE TABLE IF NOT EXISTS sessions (
    id                TEXT PRIMARY KEY,               -- e.g. 'sess_9f2a81b'
    project_id        TEXT NOT NULL,
    user_id           TEXT NOT NULL,
    name              TEXT NOT NULL,                  -- Friendly name (e.g. 'backend-refactor')
    agent_name        TEXT NOT NULL,                  -- e.g. 'claude'
    agent_session_ref TEXT,                           -- Native CLI session UUID for --resume
    working_dir       TEXT NOT NULL,                  -- Directory snapshot when created
    status            TEXT NOT NULL DEFAULT 'ACTIVE', -- 'ACTIVE' or 'CLOSED'
    turn_count        INTEGER NOT NULL DEFAULT 0,
    -- Strictly nullable metrics
    tokens_in         INTEGER,
    tokens_out        INTEGER,
    total_cost_usd    REAL,
    created_at        INTEGER NOT NULL,               -- Epoch ms
    last_active_at    INTEGER NOT NULL,               -- Epoch ms
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(project_id, name)
);

CREATE INDEX IF NOT EXISTS idx_sessions_project_status ON sessions(project_id, status);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_last_active ON sessions(last_active_at DESC);

-- 5. JOBS (References sessions, projects, users)
CREATE TABLE IF NOT EXISTS jobs (
    id                INTEGER PRIMARY KEY AUTOINCREMENT, -- Monotonic WhatsApp job ID (#1, #2, ... #184)
    session_id        TEXT NOT NULL,
    project_id        TEXT NOT NULL,
    user_id           TEXT NOT NULL,
    prompt            TEXT NOT NULL,                     -- Raw user instruction
    command_args      TEXT NOT NULL,                     -- JSON array of argv
    status            TEXT NOT NULL,                     -- 'QUEUED','RUNNING','CANCEL_REQUESTED','COMPLETED','FAILED','CANCELLED','TIMED_OUT'
    pid               INTEGER,                           -- Host OS process group leader PID
    exit_code         INTEGER,                           -- Nullable until process exits
    failure_reason    TEXT,                              -- 'SERVER_RESTART', 'TIMEOUT', 'USER_CANCEL', 'PROCESS_ERROR'
    error_message     TEXT,                              -- Sanitized error description
    created_at        INTEGER NOT NULL,                  -- Epoch ms
    started_at        INTEGER,                           -- Epoch ms (NULL while QUEUED)
    finished_at       INTEGER,                           -- Epoch ms
    duration_ms       INTEGER,
    -- Usage strictly nullable
    tokens_in         INTEGER,
    tokens_out        INTEGER,
    cost_usd          REAL,
    turns_used        INTEGER,
    -- Summary and Diffs
    summary           TEXT,
    files_changed     TEXT,                              -- JSON array of {path, additions, deletions}
    -- Buffer tracking & Truncation flags
    stdout_bytes      INTEGER NOT NULL DEFAULT 0,
    stderr_bytes      INTEGER NOT NULL DEFAULT 0,
    stdout_truncated  INTEGER NOT NULL DEFAULT 0,        -- 1 if capped at buffer limit
    stderr_truncated  INTEGER NOT NULL DEFAULT 0,        -- 1 if capped at buffer limit
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_jobs_session_status ON jobs(session_id, status);
CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

-- 6. JOB OUTPUTS (References jobs)
CREATE TABLE IF NOT EXISTS job_outputs (
    job_id           INTEGER PRIMARY KEY,
    stdout           TEXT,                              -- In-memory captured standard output
    stderr           TEXT,                              -- In-memory captured standard error
    raw_output_path  TEXT,                              -- Path to spilled disk file if large
    created_at       INTEGER NOT NULL,
    FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
);
