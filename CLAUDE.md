# Stremio AI Search — Agent Notes

## Quick Commands
- Install: pnpm install
- Tests: pnpm test
- Smoke: pnpm run smoke:tanstack:mcp

## Runtime Config
- AI providers: Gemini or OpenAI-compatible
- Optional MCP: MCP_ENABLED + MCP_ALLOW_SPAWN + MCP_SERVERS_JSON

## Project Layout
- Addon/server: server.js, addon.js
- AI adapters: utils/aiProvider.js
- MCP glue: utils/mcp.js
- Tests: tests/

## Conventions
- Use pnpm only.
- Keep MCP disabled by default.
- Prefer minimal env for spawned MCP processes.
