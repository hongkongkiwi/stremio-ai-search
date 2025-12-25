const assert = require("assert");
const path = require("path");

const { getMcpContext } = require("../utils/mcp");
const { createAiTextGenerator, getAiProviderConfigFromConfig } = require("../utils/aiProvider");

async function run() {
  process.env.AI_USE_TANSTACK = "true";
  process.env.AI_TANSTACK_MODULES_PATH = path.join(
    process.cwd(),
    "tests",
    "fixtures",
    "tanstack-mock.mjs"
  );

  process.env.MCP_ENABLED = "true";
  process.env.MCP_ALLOW_SPAWN = "true";
  process.env.MCP_SERVERS_JSON = JSON.stringify([
    {
      id: "mock",
      cmd: "node",
      args: ["scripts/mock-mcp-server.js"],
      toolCalls: [{ name: "mock.search", args: { query: "{{query}}" } }],
    },
  ]);

  const mcpContext = await getMcpContext({ query: "hello", type: "movie" });
  assert.ok(mcpContext && mcpContext.includes("mock:hello"), "MCP context missing");

  const config = getAiProviderConfigFromConfig({
    AiProvider: "openai-compat",
    OpenAICompatApiKey: "sk-test",
    OpenAICompatModel: "openai/gpt-4o-mini",
  });

  const client = createAiTextGenerator(config);
  const prompt = `TEST\nMCP CONTEXT (JSON)\n${mcpContext}`;
  const text = await client.generateText(prompt);
  assert.ok(text.includes("openai:openai/gpt-4o-mini:ok"), "TanStack mock failed");

  // Clean up env for other scripts
  delete process.env.AI_USE_TANSTACK;
  delete process.env.AI_TANSTACK_MODULES_PATH;
  delete process.env.MCP_ENABLED;
  delete process.env.MCP_ALLOW_SPAWN;
  delete process.env.MCP_SERVERS_JSON;

  console.log("smoke-tanstack-mcp ok");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
