# Recommended MCPs for AgentPact Development

## For TypeScript/Node.js Development

### 1. **Filesystem MCP** (🎖️ Official)
**Purpose:** Read/write files, critical for fixing TypeScript errors
```bash
codex mcp add filesystem --command npx --args "@modelcontextprotocol/server-filesystem" "$HOME/repos/agentpact"
```

### 2. **Postgres MCP** (🎖️ Official)
**Purpose:** Direct database queries, schema inspection
```bash
codex mcp add postgres --command npx --args "@modelcontextprotocol/server-postgres" "postgres://localhost:5432/agentpact"
```

### 3. **GitHub MCP** (🎖️ Official)
**Purpose:** Commit fixes, create PRs
```bash
codex mcp add github --command npx --args "@modelcontextprotocol/server-github"
# Requires: GITHUB_PERSONAL_ACCESS_TOKEN env var
```

### 4. **Sequential Thinking MCP** (🎖️ Official)
**Purpose:** Multi-step reasoning for complex TypeScript fixes
```bash
codex mcp add sequential-thinking --command npx --args "@modelcontextprotocol/server-sequential-thinking"
```

## Optional but Useful

### 5. **Memory MCP** (🎖️ Official)
**Purpose:** Remember patterns from previous fixes
```bash
codex mcp add memory --command npx --args "@modelcontextprotocol/server-memory"
```

### 6. **Brave Search MCP** (🎖️ Official)
**Purpose:** Search for TypeScript/Postgres error solutions
```bash
codex mcp add brave-search --command npx --args "@modelcontextprotocol/server-brave-search"
# Requires: BRAVE_API_KEY env var
```

## Installation Steps

1. **Install filesystem MCP (required)**
```bash
npm install -g @modelcontextprotocol/server-filesystem
codex mcp add filesystem \
  --command npx \
  --args "@modelcontextprotocol/server-filesystem" \
  --args "/home/adam/repos/agentpact"
```

2. **Install sequential-thinking (helpful for complex fixes)**
```bash
npm install -g @modelcontextprotocol/server-sequential-thinking
codex mcp add sequential-thinking \
  --command npx \
  --args "@modelcontextprotocol/server-sequential-thinking"
```

3. **Verify MCPs are active**
```bash
codex mcp list
```

Should show:
```
Name                  Command  Args                              Status   
filesystem            npx      @modelcontextprotocol/server...   enabled  
sequential-thinking   npx      @modelcontextprotocol/server...   enabled  
ros2                  docker   run -i --rm --net=host mcp/ros2   enabled  
```

## Testing MCP Installation

Start Codex and check available tools:
```bash
cd ~/repos/agentpact
codex
```

In Codex, type: `/tools`

You should see:
- `read_file`, `write_file`, `list_directory` (filesystem)
- `create_thought`, `continue_thought` (sequential-thinking)

## Why These MCPs?

| MCP | Benefit for AgentPact |
|-----|----------------------|
| **filesystem** | Direct file access = faster TypeScript fixes |
| **sequential-thinking** | Multi-step reasoning = better complex fixes |
| **postgres** | Query schemas = understand database structure |
| **github** | Auto-commit fixes = track changes |
| **memory** | Remember patterns = learn from mistakes |

## After Installation

You can run:
```bash
cd ~/repos/agentpact
codex
```

Then paste:
```
Fix TypeScript errors in apps/api/src/index.ts:

1. Fix postgres transaction queries (sql.begin() incorrect usage)
2. Add proper type annotations for SQL query results  
3. Fix undefined parameter handling in SQL templates
4. Add error type handling in catch blocks
5. Verify build passes: npm run build

Use sequential-thinking to plan the fix approach first.
Use filesystem to read/write files efficiently.

Keep all existing logic - just fix types!
```

The filesystem MCP will make Codex much faster at reading/writing files vs manual tool calls.
