let fetchFn = globalThis.fetch;

if (!fetchFn) {
  const nodeFetch = require("node-fetch");
  fetchFn = nodeFetch.default || nodeFetch;
}

module.exports = fetchFn;

