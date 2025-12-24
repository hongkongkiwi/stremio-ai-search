/* eslint-disable no-console */
const assert = require("assert");

function getEnv(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === null || v === "" ? fallback : v;
}

async function main() {
  const baseUrl = getEnv("BASE_URL", "http://localhost:7000").replace(/\/+$/, "");

  const manifestUrl = getEnv("MANIFEST_URL", "");
  if (!manifestUrl) {
    console.log("MANIFEST_URL not set; skipping (provide a configured manifest.json URL).");
    console.log("Example: MANIFEST_URL=http://localhost:7000/aisearch/<configId>/manifest.json");
    return;
  }

  const query = getEnv("QUERY", "matrix");
  const type = getEnv("TYPE", "movie");
  const catalogId = getEnv("CATALOG_ID", "aisearch.top");

  const url = `${baseUrl}/aisearch/${manifestUrl.split("/aisearch/")[1].split("/manifest.json")[0]}/catalog/${type}/${catalogId}/search=${encodeURIComponent(query)}.json`;

  console.log(`GET ${url}`);
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const json = await res.json();
  console.log(`HTTP ${res.status}`, { metas: json?.metas?.length });

  assert(res.ok, `HTTP ${res.status}`);
  assert(Array.isArray(json.metas), "metas must be an array");
  assert(json.metas.length > 0, "expected at least 1 meta result");
  assert(json.metas[0].id, "meta[0].id missing");
  assert(json.metas[0].name, "meta[0].name missing");

  console.log("Smoke catalog OK");
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});

