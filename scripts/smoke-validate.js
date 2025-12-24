/* eslint-disable no-console */
const assert = require("assert");

function getEnv(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === null || v === "" ? fallback : v;
}

function parseJsonEnv(name) {
  const raw = getEnv(name, "");
  if (!raw) return "";
  // Keep as string for server to parse; but verify it's valid JSON object early.
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object string`);
  }
  return raw;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

async function main() {
  const baseUrl = getEnv("BASE_URL", "http://localhost:7000");
  const aiProvider = getEnv("AI_PROVIDER", "gemini");

  const tmdbKey = getEnv("TMDB_API_KEY", "");
  assert(tmdbKey, "TMDB_API_KEY is required");

  const temperatureRaw = getEnv("AI_TEMPERATURE", "0.2");
  const temperatureParsed = parseFloat(temperatureRaw);
  const aiTemperature = Number.isFinite(temperatureParsed)
    ? Math.max(0, Math.min(1, temperatureParsed))
    : 0.2;

  const body = {
    AiProvider: aiProvider,
    AiTemperature: aiTemperature,
    TmdbApiKey: tmdbKey,
  };

  if (aiProvider === "gemini") {
    body.GeminiApiKey = getEnv("GEMINI_API_KEY", "");
    body.GeminiModel = getEnv("GEMINI_MODEL", "gemini-2.5-flash-lite");
    assert(body.GeminiApiKey, "GEMINI_API_KEY is required for AI_PROVIDER=gemini");
  } else if (aiProvider === "openai-compat") {
    body.OpenAICompatApiKey = getEnv("OPENAI_COMPAT_API_KEY", "");
    body.OpenAICompatModel = getEnv("OPENAI_COMPAT_MODEL", "");
    body.OpenAICompatBaseUrl = getEnv("OPENAI_COMPAT_BASE_URL", "");
    body.OpenAICompatExtraHeaders = parseJsonEnv("OPENAI_COMPAT_EXTRA_HEADERS");
    assert(
      body.OpenAICompatApiKey,
      "OPENAI_COMPAT_API_KEY is required for AI_PROVIDER=openai-compat"
    );
    assert(
      body.OpenAICompatModel,
      "OPENAI_COMPAT_MODEL is required for AI_PROVIDER=openai-compat"
    );
  } else {
    throw new Error(`Unsupported AI_PROVIDER: ${aiProvider}`);
  }

  const url = `${baseUrl.replace(/\\/+$/, "")}/aisearch/validate`;
  console.log(`POST ${url}`);
  console.log(
    JSON.stringify(
      {
        ...body,
        GeminiApiKey: body.GeminiApiKey ? "***" : undefined,
        OpenAICompatApiKey: body.OpenAICompatApiKey ? "***" : undefined,
      },
      null,
      2
    )
  );

  const res = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    30000
  );

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response (status ${res.status}): ${text}`);
  }

  console.log("Response:", JSON.stringify(json, null, 2));

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  const aiOk = !!(json.ai || json.gemini || json.openaiCompat);
  assert(aiOk, "AI validation failed");
  assert(json.tmdb === true, "TMDB validation failed");
  console.log("Smoke validate OK");
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});

