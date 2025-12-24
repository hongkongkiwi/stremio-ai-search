/* eslint-disable no-console */
const assert = require("assert");

function getEnv(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === null || v === "" ? fallback : v;
}

async function main() {
  const baseUrl = getEnv("BASE_URL", "http://localhost:7000").replace(/\/+$/, "");
  const configId = getEnv("CONFIG_ID", "");
  if (!configId) {
    console.log("CONFIG_ID not set; skipping (provide the encrypted config id).");
    console.log("Example: CONFIG_ID=<encryptedId> BASE_URL=http://localhost:7000 npm run smoke:similar");
    return;
  }

  const imdbId = getEnv("IMDB_ID", "tt0133093");
  const sourceType = getEnv("SOURCE_TYPE", "movie");

  // This addon expects type=series for the meta route response, but the input is the source type.
  const url = `${baseUrl}/aisearch/${configId}/meta/${sourceType}/ai-recs:${imdbId}.json`;

  console.log(`GET ${url}`);
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const json = await res.json();
  console.log(`HTTP ${res.status}`, { hasMeta: !!json?.meta, videos: json?.meta?.videos?.length });

  assert(res.ok, `HTTP ${res.status}`);
  assert(json.meta, "meta missing");
  assert(Array.isArray(json.meta.videos), "meta.videos must be an array");
  assert(json.meta.videos.length > 0, "expected at least 1 video recommendation");

  console.log("Smoke similar OK");
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});

