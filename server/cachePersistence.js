const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const logger = require("../utils/logger");

const CACHE_BACKUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const CACHE_FOLDER = path.join(__dirname, "..", "cache_data");

function ensureCacheFolder() {
  if (!fs.existsSync(CACHE_FOLDER)) {
    fs.mkdirSync(CACHE_FOLDER, { recursive: true });
  }
}

async function saveCachesToFiles() {
  try {
    const { serializeAllCaches } = require("../addon");
    const allCaches = serializeAllCaches();
    const savePromises = [];
    const results = {};
    for (const [cacheName, cacheData] of Object.entries(allCaches)) {
      const cacheFilePath = path.join(CACHE_FOLDER, `${cacheName}.json.gz`);
      const tempCacheFilePath = `${cacheFilePath}.${process.pid}.tmp`;
      const promise = (async () => {
        try {
          const jsonData = JSON.stringify(cacheData);
          const compressed = zlib.gzipSync(jsonData);
          await fs.promises.writeFile(tempCacheFilePath, compressed);
          await fs.promises.rename(tempCacheFilePath, cacheFilePath);
          if (cacheName === "stats") {
            results[cacheName] = {
              success: true,
              originalSize: jsonData.length,
              compressedSize: compressed.length,
              compressionRatio:
                ((compressed.length / jsonData.length) * 100).toFixed(2) + "%",
              path: cacheFilePath,
            };
          } else {
            results[cacheName] = {
              success: true,
              size: cacheData.entries ? cacheData.entries.length : 0,
              originalSize: jsonData.length,
              compressedSize: compressed.length,
              compressionRatio:
                ((compressed.length / jsonData.length) * 100).toFixed(2) + "%",
              path: cacheFilePath,
            };
          }
        } catch (err) {
          logger.error(`Error saving ${cacheName} to file`, {
            error: err.message,
            stack: err.stack,
          });
          results[cacheName] = {
            success: false,
            error: err.message,
          };
          try {
            if (fs.existsSync(tempCacheFilePath)) {
              await fs.promises.unlink(tempCacheFilePath);
            }
          } catch (cleanupErr) {
            logger.warn(
              `Failed to delete temporary cache file: ${tempCacheFilePath}`,
              {
                error: cleanupErr.message,
              }
            );
          }
        }
      })();
      savePromises.push(promise);
    }
    await Promise.all(savePromises);
    logger.info("Cache data saved to individual compressed files", {
      timestamp: new Date().toISOString(),
      cacheFolder: CACHE_FOLDER,
      results,
    });
    return {
      success: true,
      timestamp: new Date().toISOString(),
      cacheFolder: CACHE_FOLDER,
      results,
    };
  } catch (error) {
    logger.error("Error saving cache data to files", {
      error: error.message,
      stack: error.stack,
    });
    return {
      success: false,
      error: error.message,
    };
  }
}

async function loadCachesFromFiles() {
  try {
    if (!fs.existsSync(CACHE_FOLDER)) {
      logger.info("No cache folder found, starting with empty caches", {
        cacheFolder: CACHE_FOLDER,
      });
      return {
        success: false,
        reason: "No cache folder found",
      };
    }

    const files = fs
      .readdirSync(CACHE_FOLDER)
      .filter((file) => file.endsWith(".json.gz") || file.endsWith(".json"));

    if (files.length === 0) {
      logger.info("No cache files found, starting with empty caches", {
        cacheFolder: CACHE_FOLDER,
      });
      return {
        success: false,
        reason: "No cache files found",
      };
    }

    const allCacheData = {};
    const results = {};

    for (const file of files) {
      try {
        const isCompressed = file.endsWith(".json.gz");
        const cacheName = path.basename(file, isCompressed ? ".json.gz" : ".json");
        const cacheFilePath = path.join(CACHE_FOLDER, file);

        const fileData = await fs.promises.readFile(cacheFilePath);

        let cacheDataJson;
        if (isCompressed) {
          cacheDataJson = zlib.gunzipSync(fileData).toString();
        } else {
          cacheDataJson = fileData.toString("utf8");
        }

        const cacheData = JSON.parse(cacheDataJson);

        allCacheData[cacheName] = cacheData;
        results[cacheName] = {
          success: true,
          entriesCount:
            cacheName === "stats" ? "N/A" : cacheData.entries?.length || 0,
          compressed: isCompressed,
          path: cacheFilePath,
        };
      } catch (err) {
        logger.error(`Error reading cache file ${file}`, {
          error: err.message,
          stack: err.stack,
        });
        results[file] = {
          success: false,
          error: err.message,
        };
        continue;
      }
    }

    const { deserializeAllCaches } = require("../addon");
    const deserializeResults = deserializeAllCaches(allCacheData);

    return {
      success: true,
      cacheCount: Object.keys(results).length,
      results,
      deserializeResults,
    };
  } catch (error) {
    logger.error("Error loading cache data from files", {
      error: error.message,
      stack: error.stack,
    });
    return {
      success: false,
      error: error.message,
    };
  }
}

module.exports = {
  CACHE_BACKUP_INTERVAL_MS,
  CACHE_FOLDER,
  ensureCacheFolder,
  saveCachesToFiles,
  loadCachesFromFiles,
};
