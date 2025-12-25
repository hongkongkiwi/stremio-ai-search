const assert = require("assert");

const { substituteTemplate, isMcpEnabled, getMcpContext, getServersFromEnv } = require("../utils/mcp");

async function testTemplateSubstitution() {
  const vars = { query: "hello", type: "movie", n: 3 };
  assert.equal(substituteTemplate("q={{query}} t={{type}}", vars), "q=hello t=movie");
  assert.deepEqual(substituteTemplate(["{{query}}", "{{type}}"], vars), ["hello", "movie"]);
  assert.deepEqual(
    substituteTemplate({ a: "{{query}}", b: { c: "{{n}}" } }, vars),
    { a: "hello", b: { c: "3" } }
  );
}

async function testMcpDisabledNoContext() {
  const prevEnabled = process.env.MCP_ENABLED;
  const prevAllow = process.env.MCP_ALLOW_SPAWN;
  delete process.env.MCP_ENABLED;
  delete process.env.MCP_ALLOW_SPAWN;

  assert.equal(isMcpEnabled(), false);
  const ctx = await getMcpContext({ query: "x", type: "movie" });
  assert.equal(ctx, null);

  if (prevEnabled === undefined) delete process.env.MCP_ENABLED;
  else process.env.MCP_ENABLED = prevEnabled;
  if (prevAllow === undefined) delete process.env.MCP_ALLOW_SPAWN;
  else process.env.MCP_ALLOW_SPAWN = prevAllow;
}

async function testServersJsonParsing() {
  const prev = process.env.MCP_SERVERS_JSON;
  const serversRaw = [
    {
      id: "web",
      cmd: "npx",
      args: ["-y", "@modelcontextprotocol/server-foo"],
      toolCalls: [{ name: "web.search", args: { query: "{{query}}", limit: 3 } }],
    },
    {
      // Intentionally omit id to validate default.
      cmd: "node",
      args: ["server.js"],
      toolCalls: [{ name: "notes.list", args: {} }],
    },
  ];

  process.env.MCP_SERVERS_JSON = JSON.stringify(serversRaw);
  const servers = getServersFromEnv();
  assert.equal(Array.isArray(servers), true);
  assert.equal(servers.length, 2);
  assert.equal(servers[0].id, "web");
  assert.equal(servers[1].id, "mcp_2");

  if (prev === undefined) delete process.env.MCP_SERVERS_JSON;
  else process.env.MCP_SERVERS_JSON = prev;
}

async function testMcpServersObjectParsing() {
  const prev = process.env.MCP_SERVERS_JSON;
  const cfg = {
    mcpServers: {
      web: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-foo"],
        env: { FOO: "bar" },
        toolCalls: [{ name: "web.search", args: { query: "{{query}}" } }],
      },
      disabledOne: {
        command: "node",
        args: ["server.js"],
        disabled: true,
        toolCalls: [{ name: "noop", args: {} }],
      },
    },
  };

  process.env.MCP_SERVERS_JSON = JSON.stringify(cfg);
  const servers = getServersFromEnv();
  assert.equal(servers.length, 2);
  assert.equal(servers[0].id, "web");
  assert.equal(servers[0].cmd, "npx");
  assert.deepEqual(servers[0].env, { FOO: "bar" });
  assert.equal(servers[1].id, "disabledOne");
  assert.equal(servers[1].enabled, false);

  if (prev === undefined) delete process.env.MCP_SERVERS_JSON;
  else process.env.MCP_SERVERS_JSON = prev;
}

async function testMultipleServersContextUsesTemplates() {
  const prevEnabled = process.env.MCP_ENABLED;
  process.env.MCP_ENABLED = "true";

  const servers = [
    {
      id: "s1",
      enabled: true,
      toolCalls: [{ name: "t1", args: { q: "{{query}}" } }],
    },
    {
      id: "s2",
      enabled: true,
      toolCalls: [{ name: "t2", args: { t: "{{type}}" } }],
    },
  ];

  const ctx = await getMcpContext(
    { query: "hello", type: "movie" },
    {
      servers,
      toolRunner: async (server, name, renderedArgs) => ({
        ok: true,
        serverId: server.id,
        name,
        args: renderedArgs,
      }),
    }
  );

  assert.ok(ctx && typeof ctx === "string");
  const parsed = JSON.parse(ctx);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].serverId, "s1");
  assert.equal(parsed[0].toolCalls[0].name, "t1");
  assert.deepEqual(parsed[0].toolCalls[0].arguments, { q: "hello" });
  assert.equal(parsed[1].serverId, "s2");
  assert.deepEqual(parsed[1].toolCalls[0].arguments, { t: "movie" });

  if (prevEnabled === undefined) delete process.env.MCP_ENABLED;
  else process.env.MCP_ENABLED = prevEnabled;
}

async function testInvalidServersJsonDisablesContext() {
  const prevEnabled = process.env.MCP_ENABLED;
  const prevServers = process.env.MCP_SERVERS_JSON;
  process.env.MCP_ENABLED = "true";
  process.env.MCP_SERVERS_JSON = "not-json";

  const ctx = await getMcpContext({ query: "x", type: "movie" });
  assert.equal(ctx, null);

  if (prevEnabled === undefined) delete process.env.MCP_ENABLED;
  else process.env.MCP_ENABLED = prevEnabled;
  if (prevServers === undefined) delete process.env.MCP_SERVERS_JSON;
  else process.env.MCP_SERVERS_JSON = prevServers;
}

module.exports.run = async function run() {
  await testTemplateSubstitution();
  await testMcpDisabledNoContext();
  await testServersJsonParsing();
  await testMcpServersObjectParsing();
  await testMultipleServersContextUsesTemplates();
  await testInvalidServersJsonDisablesContext();
};
