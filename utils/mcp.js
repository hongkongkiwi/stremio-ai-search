const logger = require("./logger");

function parseJsonEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw || !String(raw).trim()) return fallback;
  return JSON.parse(raw);
}

function isTruthy(value) {
  return String(value || "").toLowerCase() === "true";
}

function substituteTemplate(value, vars) {
  if (typeof value === "string") {
    return value.replace(/\{\{(\w+)\}\}/g, (_, k) =>
      vars[k] === undefined || vars[k] === null ? "" : String(vars[k])
    );
  }
  if (Array.isArray(value)) return value.map((v) => substituteTemplate(v, vars));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = substituteTemplate(v, vars);
    return out;
  }
  return value;
}

function isMcpEnabled() {
  return isTruthy(process.env.MCP_ENABLED);
}

function isMcpSpawnAllowed() {
  return isTruthy(process.env.MCP_ALLOW_SPAWN);
}

function getDefaultEnv() {
  const allowlist = ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"];
  const env = {};
  for (const key of allowlist) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function normalizeServerConfig(raw, index) {
  const id =
    typeof raw?.id === "string" && raw.id.trim() ? raw.id.trim() : `mcp_${index + 1}`;
  const enabled =
    raw?.enabled !== undefined ? Boolean(raw.enabled) : raw?.disabled !== undefined ? !Boolean(raw.disabled) : true;
  const transport = raw?.transport ? String(raw.transport) : "stdio";
  const cmd = raw?.cmd ? String(raw.cmd).trim() : raw?.command ? String(raw.command).trim() : "";
  const args = raw?.args === undefined ? [] : raw.args;
  const timeoutMs = Number(raw?.timeoutMs ?? process.env.MCP_TIMEOUT_MS ?? 5000);
  const toolCalls = raw?.toolCalls === undefined ? [] : raw.toolCalls;
  const env = raw?.env && typeof raw.env === "object" && !Array.isArray(raw.env) ? raw.env : undefined;

  return {
    id,
    enabled,
    transport,
    cmd,
    args,
    timeoutMs,
    toolCalls,
    env,
  };
}

function getServersFromLegacyEnv() {
  const cmd = String(process.env.MCP_SERVER_CMD || "").trim();
  if (!cmd) return [];

  const args = parseJsonEnv("MCP_SERVER_ARGS", []);
  const toolCalls = parseJsonEnv("MCP_TOOL_CALLS", []);
  const timeoutMs = Number(process.env.MCP_TIMEOUT_MS || 5000);

  return [
    normalizeServerConfig(
      {
        id: "default",
        enabled: true,
        transport: "stdio",
        cmd,
        args,
        timeoutMs,
        toolCalls,
      },
      0
    ),
  ];
}

function getServersFromEnv() {
  const raw = process.env.MCP_SERVERS_JSON;
  if (raw && String(raw).trim()) {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map((s, i) => normalizeServerConfig(s, i));
    }
    if (parsed && typeof parsed === "object") {
      const mcpServers = parsed.mcpServers;
      if (mcpServers && typeof mcpServers === "object" && !Array.isArray(mcpServers)) {
        return Object.entries(mcpServers).map(([serverId, cfg], i) =>
          normalizeServerConfig({ id: serverId, ...(cfg || {}) }, i)
        );
      }
    }
    throw new Error('MCP_SERVERS_JSON must be either a JSON array or an object with an "mcpServers" map');
  }
  return getServersFromLegacyEnv();
}

async function startMcpClient(server) {
  if (!isMcpEnabled()) return null;
  if (!isMcpSpawnAllowed()) {
    throw new Error("MCP is enabled but MCP_ALLOW_SPAWN is not true");
  }

  if (!server) throw new Error("MCP server config is required");
  if (server.transport !== "stdio") {
    throw new Error(`Unsupported MCP transport: ${server.transport}`);
  }

  const cmd = String(server.cmd || "").trim();
  if (!cmd) throw new Error("MCP server cmd is required");

  const args = server.args === undefined ? [] : server.args;
  if (!Array.isArray(args)) throw new Error("MCP server args must be a JSON array");

  const timeoutMs = Number(server.timeoutMs || 5000);

  // MCP SDK is ESM-first; use subpath exports that provide CJS entry points.
  const { Client } = require("@modelcontextprotocol/sdk/client");
  const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

  const transport = new StdioClientTransport({
    command: cmd,
    args,
    env: server.env ? { ...getDefaultEnv(), ...server.env } : getDefaultEnv(),
    stderr: "inherit",
  });

  const client = new Client(
    { name: "stremio-ai-search", version: "1.0.0" },
    { capabilities: {} }
  );

  await withTimeout(client.connect(transport), timeoutMs, `MCP connect timed out: ${server.id}`);
  return { client, transport, timeoutMs };
}

function withTimeout(promise, timeoutMs, message) {
  let id;
  const timeout = new Promise((_, reject) => {
    id = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(id));
}

const cachedMcps = new Map();
async function getMcp(server) {
  if (!isMcpEnabled()) return null;
  if (!server) return null;
  const key = server.id;
  if (cachedMcps.has(key)) return cachedMcps.get(key);
  const started = await startMcpClient(server);
  cachedMcps.set(key, started);
  return started;
}

function getTotalMaxContextChars() {
  return Number(process.env.MCP_MAX_CONTEXT_CHARS || 8000);
}

async function getMcpContext(vars, options = {}) {
  if (!isMcpEnabled()) return null;
  let servers = options.servers;
  if (!servers) {
    try {
      servers = getServersFromEnv();
    } catch (error) {
      logger.warn("Failed to load MCP server config; disabling MCP context", {
        error: error?.message || String(error),
      });
      return null;
    }
  }
  if (!Array.isArray(servers) || servers.length === 0) return null;

  const toolRunner =
    options.toolRunner ||
    (async (server, name, renderedArgs) => {
      const mcp = await getMcp(server);
      if (!mcp) throw new Error("MCP client unavailable");
      return await withTimeout(
        mcp.client.callTool({ name, arguments: renderedArgs }),
        mcp.timeoutMs,
        `MCP tool call timed out: ${server.id}:${name}`
      );
    });

  const results = [];

  for (const server of servers) {
    if (!server?.enabled) continue;
    const toolCalls = Array.isArray(server.toolCalls) ? server.toolCalls : [];
    if (toolCalls.length === 0) continue;

    const serverResults = { serverId: server.id, toolCalls: [] };
    for (const toolCall of toolCalls) {
      const name = toolCall?.name;
      const args = toolCall?.args || {};
      if (!name || typeof name !== "string") continue;

      const renderedArgs = substituteTemplate(args, vars);
      try {
        const res = await toolRunner(server, name, renderedArgs);
        serverResults.toolCalls.push({
          name,
          arguments: renderedArgs,
          result: res,
        });
      } catch (error) {
        serverResults.toolCalls.push({
          name,
          arguments: renderedArgs,
          error: error?.message || String(error),
        });
      }
    }

    if (serverResults.toolCalls.length > 0) results.push(serverResults);
  }

  if (results.length === 0) return null;

  const maxChars = getTotalMaxContextChars();
  const text = JSON.stringify(results, null, 2);
  return text.length > maxChars ? text.slice(0, maxChars) + "\n...truncated" : text;
}

module.exports = {
  getMcpContext,
  isMcpEnabled,
  substituteTemplate,
  getServersFromEnv,
};
