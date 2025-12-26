const logger = require("../../utils/logger");

function registerConfigRoutes({ router, routePath, decryptConfig, isValidEncryptedFormat }) {
  router.get(routePath + "api/getConfig/:configId", (req, res) => {
    try {
      const { configId } = req.params;

      const cleanConfigId = configId.split("/").pop();

      if (!cleanConfigId || !isValidEncryptedFormat(cleanConfigId)) {
        return res.status(400).json({ error: "Invalid configuration format" });
      }

      const decryptedConfig = decryptConfig(cleanConfigId);
      if (!decryptedConfig) {
        return res.status(400).json({ error: "Failed to decrypt configuration" });
      }

      const config = JSON.parse(decryptedConfig);
      res.json(config);
    } catch (error) {
      logger.error("Error getting configuration:", {
        error: error.message,
        stack: error.stack,
      });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post(routePath + "api/decrypt-config", (req, res) => {
    try {
      const { encryptedConfig } = req.body;

      if (!encryptedConfig || !isValidEncryptedFormat(encryptedConfig)) {
        return res.status(400).json({ error: "Invalid configuration format" });
      }

      const decryptedConfig = decryptConfig(encryptedConfig);

      if (!decryptedConfig) {
        return res.status(400).json({ error: "Failed to decrypt configuration" });
      }

      const config = JSON.parse(decryptedConfig);
      res.json(config);
    } catch (error) {
      logger.error("Error decrypting configuration:", {
        error: error.message,
        stack: error.stack,
      });
      res.status(500).json({ error: "Internal server error" });
    }
  });
}

module.exports = {
  registerConfigRoutes,
};
