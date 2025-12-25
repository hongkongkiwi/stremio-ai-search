export function createOpenaiChat(model, apiKey, config) {
  return { kind: "openai", model, apiKey, config };
}

export function createGeminiChat(model, apiKey, config) {
  return { kind: "gemini", model, apiKey, config };
}

export async function streamToText(stream) {
  let out = "";
  for await (const chunk of stream) {
    if (chunk && chunk.type === "content" && chunk.delta) out += chunk.delta;
  }
  return out;
}

export function chat(options) {
  const { adapter, model } = options || {};
  async function* run() {
    const prefix = adapter && adapter.kind ? adapter.kind : "mock";
    const name = model ? String(model) : "";
    yield { type: "content", delta: `${prefix}:${name}:ok` };
  }
  return run();
}
