# WA-Agent: Deterministic WhatsApp Control Plane for Claude Code

A robust, deterministic remote control plane and terminal over WhatsApp for Claude Code and CLI agents.

## Architecture

```text
WhatsApp (Baileys)
      ↓
Message Pipeline (Auth & Normalization)
      ↓
Command Router (Lexer, Validator, Dispatcher)
      ↓
State & SQLite Database (WAL Mode, Crash Recovery)
      ↓
Job Manager (Process Supervisor, Detached Process Group, Stream Collector)
      ↓
Agent Driver (Claude Code argv Builder & Output Normalizer)
      ↓
WhatsApp Renderer
```

## Features

- **Deterministic CLI Navigation**: `/pwd`, `/ls`, `/cd`, `/up`, `/tree` bounded by strict sandbox roots.
- **Numbered Shortcuts**: Run `/ls` and navigate with `/cd 2` or inspect files with `/view 4`.
- **File Exploration**: `/view <file> [page]`, `/head`, `/tail`, `/grep "<pattern>"`.
- **Session FSM**: `/session new [name]`, `/session list`, `/session resume <id|n>`, `/session close`, `/session rename`.
- **Persistent Execution Configuration**: `/config`, `/model <name>`, `/turns <n>`, `/budget <amt>`, `/render <compact|full|file>`.
- **Asynchronous Background Task Execution**:
  - `/run <instruction>` (quoted or unquoted).
  - Returns immediate task ID (`#184`).
  - Detached OS process group execution.
  - Safe cancellation with `SIGTERM` followed by `SIGKILL` watchdog (`/cancel <id>`).
  - Automatic async WhatsApp completion alert with duration, summary, diffs, and usage metrics.
- **Zero Hallucination / Pure Control Plane**: No LLM in the control loop—every command parses and executes deterministically.

## Quick Start

### 1. Configure Environment

Copy `.env.example` to `.env` and set your allowed directory roots and WhatsApp admin number:

```bash
cp .env.example .env
```

```ini
ALLOWED_ROOTS=/home/user/projects
ADMIN_PHONE_NUMBER=1234567890
```

### 2. Interactive CLI Simulator (Test Without WhatsApp)

You can interact with the entire control plane directly in your terminal:

```bash
npm run sim
```

Example session in simulator:
```text
WA-CLI > /menu
WA-CLI > /pwd
WA-CLI > /ls
WA-CLI > /session new my-feature
WA-CLI > /config
WA-CLI > /status
```

### 3. Run Automated Tests

```bash
npm test
```

### 4. Start WhatsApp Daemon

To connect WhatsApp and link your phone:

```bash
npm start
```

Scan the terminal QR code using WhatsApp on your phone (**Linked Devices** ➔ **Link a Device**). Once linked, message the bot directly from your admin phone number.
