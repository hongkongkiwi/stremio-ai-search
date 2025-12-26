const assert = require("assert");
const path = require("path");

function freshRequireAiProviderWithFetch(fetchImpl) {
  const modulePath = path.join(process.cwd(), "utils", "aiProvider.js");
  const fetchPath = path.join(process.cwd(), "utils", "fetch.js");
  delete require.cache[require.resolve(modulePath)];
  delete require.cache[require.resolve(fetchPath)];
  const previousFetch = global.fetch;
  global.fetch = fetchImpl;
  const mod = require(modulePath);
  global.fetch = previousFetch;
  return mod;
}

function withEnv(key, value, fn) {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  return fn().finally(() => {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  });
}

function createCapturingFetch() {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      async json() {
        return { choices: [{ message: { content: "ok" } }] };
      },
      async text() {
        return "";
      },
    };
  };
  return { fetch, calls };
}

function createAbortAwareHangingFetch() {
  const calls = [];
  const fetch = (url, options) => {
    calls.push({ url, options });
    return new Promise((resolve, reject) => {
      if (options && options.signal) {
        if (options.signal.aborted) {
          const err = new Error("Aborted");
          err.name = "AbortError";
          reject(err);
          return;
        }
        options.signal.addEventListener(
          "abort",
          () => {
            const err = new Error("Aborted");
            err.name = "AbortError";
            reject(err);
          },
          { once: true }
        );
      }
      // Never resolve: simulates a hung upstream until aborted.
    });
  };
  return { fetch, calls };
}

async function testChatCompletionsUrl() {
  const { getOpenAIChatCompletionsUrl } = require("../utils/aiProvider");

  assert.equal(
    getOpenAIChatCompletionsUrl(""),
    "https://api.openai.com/v1/chat/completions"
  );
  assert.equal(
    getOpenAIChatCompletionsUrl("https://api.openai.com"),
    "https://api.openai.com/v1/chat/completions"
  );
  assert.equal(
    getOpenAIChatCompletionsUrl("https://openrouter.ai/api"),
    "https://openrouter.ai/api/v1/chat/completions"
  );
  assert.equal(
    getOpenAIChatCompletionsUrl("https://openrouter.ai/api/v1"),
    "https://openrouter.ai/api/v1/chat/completions"
  );
  assert.equal(
    getOpenAIChatCompletionsUrl("https://example.com/v1/chat/completions"),
    "https://example.com/v1/chat/completions"
  );
}

async function testTemperatureClamping() {
  const { getAiProviderConfigFromConfig } = require("../utils/aiProvider");

  assert.equal(
    getAiProviderConfigFromConfig({ AiProvider: "gemini", AiTemperature: 0 })
      .temperature,
    0
  );
  assert.equal(
    getAiProviderConfigFromConfig({ AiProvider: "gemini", AiTemperature: 2 })
      .temperature,
    1
  );
  assert.equal(
    getAiProviderConfigFromConfig({ AiProvider: "gemini", AiTemperature: -1 })
      .temperature,
    0
  );
  assert.equal(
    getAiProviderConfigFromConfig({ AiProvider: "gemini", AiTemperature: "0.7" })
      .temperature,
    0.7
  );

  // Default (unset / invalid)
  assert.equal(
    getAiProviderConfigFromConfig({ AiProvider: "gemini" }).temperature,
    undefined
  );
  assert.equal(
    getAiProviderConfigFromConfig({ AiProvider: "gemini", AiTemperature: "nope" })
      .temperature,
    undefined
  );
}

async function testProviderNormalizationAndFallbacks() {
  const { getAiProviderConfigFromConfig } = require("../utils/aiProvider");

  // Synonyms normalize
  assert.equal(
    getAiProviderConfigFromConfig({ AiProvider: "openrouter", OpenAICompatApiKey: "k" })
      .provider,
    "openai-compat"
  );
  assert.equal(
    getAiProviderConfigFromConfig({ AiProvider: "openai", OpenAICompatApiKey: "k" })
      .provider,
    "openai-compat"
  );
  assert.equal(
    getAiProviderConfigFromConfig({ AiProvider: "zai", OpenAICompatApiKey: "k" })
      .provider,
    "openai-compat"
  );
  assert.equal(
    getAiProviderConfigFromConfig({ AiProvider: "google", GeminiApiKey: "k" }).provider,
    "gemini"
  );

  // Backward compatibility fallbacks
  assert.equal(
    getAiProviderConfigFromConfig({ OpenAICompatApiKey: "k", OpenAICompatModel: "m" })
      .provider,
    "openai-compat"
  );
  assert.equal(getAiProviderConfigFromConfig({ GeminiApiKey: "k" }).provider, "gemini");
}

async function testOpenAICompatPayloadAndHeaders() {
  await withEnv("AI_USE_TANSTACK", "false", async () => {
    const { fetch, calls } = createCapturingFetch();
    const aiProvider = freshRequireAiProviderWithFetch(fetch);

    const config = aiProvider.getAiProviderConfigFromConfig({
      AiProvider: "openai-compat",
      OpenAICompatApiKey: "sk-test",
      OpenAICompatBaseUrl: "https://openrouter.ai/api",
      OpenAICompatModel: "openai/gpt-4o-mini",
      OpenAICompatExtraHeaders:
        '{"HTTP-Referer":"https://example.com","X-Title":"Stremio AI Search","Authorization":"NOPE","Content-Type":"nope"}',
      AiTemperature: 0,
    });

    const client = aiProvider.createAiTextGenerator(config);
    const text = await client.generateText("hello");
    assert.equal(text, "ok");

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://openrouter.ai/api/v1/chat/completions");

    const headers = calls[0].options.headers;
    assert.equal(headers.Authorization, "Bearer sk-test");
    assert.equal(headers["Content-Type"], "application/json");
    assert.equal(headers["HTTP-Referer"], "https://example.com");
    assert.equal(headers["X-Title"], "Stremio AI Search");
    // Forbidden overrides should be ignored
    assert.equal(headers.Authorization, "Bearer sk-test");
    assert.equal(headers["Content-Type"], "application/json");

    const payload = JSON.parse(calls[0].options.body);
    assert.equal(payload.model, "openai/gpt-4o-mini");
    assert.equal(payload.temperature, 0);
    assert.equal(payload.max_tokens, 800);
    assert.deepEqual(payload.messages, [{ role: "user", content: "hello" }]);
  });
}

async function testOpenAICompatExtraHeadersInvalidJson() {
  await withEnv("AI_USE_TANSTACK", "false", async () => {
    const { fetch } = createCapturingFetch();
    const aiProvider = freshRequireAiProviderWithFetch(fetch);

    const config = aiProvider.getAiProviderConfigFromConfig({
      AiProvider: "openai-compat",
      OpenAICompatApiKey: "sk-test",
      OpenAICompatModel: "gpt-4o-mini",
      OpenAICompatExtraHeaders: "{not-json}",
    });

    const client = aiProvider.createAiTextGenerator(config);
    await assert.rejects(
      () => client.generateText("hello"),
      (err) => err && err.status === 400
    );
  });
}

async function testOpenAICompatExtraHeadersMustBeObject() {
  await withEnv("AI_USE_TANSTACK", "false", async () => {
    const { fetch } = createCapturingFetch();
    const aiProvider = freshRequireAiProviderWithFetch(fetch);

    const config = aiProvider.getAiProviderConfigFromConfig({
      AiProvider: "openai-compat",
      OpenAICompatApiKey: "sk-test",
      OpenAICompatModel: "gpt-4o-mini",
      OpenAICompatExtraHeaders: '["nope"]',
    });

    const client = aiProvider.createAiTextGenerator(config);
    await assert.rejects(
      () => client.generateText("hello"),
      (err) => err && err.status === 400
    );
  });
}

async function testOpenAICompatTimeoutAbort() {
  await withEnv("AI_USE_TANSTACK", "false", async () => {
    const { fetch, calls } = createAbortAwareHangingFetch();
    const aiProvider = freshRequireAiProviderWithFetch(fetch);

    const config = aiProvider.getAiProviderConfigFromConfig({
      AiProvider: "openai-compat",
      OpenAICompatApiKey: "sk-test",
      OpenAICompatBaseUrl: "https://api.openai.com",
      OpenAICompatModel: "gpt-4o-mini",
      OpenAICompatTimeoutMs: 5,
    });

    const client = aiProvider.createAiTextGenerator(config);
    await assert.rejects(
      () => client.generateText("hello"),
      (err) => err && err.status === 504
    );

    assert.equal(calls.length, 1);
    assert.ok(calls[0].options.signal, "fetch called with an AbortSignal");
  });
}

async function testTanstackOpenAICompatMock() {
  await withEnv("AI_USE_TANSTACK", "true", async () => {
    await withEnv("AI_ALLOW_TANSTACK_OVERRIDE", "true", async () => {
      await withEnv("AI_TANSTACK_MODULES_PATH", "tests/fixtures/tanstack-mock.mjs", async () => {
      const { fetch } = createCapturingFetch();
      const aiProvider = freshRequireAiProviderWithFetch(fetch);
      const config = aiProvider.getAiProviderConfigFromConfig({
        AiProvider: "openai-compat",
        OpenAICompatApiKey: "sk-test",
        OpenAICompatModel: "openai/gpt-4o-mini",
      });
      const client = aiProvider.createAiTextGenerator(config);
      const text = await client.generateText("hello");
      assert.equal(text, "openai:openai/gpt-4o-mini:ok");
      });
    });
  });
}

async function testTanstackGeminiMock() {
  await withEnv("AI_USE_TANSTACK", "true", async () => {
    await withEnv("AI_ALLOW_TANSTACK_OVERRIDE", "true", async () => {
      await withEnv("AI_TANSTACK_MODULES_PATH", "tests/fixtures/tanstack-mock.mjs", async () => {
      const { fetch } = createCapturingFetch();
      const aiProvider = freshRequireAiProviderWithFetch(fetch);
      const config = aiProvider.getAiProviderConfigFromConfig({
        AiProvider: "gemini",
        GeminiApiKey: "k",
        GeminiModel: "gemini-mock",
      });
      const client = aiProvider.createAiTextGenerator(config);
      const text = await client.generateText("hello");
      assert.equal(text, "gemini:gemini-mock:ok");
      });
    });
  });
}

async function testGeminiMockBaseUrlUsesOpenAICompat() {
  await withEnv("AI_USE_TANSTACK", "false", async () => {
    await withEnv("GEMINI_MOCK_BASE_URL", "https://mock.local", async () => {
      const { fetch, calls } = createCapturingFetch();
      const aiProvider = freshRequireAiProviderWithFetch(fetch);
      const config = aiProvider.getAiProviderConfigFromConfig({
        AiProvider: "gemini",
        GeminiApiKey: "k",
        GeminiModel: "gemini-2.5-flash-lite",
        AiTemperature: 0,
      });
      const client = aiProvider.createAiTextGenerator(config);
      const text = await client.generateText("hello");
      assert.equal(text, "ok");
      assert.equal(calls[0].url, "https://mock.local/v1/chat/completions");
      const payload = JSON.parse(calls[0].options.body);
      assert.equal(payload.model, "mock");
      assert.equal(payload.temperature, 0);
    });
  });
}

async function testTanstackOpenAICompatAdapterConfig() {
  await withEnv("AI_USE_TANSTACK", "true", async () => {
    await withEnv("AI_ALLOW_TANSTACK_OVERRIDE", "true", async () => {
      await withEnv("AI_TANSTACK_MODULES_PATH", "tests/fixtures/tanstack-mock-config.mjs", async () => {
      const { fetch } = createCapturingFetch();
      const aiProvider = freshRequireAiProviderWithFetch(fetch);
      const config = aiProvider.getAiProviderConfigFromConfig({
        AiProvider: "openai-compat",
        OpenAICompatApiKey: "sk-test",
        OpenAICompatBaseUrl: "https://openrouter.ai/api",
        OpenAICompatModel: "openai/gpt-4o-mini",
        OpenAICompatExtraHeaders: '{"HTTP-Referer":"https://example.com","X-Title":"Stremio AI Search"}',
      });
      const client = aiProvider.createAiTextGenerator(config);
      const text = await client.generateText("hello");
      const payload = JSON.parse(text);
      assert.equal(payload.kind, "openai");
      assert.equal(payload.model, "openai/gpt-4o-mini");
      assert.equal(payload.adapterModel, "openai/gpt-4o-mini");
      assert.equal(payload.baseUrl, "https://openrouter.ai/api");
      assert.equal(payload.headers["HTTP-Referer"], "https://example.com");
      assert.equal(payload.headers["X-Title"], "Stremio AI Search");
      });
    });
  });
}

module.exports.run = async function run() {
  await testChatCompletionsUrl();
  await testTemperatureClamping();
  await testProviderNormalizationAndFallbacks();
  await testOpenAICompatPayloadAndHeaders();
  await testOpenAICompatExtraHeadersInvalidJson();
  await testOpenAICompatExtraHeadersMustBeObject();
  await testOpenAICompatTimeoutAbort();
  await testTanstackOpenAICompatMock();
  await testTanstackGeminiMock();
  await testGeminiMockBaseUrlUsesOpenAICompat();
  await testTanstackOpenAICompatAdapterConfig();
};
