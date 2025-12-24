const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

function loadConfigureHtml() {
  const htmlPath = path.join(process.cwd(), "public", "configure.html");
  let html = fs.readFileSync(htmlPath, "utf8");

  // Prevent external network/script loads (recaptcha) during tests.
  html = html.replace(
    /<script[^>]+src="https:\/\/www\.google\.com\/recaptcha\/api\.js[^"]*"[^>]*><\/script>/g,
    ""
  );

  const dom = new JSDOM(html, {
    url: "http://localhost:7000/aisearch/configure",
    runScripts: "dangerously",
    resources: "usable",
    pretendToBeVisual: true,
  });

  return dom;
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

async function testProviderToggleShowsRightFields() {
  const dom = loadConfigureHtml();
  const { window } = dom;
  const { document } = window;

  // Wait for inline scripts to register DOMContentLoaded handlers.
  await flushMicrotasks();

  // Trigger DOMContentLoaded.
  document.dispatchEvent(new window.Event("DOMContentLoaded"));
  await flushMicrotasks();

  const aiProvider = document.getElementById("aiProvider");
  const geminiFields = document.getElementById("geminiFields");
  const openaiCompatFields = document.getElementById("openaiCompatFields");

  assert(aiProvider, "aiProvider select missing");
  assert(geminiFields, "geminiFields missing");
  assert(openaiCompatFields, "openaiCompatFields missing");

  // Default should be gemini visible.
  assert.equal(aiProvider.value, "gemini");
  assert.equal(geminiFields.style.display, "block");
  assert.equal(openaiCompatFields.style.display, "none");

  // Switch to openai-compat and ensure fields toggle.
  aiProvider.value = "openai-compat";
  aiProvider.dispatchEvent(new window.Event("change"));
  await flushMicrotasks();

  assert.equal(geminiFields.style.display, "none");
  assert.equal(openaiCompatFields.style.display, "block");

  dom.window.close();
}

async function testGetAddonUrlSerializesConfigCorrectlyOpenAICompat() {
  const dom = loadConfigureHtml();
  const { window } = dom;
  const { document } = window;

  await flushMicrotasks();
  document.dispatchEvent(new window.Event("DOMContentLoaded"));
  await flushMicrotasks();

  // Set provider to openai-compat.
  document.getElementById("aiProvider").value = "openai-compat";
  document.getElementById("aiProvider").dispatchEvent(new window.Event("change"));

  document.getElementById("openaiCompatApiKey").value = "sk-test-1234567890";
  document.getElementById("openaiCompatModel").value = "openai/gpt-4o-mini";
  document.getElementById("openaiCompatBaseUrl").value = "https://openrouter.ai/api";
  document.getElementById("openaiCompatExtraHeaders").value =
    '{"HTTP-Referer":"https://example.com","X-Title":"Test"}';

  document.getElementById("tmdbKey").value = "tmdb-test-key";
  document.getElementById("aiTemperature").value = "0";

  // Stub fetch: first call is /aisearch/validate, second is /aisearch/encrypt.
  const calls = [];
  window.fetch = async (url, options) => {
    calls.push({ url, options });
    if (String(url).includes("/aisearch/validate")) {
      return {
        ok: true,
        async json() {
          return { ai: true, openaiCompat: true, tmdb: true, errors: {} };
        },
      };
    }
    if (String(url).includes("/aisearch/encrypt")) {
      return {
        ok: true,
        async json() {
          return { encryptedConfig: "abc" };
        },
      };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const urls = await window.getAddonUrl();
  assert(urls && urls.https, "Expected addon URL result");
  assert.equal(calls.length, 2);

  const validateBody = JSON.parse(calls[0].options.body);
  assert.equal(validateBody.AiProvider, "openai-compat");
  assert.equal(validateBody.OpenAICompatModel, "openai/gpt-4o-mini");
  assert.equal(validateBody.AiTemperature, 0);

  const encryptBody = JSON.parse(calls[1].options.body);
  assert(encryptBody.configData, "encrypt payload missing configData");
  assert.equal(encryptBody.configData.AiProvider, "openai-compat");
  assert.equal(encryptBody.configData.OpenAICompatModel, "openai/gpt-4o-mini");
  assert.equal(encryptBody.configData.OpenAICompatBaseUrl, "https://openrouter.ai/api");
  assert.equal(encryptBody.configData.AiTemperature, 0);
  assert(!encryptBody.configData.GeminiApiKey, "should not include GeminiApiKey");

  dom.window.close();
}

async function testGetAddonUrlSerializesConfigCorrectlyGemini() {
  const dom = loadConfigureHtml();
  const { window } = dom;
  const { document } = window;

  await flushMicrotasks();
  document.dispatchEvent(new window.Event("DOMContentLoaded"));
  await flushMicrotasks();

  document.getElementById("aiProvider").value = "gemini";
  document.getElementById("aiProvider").dispatchEvent(new window.Event("change"));

  document.getElementById("geminiKey").value = "gemini-test-key";
  document.getElementById("geminiModel").value = "gemini-2.5-flash-lite";
  document.getElementById("tmdbKey").value = "tmdb-test-key";
  document.getElementById("aiTemperature").value = "0.7";

  const calls = [];
  window.fetch = async (url, options) => {
    calls.push({ url, options });
    if (String(url).includes("/aisearch/validate")) {
      return {
        ok: true,
        async json() {
          return { ai: true, gemini: true, tmdb: true, errors: {} };
        },
      };
    }
    if (String(url).includes("/aisearch/encrypt")) {
      return {
        ok: true,
        async json() {
          return { encryptedConfig: "abc" };
        },
      };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const urls = await window.getAddonUrl();
  assert(urls && urls.https, "Expected addon URL result");
  assert.equal(calls.length, 2);

  const encryptBody = JSON.parse(calls[1].options.body);
  assert.equal(encryptBody.configData.AiProvider, "gemini");
  assert.equal(encryptBody.configData.GeminiModel, "gemini-2.5-flash-lite");
  assert.equal(encryptBody.configData.AiTemperature, 0.7);
  assert(!encryptBody.configData.OpenAICompatApiKey, "should not include OpenAICompatApiKey");

  dom.window.close();
}

module.exports.run = async function run() {
  await testProviderToggleShowsRightFields();
  await testGetAddonUrlSerializesConfigCorrectlyOpenAICompat();
  await testGetAddonUrlSerializesConfigCorrectlyGemini();
};
