---
name: codex-agent:mcp-setup
description: Configure Codex as an MCP server for Claude Code
argument-hint: [start|stop|status]
allowed-tools:
  - Bash
  - Read
  - Write
  - AskUserQuestion
---

# Codex Agent — MCP Server Setup

Configure Codex CLI as an MCP (Model Context Protocol) server for Claude Code. This enables direct tool-call access to Codex from within Claude Code, complementing the managed dispatch workflow.

## Input

Action: `$ARGUMENTS`

## Step 1: Determine Action

Parse `$ARGUMENTS`:
- If empty, missing, or `status` → go to **Step 2: Status Check**
- If `start` → go to **Step 3: Start/Configure**
- If `stop` → go to **Step 4: Stop/Remove**
- Otherwise → respond with:
  > Unrecognized action. Usage:
  > - `/codex-agent:mcp-setup` or `/codex-agent:mcp-setup status` — Check current MCP server status
  > - `/codex-agent:mcp-setup start` — Configure Codex as an MCP server
  > - `/codex-agent:mcp-setup stop` — Remove Codex MCP server configuration

## Step 2: Status Check

Check if Codex MCP server is available and configured.

### 2a: Check Codex MCP Server Availability

**Never run bare `codex mcp-server`** and never probe with `codex mcp-server --help`: on Codex versions where the subcommand was removed, `mcp-server` is parsed as a PROMPT, `--help` prints the top-level help and exits 0 (a false positive), and the bare form starts an interactive session.

Probe with the `help` subcommand, which rejects unknown subcommands:

```bash
codex help mcp-server 2>&1 | head -3
```

If the output contains `unrecognized subcommand`, `codex mcp-server` is **not available**. It was removed from Codex CLI (verified on 0.167.0; OpenAI's docs say the command and standalone binary "have been removed", replaced by the experimental `codex app-server` JSON-RPC protocol, which needs a separate bridge to be used from Claude Code).

### 2b: Check Claude Code MCP Configuration

Read the Claude Code settings file. Check these locations in order:
1. `.claude/settings.json` in the current project directory
2. `~/.claude/settings.json` (global user settings)

Look for an `mcpServers` section containing a `codex` entry.

### 2c: Report Status

Present the status:

---

### Codex MCP Server Status

**Codex CLI**: [version from `codex --version`]
**MCP Server Command**: [available / not available]
**Claude Code Configuration**: [configured / not configured]

If configured, show the current MCP server entry:
```json
{
  "codex": { ... }
}
```

If not configured:
> Codex MCP server is not configured. Run `/codex-agent:mcp-setup start` to set it up.

---

Then stop.

## Step 3: Start/Configure

### 3a: Verify MCP Server is Available

Run the probe from Step 2a (`codex help mcp-server`, never `codex mcp-server --help`).

If the output contains `unrecognized subcommand` (expected on current Codex CLI):
> **Codex MCP server is not available.** `codex mcp-server` was removed from Codex CLI; its replacement, `codex app-server`, is a JSON-RPC protocol that Claude Code cannot register directly (it needs a bridge).
>
> Use `/codex-agent:dispatch` for one-shot tasks and `/codex-agent:discuss` for multi-round discussions (these resume the same Codex thread between rounds).

Then stop. Do NOT write any MCP configuration: an entry running `codex mcp-server` would start an interactive Codex session instead of an MCP server.

### 3b: Check Existing Configuration

Read Claude Code's settings files (same locations as Step 2b). Check if a `codex` MCP server is already configured.

If already configured:
> Codex MCP server is already configured in Claude Code settings.
> Run `/codex-agent:mcp-setup status` to see the current configuration.
> Run `/codex-agent:mcp-setup stop` to remove it first if you want to reconfigure.

Then stop.

### 3c: Determine Settings File Location

Use AskUserQuestion to ask where to add the MCP server configuration:

Question: "Where should the Codex MCP server be configured?"
Options:
1. **Project settings (Recommended)** — `.claude/settings.json` in the current project. Only affects this project.
2. **Global settings** — `~/.claude/settings.json`. Available in all projects.

### 3d: Add MCP Server Configuration

Read the chosen settings file. If it doesn't exist, create it with an empty object `{}`.

Add the Codex MCP server entry to the `mcpServers` section:

```json
{
  "mcpServers": {
    "codex": {
      "command": "codex",
      "args": ["mcp-server"],
      "type": "stdio"
    }
  }
}
```

If `mcpServers` already exists with other entries, merge the `codex` entry into it (preserve existing entries).

Write the updated settings file.

### 3e: Confirm and Explain

Present the confirmation:

---

### Codex MCP Server Configured

The Codex MCP server has been added to your [project/global] Claude Code settings.

**Important**: You need to **restart Claude Code** for the MCP server to become active.

**What this enables**:
- Direct tool calls to Codex from within Claude Code
- Code execution and file operations through Codex's sandbox
- No budget tracking or routing (for managed dispatches, continue using `/codex-agent:dispatch`)

**Note**: The Codex MCP server feature is experimental. If you experience issues, you can remove it with `/codex-agent:mcp-setup stop`.

---

Then stop.

## Step 4: Stop/Remove

### 4a: Find and Remove Configuration

Read Claude Code's settings files (both project and global). Find which file(s) contain a `codex` MCP server entry.

If no `codex` MCP server entry is found anywhere:
> Codex MCP server is not currently configured. Nothing to remove.

Then stop.

### 4b: Remove the Entry

For each settings file that contains the `codex` MCP server entry:

1. Read the file
2. Remove the `codex` key from `mcpServers`
3. If `mcpServers` is now empty, remove the `mcpServers` key entirely
4. Write the updated file

### 4c: Confirm

> **Codex MCP server configuration removed** from [project/global] settings.
>
> Restart Claude Code to complete the removal.
>
> You can still use `/codex-agent:dispatch` for managed Codex dispatches with budget tracking.

Then stop.

## Important Notes

- `codex mcp-server` was experimental from v0.98.0 and has since been removed (absent in 0.167.0). Steps 3b–3e apply only to an older Codex CLI where the Step 2a probe does NOT report `unrecognized subcommand`.
- The MCP server does NOT replace the dispatch workflow — it's a complementary access method.
- Dispatches through the MCP server do NOT go through budget tracking, routing, or session logging.
- For tracked, managed dispatches, continue using `/codex-agent:dispatch`.
- Always use forward slashes in file paths, even on Windows.
- Never use backtick characters inside `node -e` command strings.
