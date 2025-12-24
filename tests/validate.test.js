const assert = require("assert");

const { validateAiProvider, validateTmdbApiKey } = require("../utils/validate");

async function testValidateAiProviderGeminiSuccess() {
  const res = await validateAiProvider(
    { AiProvider: "gemini", GeminiApiKey: "k", GeminiModel: "m" },
    {
      createAiClient: () => ({
        async generateText() {
          return "ok";
        },
      }),
    }
  );
  assert.equal(res.aiProvider, "gemini");
  assert.equal(res.ai, true);
  assert.equal(res.gemini, true);
  assert.equal(res.openaiCompat, false);
  assert.deepEqual(res.errors, {});
}

async function testValidateAiProviderOpenAICompatSuccess() {
  const res = await validateAiProvider(
    {
      AiProvider: "openai-compat",
      OpenAICompatApiKey: "k",
      OpenAICompatModel: "m",
    },
    {
      createAiClient: () => ({
        async generateText() {
          return "ok";
        },
      }),
    }
  );
  assert.equal(res.aiProvider, "openai-compat");
  assert.equal(res.ai, true);
  assert.equal(res.gemini, false);
  assert.equal(res.openaiCompat, true);
  assert.deepEqual(res.errors, {});
}

async function testValidateAiProviderMissingKeyMessages() {
  const gemini = await validateAiProvider({ AiProvider: "gemini" }, { createAiClient: () => null });
  assert.equal(gemini.ai, false);
  assert.equal(gemini.errors.ai, "Gemini API Key is required.");

  const openai = await validateAiProvider(
    { AiProvider: "openai-compat" },
    { createAiClient: () => null }
  );
  assert.equal(openai.ai, false);
  assert.equal(openai.errors.ai, "OpenAI-compatible API key is required.");
}

async function testValidateAiProviderPropagatesError() {
  const res = await validateAiProvider(
    {
      AiProvider: "openai-compat",
      OpenAICompatApiKey: "k",
      OpenAICompatModel: "m",
      OpenAICompatExtraHeaders: "{not-json}",
    },
    {
      createAiClient: () => ({
        async generateText() {
          throw new Error("boom");
        },
      }),
    }
  );

  assert.equal(res.ai, false);
  assert.ok(res.errors.ai.includes("Invalid AI provider API key:"));
}

async function testValidateTmdbApiKeySuccess() {
  const tmdb = await validateTmdbApiKey("k", {
    fetch: async () => ({ ok: true, status: 200 }),
  });
  assert.equal(tmdb.tmdb, true);
  assert.deepEqual(tmdb.errors, {});
}

async function testValidateTmdbApiKeyFailureStatus() {
  const tmdb = await validateTmdbApiKey("k", {
    fetch: async () => ({ ok: false, status: 401 }),
  });
  assert.equal(tmdb.tmdb, false);
  assert.equal(tmdb.errors.tmdb, "Invalid TMDB API key (Status: 401)");
}

async function testValidateTmdbApiKeyMissing() {
  const tmdb = await validateTmdbApiKey("");
  assert.equal(tmdb.tmdb, false);
  assert.equal(tmdb.errors.tmdb, "TMDB API Key is required.");
}

module.exports.run = async function run() {
  await testValidateAiProviderGeminiSuccess();
  await testValidateAiProviderOpenAICompatSuccess();
  await testValidateAiProviderMissingKeyMessages();
  await testValidateAiProviderPropagatesError();
  await testValidateTmdbApiKeySuccess();
  await testValidateTmdbApiKeyFailureStatus();
  await testValidateTmdbApiKeyMissing();
};

