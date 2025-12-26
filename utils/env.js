function parseJsonEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw || !String(raw).trim()) return fallback;
  return JSON.parse(raw);
}

function isTruthyValue(value) {
  return String(value || "").toLowerCase() === "true";
}

function getDefaultAllowlistedEnv() {
  const allowlist = [
    "HOME",
    "LOGNAME",
    "PATH",
    "SHELL",
    "TERM",
    "USER",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "TEMP",
    "TMP",
  ];
  const env = {};
  for (const key of allowlist) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

module.exports = {
  parseJsonEnv,
  isTruthyValue,
  getDefaultAllowlistedEnv,
};
