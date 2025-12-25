const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");

const server = new McpServer({ name: "MockMcpServer", version: "1.0.0" });

server.registerTool(
  "mock.search",
  {
    description: "Return a mock search result",
  },
  async (params) => {
    const query = params?.query ? String(params.query) : "";
    return {
      content: [{ type: "text", text: `mock:${query}` }],
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
