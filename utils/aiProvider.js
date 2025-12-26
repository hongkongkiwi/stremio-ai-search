const fetch = require("./fetch");
const path = require("path");
const { pathToFileURL } = require("url");
const { isTruthyValue, getNumberEnv } = require("./env");
const { withRetry } = require("./apiRetry");

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

function normalizeTemperature(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return undefined;
  return Math.max(0, Math.min(1, num));
}

function parseOptionalJsonObject(text) {
  if (!text) return null;
  const raw = String(text).trim();
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Extra headers must be a JSON object");
  }
  return parsed;
}

function buildExtraHeaders(extraHeaders) {
  if (!extraHeaders) return {};

  const forbidden = new Set(["authorization", "content-type", "content-length", "host"]);
  const headers = {};

  for (const [key, value] of Object.entries(extraHeaders)) {
    const headerName = String(key).trim();
    if (!headerName) continue;
    if (forbidden.has(headerName.toLowerCase())) continue;
    if (value === undefined || value === null) continue;
    headers[headerName] = String(value);
  }

  return headers;
}

function isModuleNotFound(error) {
  if (!error) return false;
  return (
    error.code === "ERR_MODULE_NOT_FOUND" ||
    error.code === "MODULE_NOT_FOUND" ||
    /Cannot find module/i.test(error.message || "")
  );
}

function isTanstackEnabled() {
  const raw = String(process.env.AI_USE_TANSTACK || "").trim().toLowerCase();
  if (!raw) return true;
  return raw !== "false" && raw !== "0" && raw !== "no";
}

let cachedTanstackModules = null;
async function loadTanstackModules() {
  if (cachedTanstackModules) return cachedTanstackModules;
  if (!isTanstackEnabled()) return null;

  try {
    const overridePath = process.env.AI_TANSTACK_MODULES_PATH;
    if (overridePath && String(overridePath).trim()) {
      if (!isTruthyValue(process.env.AI_ALLOW_TANSTACK_OVERRIDE) && process.env.NODE_ENV !== "test") {
        throw new Error("TanStack override path is disabled; set AI_ALLOW_TANSTACK_OVERRIDE=true to enable");
      }
      const resolved = pathToFileURL(path.resolve(String(overridePath))).href;
      const override = await import(resolved);
      const chat = override.chat;
      const streamToText = override.streamToText;
      const createOpenaiChat = override.createOpenaiChat;
      const createGeminiChat = override.createGeminiChat;
      if (!chat || !streamToText || !createOpenaiChat || !createGeminiChat) {
        throw new Error("TanStack AI override missing expected exports");
      }
      cachedTanstackModules = { chat, streamToText, createOpenaiChat, createGeminiChat };
      return cachedTanstackModules;
    }

    const aiCore = await import("@tanstack/ai");
    const openaiAdapters = await import("@tanstack/ai-openai");
    const geminiAdapters = await import("@tanstack/ai-gemini");

    const chat = aiCore.chat || (aiCore.default && aiCore.default.chat);
    const streamToText =
      aiCore.streamToText || (aiCore.default && aiCore.default.streamToText);
    const createOpenaiChat =
      openaiAdapters.createOpenaiChat ||
      (openaiAdapters.default && openaiAdapters.default.createOpenaiChat);
    const createGeminiChat =
      geminiAdapters.createGeminiChat ||
      (geminiAdapters.default && geminiAdapters.default.createGeminiChat);

    if (!chat || !streamToText || !createOpenaiChat || !createGeminiChat) {
      throw new Error("TanStack AI adapters missing expected exports");
    }

    cachedTanstackModules = { chat, streamToText, createOpenaiChat, createGeminiChat };
    return cachedTanstackModules;
  } catch (error) {
    if (isModuleNotFound(error)) {
      return null;
    }
    throw error;
  }
}

function extractChunkText(chunk) {
  if (chunk === undefined || chunk === null) return "";
  if (typeof chunk === "string") return chunk;
  if (typeof chunk === "number") return String(chunk);
  if (typeof chunk === "object") {
    if (typeof chunk.text === "string") return chunk.text;
    if (typeof chunk.content === "string") return chunk.content;
    if (chunk.delta && typeof chunk.delta.content === "string") return chunk.delta.content;
    if (chunk.value && typeof chunk.value === "string") return chunk.value;
  }
  return "";
}

async function generateWithTanstackAi({
  adapter,
  model,
  prompt,
  temperature,
  timeoutMs,
}) {
  const modules = await loadTanstackModules();
  if (!modules || !modules.chat || !modules.streamToText) {
    throw new Error("TanStack AI is not available");
  }
  const { chat, streamToText } = modules;

  const run = async () => {
    const stream = chat({
      adapter,
      model,
      messages: [{ role: "user", content: [{ type: "text", content: prompt }] }],
      temperature: typeof temperature === "number" ? temperature : undefined,
    });

    if (stream && typeof streamToText === "function") {
      const text = await streamToText(stream);
      return String(text || "").trim();
    }

    let text = "";
    if (stream && typeof stream[Symbol.asyncIterator] === "function") {
      for await (const chunk of stream) {
        text += extractChunkText(chunk);
      }
      return text.trim();
    }

    return String(stream || "").trim();
  };

  const execWithTimeout = async () => {
    if (typeof timeoutMs === "number" && timeoutMs > 0) {
      let timeoutId;
      try {
        return await Promise.race([
          run(),
          new Promise((_, reject) => {
            timeoutId = setTimeout(() => {
              const err = new Error(`TanStack AI request timed out after ${timeoutMs}ms`);
              err.status = 504;
              reject(err);
            }, timeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(timeoutId);
      }
    }
    return run();
  };

  const retryOptions = {
    maxRetries: getNumberEnv("AI_RETRY_ATTEMPTS", 2),
    initialDelay: getNumberEnv("AI_RETRY_BASE_MS", 300),
    maxDelay: getNumberEnv("AI_RETRY_MAX_MS", 2000),
    shouldRetry: (error) => !error.status || error.status >= 500 || error.status === 429,
    operationName: "TanStack AI call",
  };

  return withRetry(execWithTimeout, retryOptions);
}

function getAiProviderConfigFromConfig(configData = {}) {
  const provider = normalizeProviderName(configData.AiProvider);
  const temperature = normalizeTemperature(configData.AiTemperature);

  if (provider === "openai-compat") {
    return {
      provider: "openai-compat",
      apiKey: (configData.OpenAICompatApiKey || "").trim(),
      baseUrl: (configData.OpenAICompatBaseUrl || "").trim(),
      model: (configData.OpenAICompatModel || "gpt-4o-mini").trim(),
      extraHeaders: (configData.OpenAICompatExtraHeaders || "").trim(),
      timeoutMs: Number(configData.OpenAICompatTimeoutMs) || undefined,
      temperature,
    };
  }

  if (provider === "gemini") {
    return {
      provider: "gemini",
      apiKey: (configData.GeminiApiKey || "").trim(),
      model: (configData.GeminiModel || "gemini-2.5-flash-lite").trim(),
      temperature,
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
      extraHeaders: (configData.OpenAICompatExtraHeaders || "").trim(),
      timeoutMs: Number(configData.OpenAICompatTimeoutMs) || undefined,
      temperature,
    };
  }

  return {
    provider: "gemini",
    apiKey: (configData.GeminiApiKey || "").trim(),
    model: (configData.GeminiModel || "gemini-2.5-flash-lite").trim(),
    temperature,
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
        // Test hook: allow mocking Gemini through a local OpenAI-compatible endpoint.
        // Only active when GEMINI_MOCK_BASE_URL is set.
        const mockBaseUrl = (process.env.GEMINI_MOCK_BASE_URL || "").trim();
        if (mockBaseUrl) {
          const url = getOpenAIChatCompletionsUrl(mockBaseUrl);
          const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: "Bearer mock" },
            body: JSON.stringify({
              model: "mock",
              messages: [{ role: "user", content: prompt }],
              temperature:
                typeof aiProviderConfig.temperature === "number"
                  ? aiProviderConfig.temperature
                  : 0.2,
              max_tokens: 800,
            }),
          });
          if (!response.ok) {
            const errorText = await response.text().catch(() => "");
            const error = new Error(
              `Gemini mock API error (Status: ${response.status})${errorText ? `: ${errorText}` : ""}`
            );
            error.status = response.status;
            throw error;
          }
          const data = await response.json();
          const content = data?.choices?.[0]?.message?.content ?? "";
          return String(content).trim();
        }

        const tanstack = await loadTanstackModules();
        if (tanstack) {
          const adapter = tanstack.createGeminiChat(
            aiProviderConfig.model,
            aiProviderConfig.apiKey,
            {}
          );
          return await generateWithTanstackAi({
            adapter,
            model: aiProviderConfig.model,
            prompt,
            temperature: aiProviderConfig.temperature,
          });
        }

        const { GoogleGenerativeAI } = require("@google/generative-ai");
        const genAI = new GoogleGenerativeAI(aiProviderConfig.apiKey);
        const model = genAI.getGenerativeModel({
          model: aiProviderConfig.model,
          generationConfig: {
            temperature:
              typeof aiProviderConfig.temperature === "number"
                ? aiProviderConfig.temperature
                : 0.2,
          },
        });
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
        let extraHeadersObj;
        try {
          extraHeadersObj = parseOptionalJsonObject(aiProviderConfig.extraHeaders);
        } catch (error) {
          const parseError = new Error(`Invalid extra headers JSON: ${error.message}`);
          parseError.status = 400;
          throw parseError;
        }

        const tanstack = await loadTanstackModules();
        if (tanstack) {
          const adapter = tanstack.createOpenaiChat(
            aiProviderConfig.model,
            aiProviderConfig.apiKey,
            {
              baseUrl: aiProviderConfig.baseUrl || undefined,
              baseURL: aiProviderConfig.baseUrl || undefined,
              headers: buildExtraHeaders(extraHeadersObj),
            }
          );
          return await generateWithTanstackAi({
            adapter,
            model: aiProviderConfig.model,
            prompt,
            temperature: aiProviderConfig.temperature,
            timeoutMs:
              typeof aiProviderConfig.timeoutMs === "number" && aiProviderConfig.timeoutMs > 0
                ? aiProviderConfig.timeoutMs
                : undefined,
          });
        }

        const timeoutMs =
          typeof aiProviderConfig.timeoutMs === "number" && aiProviderConfig.timeoutMs > 0
            ? aiProviderConfig.timeoutMs
            : 30000;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        const url = getOpenAIChatCompletionsUrl(aiProviderConfig.baseUrl);
        const retryOptions = {
          maxRetries: getNumberEnv("AI_RETRY_ATTEMPTS", 2),
          initialDelay: getNumberEnv("AI_RETRY_BASE_MS", 300),
          maxDelay: getNumberEnv("AI_RETRY_MAX_MS", 2000),
          shouldRetry: (error) => !error.status || error.status >= 500 || error.status === 429,
          operationName: "OpenAI-compatible call",
        };

        let response;
        try {
          response = await withRetry(async () => {
            return await fetch(url, {
              method: "POST",
              signal: controller.signal,
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${aiProviderConfig.apiKey}`,
                ...buildExtraHeaders(extraHeadersObj),
              },
              body: JSON.stringify({
                model: aiProviderConfig.model,
                messages: [{ role: "user", content: prompt }],
                temperature:
                  typeof aiProviderConfig.temperature === "number"
                    ? aiProviderConfig.temperature
                    : 0.2,
                max_tokens: 800,
              }),
            });
          }, retryOptions);
        } catch (error) {
          if (error && error.name === "AbortError") {
            const timeoutError = new Error(
              `OpenAI-compatible API request timed out after ${timeoutMs}ms`
            );
            timeoutError.status = 504;
            throw timeoutError;
          }
          throw error;
        } finally {
          clearTimeout(timeoutId);
        }

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
