const { spawn } = require("child_process");
const logger = require("./logger");

function parseJsonEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw || !String(raw).trim()) return fallback;
  return JSON.parse(raw);
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
  return String(process.env.MCP_ENABLED || "").toLowerCase() === "true";
}

function isMcpSpawnAllowed() {
  return String(process.env.MCP_ALLOW_SPAWN || "").toLowerCase() === "true";
}

async function startMcpClient() {
  if (!isMcpEnabled()) return null;
  if (!isMcpSpawnAllowed()) {
    throw new Error("MCP is enabled but MCP_ALLOW_SPAWN is not true");
  }

  const cmd = String(process.env.MCP_SERVER_CMD || "").trim();
  if (!cmd) throw new Error("MCP_SERVER_CMD is required when MCP is enabled");

  const args = parseJsonEnv("MCP_SERVER_ARGS", []);
  if (!Array.isArray(args)) throw new Error("MCP_SERVER_ARGS must be a JSON array");

  const timeoutMs = Number(process.env.MCP_TIMEOUT_MS || 5000);

  const child = spawn(cmd, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  child.on("exit", (code, signal) => {
    logger.warn("MCP server exited", { code, signal });
  });

  // MCP SDK is ESM-first; use subpath exports that provide CJS entry points.
  const { Client } = require("@modelcontextprotocol/sdk/client");
  const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

  const transport = new StdioClientTransport({
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
  });

  const client = new Client(
    { name: "stremio-ai-search", version: "1.0.0" },
    { capabilities: {} }
  );

  await withTimeout(client.connect(transport), timeoutMs, "MCP connect timed out");
  return { client, child, timeoutMs };
}

function withTimeout(promise, timeoutMs, message) {
  let id;
  const timeout = new Promise((_, reject) => {
    id = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(id));
}

let cachedMcp = null;
async function getMcp() {
  if (!isMcpEnabled()) return null;
  if (cachedMcp) return cachedMcp;
  cachedMcp = await startMcpClient();
  return cachedMcp;
}

async function getMcpContext(vars) {
  const mcp = await getMcp();
  if (!mcp) return null;

  const toolCalls = parseJsonEnv("MCP_TOOL_CALLS", []);
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return null;

  const results = [];
  for (const toolCall of toolCalls) {
    const name = toolCall?.name;
    const args = toolCall?.args || {};
    if (!name || typeof name !== "string") continue;

    const renderedArgs = substituteTemplate(args, vars);
    try {
      const res = await withTimeout(
        mcp.client.callTool({ name, arguments: renderedArgs }),
        mcp.timeoutMs,
        `MCP tool call timed out: ${name}`
      );

      // `content` can be rich; we stringify conservatively.
      results.push({
        name,
        arguments: renderedArgs,
        result: res,
      });
    } catch (error) {
      results.push({
        name,
        arguments: renderedArgs,
        error: error.message,
      });
    }
  }

  if (results.length === 0) return null;

  const maxChars = Number(process.env.MCP_MAX_CONTEXT_CHARS || 8000);
  const text = JSON.stringify(results, null, 2);
  return text.length > maxChars ? text.slice(0, maxChars) + "\n...truncated" : text;
}

module.exports = {
  getMcpContext,
  isMcpEnabled,
  substituteTemplate,
};
