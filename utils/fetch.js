if (!globalThis.fetch) {
  throw new Error("Global fetch is not available (requires Node 22+).");
}

module.exports = globalThis.fetch;
