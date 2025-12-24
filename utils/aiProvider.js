let fetchFn = globalThis.fetch;
if (!fetchFn) {
  try {
    const nodeFetch = require("node-fetch");
    fetchFn = nodeFetch.default || nodeFetch;
  } catch {
    // If neither global fetch nor node-fetch exists, callers will get a clear error at runtime.
    fetchFn = null;
  }
}

const fetch = fetchFn ? fetchFn.bind(globalThis) : null;

function normalizeProviderName(provider) {
  if (!provider) return null;
  const normalized = String(provider).trim().toLowerCase();
  if (normalized === "gemini" || normalized === "google") return "gemini";
  if (
    normalized === "openai" ||
    normalized === "openai-compat" ||
    normalized === "openai_compat" ||
    normalized === "openai-compatible" ||
    normalized === "openrouter" ||
    normalized === "zai"
  ) {
    return "openai-compat";
  }
  return null;
}

function getOpenAIChatCompletionsUrl(baseUrl) {
  const raw = (baseUrl || "").trim().replace(/\/+$/, "");
  if (!raw) return "https://api.openai.com/v1/chat/completions";
  if (raw.includes("/chat/completions")) return raw;
  if (raw.endsWith("/v1")) return `${raw}/chat/completions`;
  return `${raw}/v1/chat/completions`;
}

function getAiProviderConfigFromConfig(configData = {}) {
  const provider = normalizeProviderName(configData.AiProvider);

  if (provider === "openai-compat") {
    return {
      provider: "openai-compat",
      apiKey: (configData.OpenAICompatApiKey || "").trim(),
      baseUrl: (configData.OpenAICompatBaseUrl || "").trim(),
      model: (configData.OpenAICompatModel || "gpt-4o-mini").trim(),
    };
  }

  if (provider === "gemini") {
    return {
      provider: "gemini",
      apiKey: (configData.GeminiApiKey || "").trim(),
      model: (configData.GeminiModel || "gemini-2.5-flash-lite").trim(),
    };
  }

  // Backwards compatibility: older configs only had Gemini fields.
  const hasGeminiKey = !!(configData.GeminiApiKey && String(configData.GeminiApiKey).trim());
  const hasOpenAICompatKey = !!(
    configData.OpenAICompatApiKey && String(configData.OpenAICompatApiKey).trim()
  );

  if (hasOpenAICompatKey && !hasGeminiKey) {
    return {
      provider: "openai-compat",
      apiKey: String(configData.OpenAICompatApiKey).trim(),
      baseUrl: (configData.OpenAICompatBaseUrl || "").trim(),
      model: (configData.OpenAICompatModel || "gpt-4o-mini").trim(),
    };
  }

  return {
    provider: "gemini",
    apiKey: (configData.GeminiApiKey || "").trim(),
    model: (configData.GeminiModel || "gemini-2.5-flash-lite").trim(),
  };
}

function createAiTextGenerator(aiProviderConfig) {
  if (!aiProviderConfig || !aiProviderConfig.provider) {
    throw new Error("AI provider configuration is missing");
  }

  if (aiProviderConfig.provider === "gemini") {
    return {
      provider: "gemini",
      model: aiProviderConfig.model,
      async generateText(prompt) {
        const { GoogleGenerativeAI } = require("@google/generative-ai");
        const genAI = new GoogleGenerativeAI(aiProviderConfig.apiKey);
        const model = genAI.getGenerativeModel({ model: aiProviderConfig.model });
        const aiResult = await model.generateContent(prompt);
        return aiResult.response.text().trim();
      },
    };
  }

  if (aiProviderConfig.provider === "openai-compat") {
    return {
      provider: "openai-compat",
      model: aiProviderConfig.model,
      async generateText(prompt) {
        if (!fetch) {
          throw new Error(
            "Fetch API is not available (need Node 18+ or install node-fetch)"
          );
        }
        const url = getOpenAIChatCompletionsUrl(aiProviderConfig.baseUrl);
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${aiProviderConfig.apiKey}`,
          },
          body: JSON.stringify({
            model: aiProviderConfig.model,
            messages: [{ role: "user", content: prompt }],
            temperature: 0.2,
          }),
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => "");
          const error = new Error(
            `OpenAI-compatible API error (Status: ${response.status})${errorText ? `: ${errorText}` : ""}`
          );
          error.status = response.status;
          throw error;
        }

        const data = await response.json();
        const content =
          data?.choices?.[0]?.message?.content ??
          data?.choices?.[0]?.text ??
          "";

        return String(content).trim();
      },
    };
  }

  throw new Error(`Unsupported AI provider: ${aiProviderConfig.provider}`);
}

module.exports = {
  createAiTextGenerator,
  getAiProviderConfigFromConfig,
  getOpenAIChatCompletionsUrl,
};
