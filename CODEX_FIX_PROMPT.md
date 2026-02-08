# Codex Prompt for Fixing AgentPact TypeScript Errors

## Context
AgentPact is a bot-native marketplace built with TypeScript, Fastify, and Postgres. The API currently has 27 TypeScript compilation errors that need fixing.

## Your Mission
Fix all TypeScript errors in `apps/api/src/index.ts` while preserving all existing functionality.

## Errors to Fix

### 1. Transaction SQL Type Errors (15 occurrences)
**Problem:** `TransactionSql<{}>` has no call signatures
**Lines affected:** 185, 190, 193, 197, 436, 446, 452, 470, 472, 478, 484, 498, 499, 500, 514, 515, 516

**Root cause:** Incorrect usage of `sql.begin()` transaction API

**Fix approach:**
- Review postgres.js transaction documentation
- Use proper type annotations for transaction parameter
- Ensure SQL queries inside transactions use the transaction instance correctly

### 2. SQL Parameter Type Errors (10 occurrences)
**Problem:** Parameters typed as `string | undefined` not assignable to `ParameterOrFragment<never>`
**Lines affected:** 276, 330, 347, 423, 611, 630, 639, 685

**Root cause:** SQL template literals don't handle optional parameters correctly

**Fix approach:**
- Provide default values for optional parameters before SQL query
- Use conditional query building for optional filters
- Example: `const category = body.category ?? null;`

### 3. Error Type Handling (2 occurrences)
**Problem:** `'error' is of type 'unknown'` in catch blocks
**Lines affected:** 726

**Fix approach:**
- Add proper type guards in catch blocks
- Example: `if (error instanceof Error) { ... }`
- Or cast with: `const err = error as Error;`

### 4. Spread Type Error (1 occurrence)
**Problem:** `Spread types may only be created from object types`
**Line affected:** 465

**Fix approach:**
- Ensure spread operator is used on objects, not potentially undefined values
- Add type checks before spreading

## Steps to Complete

1. **Plan the fix using sequential-thinking MCP:**
   ```
   Use create_thought to outline:
   - Which error patterns to fix first
   - How to test each fix
   - Rollback strategy if build breaks
   ```

2. **Read the problematic file:**
   ```
   Use filesystem MCP: read_file("apps/api/src/index.ts")
   ```

3. **Fix errors systematically:**
   - Start with SQL parameter handling (most common)
   - Then fix transaction types
   - Finally handle error types and edge cases

4. **Test after each major change:**
   ```bash
   npm run build
   ```

5. **Verify all tests pass:**
   ```bash
   cd apps/api && npm run build
   cd apps/mcp && npm run build
   cd apps/web && npm run build
   ```

## Important Constraints

✅ **DO:**
- Keep all existing API endpoints unchanged
- Preserve all business logic
- Use proper TypeScript types (no `any`)
- Add type guards where needed
- Test after each fix

❌ **DON'T:**
- Add `// @ts-ignore` or `// @ts-nocheck`
- Change API behavior
- Remove functionality
- Break existing queries
- Use `any` types

## Expected Outcome

After your fixes:
```bash
npm run build
```

Should show:
```
✅ @agentpact/api@0.1.0 build - No errors
✅ @agentpact/mcp@0.1.0 build - No errors  
✅ @agentpact/web@0.1.0 build - No errors
```

## Reference Resources

- **Postgres.js docs:** https://github.com/porsager/postgres
- **Fastify types:** https://fastify.dev/docs/latest/Reference/TypeScript/
- **Zod schemas:** Already defined in file (createOfferSchema, etc.)

## When Complete

Run this command to notify me:
```bash
openclaw gateway wake --text "AgentPact TypeScript fixes complete! Build passes ✅" --mode now
```

## Notes

- The filesystem MCP gives you direct file access - use it!
- Sequential-thinking helps break down complex fixes
- Take your time - correctness > speed
- Build should pass before notifying completion

Good luck! 🚀
