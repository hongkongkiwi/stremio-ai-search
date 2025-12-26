# Stremio AI Search — Agent Notes

## Quick Commands
- Install: pnpm install
- Tests: pnpm test
- Smoke: pnpm run smoke:tanstack:mcp

## Runtime Config (high-level)
- AI providers: Gemini or OpenAI-compatible
- Optional MCP: MCP_ENABLED + MCP_ALLOW_SPAWN + MCP_SERVERS_JSON
- TanStack override (tests only): AI_ALLOW_TANSTACK_OVERRIDE=true + AI_TANSTACK_MODULES_PATH

## Key Files
- Addon/server: server.js, addon.js
- AI adapters: utils/aiProvider.js
- MCP glue: utils/mcp.js
- Shared env helpers: utils/env.js
- Tests: tests/

## Provider Defaults
- Gemini model: gemini-2.5-flash-lite
- OpenAI-compatible model: gpt-4o-mini
- Temperature: unset (defaults to 0.2 at call time)

## Conventions
- Use pnpm only.
- Keep MCP disabled by default.
- Spawned MCP env uses an allowlist; use MCP server config `env` for extra vars.
