# ✅ Codex Setup Complete for AgentPact

## MCPs Installed

| MCP | Purpose | Status |
|-----|---------|--------|
| **filesystem** | Direct file read/write access | ✅ Installed |
| **sequential-thinking** | Multi-step reasoning for complex fixes | ✅ Installed |
| **ros2** | (Pre-existing) | ✅ Active |

Run `codex mcp list` to verify:
```
Name                 Command  Args                                                                
filesystem           npx      @modelcontextprotocol/server-filesystem /home/adam/repos/agentpact
sequential-thinking  npx      @modelcontextprotocol/server-sequential-thinking
ros2                 docker   run -i --rm --net=host mcp/ros2
```

## Skills Available

| Skill | Purpose | Location |
|-------|---------|----------|
| **create-plan** | Plan multi-step tasks | `~/.codex/skills/create-plan/` |

## Ready to Use

You can now run Codex with:
```bash
cd ~/repos/agentpact
codex
```

Codex will have access to:
- ✅ File system operations (read/write/list in `/home/adam/repos/agentpact`)
- ✅ Sequential thinking for complex problem solving
- ✅ Create-plan skill for task breakdown
- ✅ Web search (if configured)
- ✅ Shell execution in sandbox

## Quick Start Commands

### Option 1: Use the prepared prompt file
```bash
cd ~/repos/agentpact
codex "Read CODEX_FIX_PROMPT.md and follow all instructions to fix TypeScript errors"
```

### Option 2: Paste this directly
```bash
cd ~/repos/agentpact
codex
```

Then paste in Codex:
```
Fix TypeScript errors in apps/api/src/index.ts:

ERRORS TO FIX:
1. TransactionSql<{}>` has no call signatures (15x) - Fix postgres transaction usage
2. Parameter type errors (10x) - Handle optional SQL parameters properly  
3. Error type handling (2x) - Add type guards in catch blocks
4. Spread type error (1x) - Ensure spread on objects only

APPROACH:
1. Use sequential-thinking to plan the fix
2. Read apps/api/src/index.ts with filesystem MCP
3. Fix SQL parameter handling first (provide defaults for optional params)
4. Fix transaction types (correct sql.begin() usage)
5. Add error type guards in catch blocks
6. Test: npm run build after each major change

CONSTRAINTS:
- Keep all existing logic unchanged
- No @ts-ignore or @ts-nocheck
- Use proper TypeScript types
- Test build passes before completing

When done: openclaw gateway wake --text "TypeScript fixes complete! ✅" --mode now
```

## What Codex Will Do

1. **Plan** using sequential-thinking MCP
2. **Read** `apps/api/src/index.ts` using filesystem MCP
3. **Fix** errors systematically:
   - SQL parameter type issues
   - Transaction type errors  
   - Error handling types
   - Spread operator issues
4. **Test** after each fix: `npm run build`
5. **Notify** you when complete via OpenClaw

## Expected Results

After Codex completes:
- ✅ Zero TypeScript errors
- ✅ `npm run build` passes
- ✅ All functionality preserved
- ✅ You'll get WhatsApp notification

## Troubleshooting

**If Codex asks for clarification:**
- Point it to CODEX_FIX_PROMPT.md for full context
- Emphasize: "Preserve all logic, just fix types"

**If build still fails:**
- Ask Codex: "Show me the remaining errors from npm run build"
- Have it fix iteratively

**If Codex seems stuck:**
- Restart: `codex resume` to continue previous session
- Or start fresh: `codex` and re-paste prompt

## Files Created for Reference

| File | Purpose |
|------|---------|
| `CODEX_FIX_PROMPT.md` | Detailed instructions for Codex |
| `RECOMMENDED_MCPS.md` | All MCP options (you installed the essentials) |
| `STATUS_REPORT.md` | Current state analysis |
| `DEPLOYMENT_REQUIREMENTS.md` | What you'll need to deploy |
| `IMPROVEMENT_PLAN.md` | Full roadmap after TypeScript is fixed |

## Next Steps After Codex Fixes TypeScript

1. **Smart Contracts** - Create Solidity escrow with 10% fee
2. **Tests** - Add Vitest test suite  
3. **Deployment** - Set up Postgres, wallet, RPC
4. **Launch** 🚀

---

**You're all set!** Start Codex when ready:
```bash
cd ~/repos/agentpact && codex
```

Then paste the prompt above or reference `CODEX_FIX_PROMPT.md`. I'll get notified when it's done! 🦉
