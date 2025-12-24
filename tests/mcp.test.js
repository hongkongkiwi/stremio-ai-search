const assert = require("assert");

const { substituteTemplate, isMcpEnabled, getMcpContext } = require("../utils/mcp");

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

  process.env.MCP_ENABLED = prevEnabled;
  process.env.MCP_ALLOW_SPAWN = prevAllow;
}

module.exports.run = async function run() {
  await testTemplateSubstitution();
  await testMcpDisabledNoContext();
};

