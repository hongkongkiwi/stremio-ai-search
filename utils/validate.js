const {
  createAiTextGenerator,
  getAiProviderConfigFromConfig,
} = require("./aiProvider");
const fetch = require("./fetch");

async function validateAiProvider(body, deps = {}) {
  const aiProviderConfig = getAiProviderConfigFromConfig(body);
  const createAiClient = deps.createAiClient || createAiTextGenerator;

  const result = {
    ai: false,
    aiProvider: aiProviderConfig.provider,
    gemini: false,
    openaiCompat: false,
    errors: {},
  };

  if (!aiProviderConfig.apiKey) {
    result.errors.ai =
      aiProviderConfig.provider === "openai-compat"
        ? "OpenAI-compatible API key is required."
        : "Gemini API Key is required.";
    return result;
  }

  try {
    const aiClient = createAiClient(aiProviderConfig);
    const responseText = await aiClient.generateText("Test prompt");
    if (responseText && String(responseText).length > 0) {
      result.ai = true;
      if (aiProviderConfig.provider === "gemini") result.gemini = true;
      if (aiProviderConfig.provider === "openai-compat") result.openaiCompat = true;
    } else {
      result.errors.ai = "Invalid AI provider API key - No response";
    }
  } catch (error) {
    result.errors.ai = `Invalid AI provider API key: ${error.message}`;
  }

  return result;
}

async function validateTmdbApiKey(tmdbApiKey, deps = {}) {
  const fetchFn = deps.fetch || fetch;
  const result = { tmdb: false, errors: {} };

  if (!tmdbApiKey) {
    result.errors.tmdb = "TMDB API Key is required.";
    return result;
  }

  if (!fetchFn) {
    result.errors.tmdb = "TMDB API validation failed (fetch not available)";
    return result;
  }

  try {
    const base =
      (process.env.TMDB_API_BASE || "https://api.themoviedb.org/3").replace(
        /\/+$/,
        ""
      );
    const tmdbUrl = `${base}/configuration?api_key=${tmdbApiKey}`;
    const tmdbResponse = await fetchFn(tmdbUrl);
    if (tmdbResponse && tmdbResponse.ok) {
      result.tmdb = true;
    } else {
      result.errors.tmdb = `Invalid TMDB API key (Status: ${tmdbResponse?.status})`;
    }
  } catch {
    result.errors.tmdb = "TMDB API validation failed";
  }

  return result;
}

module.exports = {
  validateAiProvider,
  validateTmdbApiKey,
};
