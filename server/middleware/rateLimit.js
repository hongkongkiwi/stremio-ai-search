const rateLimit = require("express-rate-limit");
const { getNumberEnv, isTruthyValue } = require("../../utils/env");

function applyAddonRateLimit(router) {
  const rateLimitEnabled =
    process.env.RATE_LIMIT_ENABLED === undefined
      ? true
      : isTruthyValue(process.env.RATE_LIMIT_ENABLED);
  if (!rateLimitEnabled) {
    return;
  }

  const windowMs = getNumberEnv("RATE_LIMIT_WINDOW_MS", 60 * 1000);
  const max = getNumberEnv("RATE_LIMIT_MAX", 120);
  const trustLocal =
    process.env.RATE_LIMIT_TRUST_LOCAL === undefined
      ? true
      : isTruthyValue(process.env.RATE_LIMIT_TRUST_LOCAL);

  const isLocalRequest = (req) => {
    const ip = req.ip || req.connection?.remoteAddress || "";
    return (
      ip === "127.0.0.1" ||
      ip === "::1" ||
      ip.startsWith("::ffff:127.") ||
      ip === "::ffff:127.0.0.1"
    );
  };

  const addonRateLimiter = rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => trustLocal && isLocalRequest(req),
    message: { error: "Too many requests, please slow down." },
  });
  router.use(addonRateLimiter);
}

module.exports = {
  applyAddonRateLimit,
};
