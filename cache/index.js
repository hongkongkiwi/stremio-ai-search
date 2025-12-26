const logger = require("../utils/logger");
const { getNumberEnv } = require("../utils/env");

const TMDB_CACHE_DURATION = getNumberEnv("TMDB_CACHE_TTL_MS", 7 * 24 * 60 * 60 * 1000);
const TMDB_DISCOVER_CACHE_DURATION = getNumberEnv(
  "TMDB_DISCOVER_CACHE_TTL_MS",
  7 * 24 * 60 * 60 * 1000
);
const AI_CACHE_DURATION = getNumberEnv("AI_CACHE_TTL_MS", 7 * 24 * 60 * 60 * 1000);
const RPDB_CACHE_DURATION = getNumberEnv("RPDB_CACHE_TTL_MS", 7 * 24 * 60 * 60 * 1000);
const TRAKT_CACHE_DURATION = getNumberEnv("TRAKT_CACHE_TTL_MS", 24 * 60 * 60 * 1000);
const TRAKT_RAW_DATA_CACHE_DURATION = getNumberEnv(
  "TRAKT_RAW_CACHE_TTL_MS",
  7 * 24 * 60 * 60 * 1000
);

class SimpleLRUCache {
  constructor(options = {}) {
    this.max = options.max || 1000;
    this.ttl = options.ttl || Infinity;
    this.cache = new Map();
    this.timestamps = new Map();
    this.expirations = new Map();
  }

  set(key, value) {
    if (this.cache.size >= this.max) {
      const oldestKey = this.timestamps.keys().next().value;
      this.delete(oldestKey);
    }

    this.cache.set(key, value);
    this.timestamps.set(key, Date.now());

    if (this.ttl !== Infinity) {
      const expiration = Date.now() + this.ttl;
      this.expirations.set(key, expiration);
    }

    return this;
  }

  get(key) {
    if (!this.cache.has(key)) {
      return undefined;
    }

    const expiration = this.expirations.get(key);
    if (expiration && Date.now() > expiration) {
      this.delete(key);
      return undefined;
    }

    this.timestamps.delete(key);
    this.timestamps.set(key, Date.now());

    return this.cache.get(key);
  }

  has(key) {
    if (!this.cache.has(key)) {
      return false;
    }

    const expiration = this.expirations.get(key);
    if (expiration && Date.now() > expiration) {
      this.delete(key);
      return false;
    }

    return true;
  }

  delete(key) {
    this.cache.delete(key);
    this.timestamps.delete(key);
    this.expirations.delete(key);
    return true;
  }

  clear() {
    this.cache.clear();
    this.timestamps.clear();
    this.expirations.clear();
    return true;
  }

  get size() {
    return this.cache.size;
  }

  keys() {
    return Array.from(this.cache.keys());
  }

  // Serialize cache data to a JSON-friendly format
  serialize() {
    const entries = [];
    for (const [key, value] of this.cache.entries()) {
      const timestamp = this.timestamps.get(key);
      const expiration = this.expirations.get(key);
      entries.push({
        key,
        value,
        timestamp,
        expiration,
      });
    }

    return {
      max: this.max,
      ttl: this.ttl,
      entries,
    };
  }

  // Load data from serialized format
  deserialize(data) {
    if (!data || !data.entries) {
      return false;
    }

    this.max = data.max || this.max;
    this.ttl = data.ttl || this.ttl;

    // Clear existing data
    this.clear();

    // Load entries
    for (const entry of data.entries) {
      // Skip expired entries
      if (entry.expiration && Date.now() > entry.expiration) {
        continue;
      }

      this.cache.set(entry.key, entry.value);
      this.timestamps.set(entry.key, entry.timestamp);
      if (entry.expiration) {
        this.expirations.set(entry.key, entry.expiration);
      }
    }

    return true;
  }
}

const tmdbCache = new SimpleLRUCache({
  max: getNumberEnv("TMDB_CACHE_MAX", 25000),
  ttl: TMDB_CACHE_DURATION,
});

const tmdbDetailsCache = new SimpleLRUCache({
  max: getNumberEnv("TMDB_DETAILS_CACHE_MAX", 25000),
  ttl: TMDB_CACHE_DURATION,
});

const aiRecommendationsCache = new SimpleLRUCache({
  max: getNumberEnv("AI_CACHE_MAX", 25000),
  ttl: AI_CACHE_DURATION,
});

const rpdbCache = new SimpleLRUCache({
  max: getNumberEnv("RPDB_CACHE_MAX", 25000),
  ttl: RPDB_CACHE_DURATION,
});

const fanartCache = new SimpleLRUCache({
  max: getNumberEnv("FANART_CACHE_MAX", 5000),
  ttl: RPDB_CACHE_DURATION,
});

const similarContentCache = new SimpleLRUCache({
  max: getNumberEnv("SIMILAR_CACHE_MAX", 5000),
  ttl: AI_CACHE_DURATION,
});

const traktRawDataCache = new SimpleLRUCache({
  max: 1000,
  ttl: TRAKT_RAW_DATA_CACHE_DURATION,
});

const traktCache = new SimpleLRUCache({
  max: 1000,
  ttl: TRAKT_CACHE_DURATION,
});

const tmdbDiscoverCache = new SimpleLRUCache({
  max: 1000,
  ttl: TMDB_DISCOVER_CACHE_DURATION,
});

const queryAnalysisCache = new SimpleLRUCache({
  max: 1000,
  ttl: AI_CACHE_DURATION,
});

let queryCounter = 0;

function incrementQueryCounter() {
  queryCounter += 1;
  logger.info("Query counter incremented", { totalQueries: queryCounter });
  return queryCounter;
}

function getQueryCount() {
  return queryCounter;
}

function setQueryCount(newCount) {
  if (typeof newCount !== "number" || newCount < 0) {
    throw new Error("Query count must be a non-negative number");
  }
  const oldCount = queryCounter;
  queryCounter = newCount;
  logger.info("Query counter manually set", {
    oldCount,
    newCount: queryCounter,
  });
  return queryCounter;
}

function clearTmdbCache() {
  const size = tmdbCache.size;
  tmdbCache.clear();
  logger.info("TMDB cache cleared", { previousSize: size });
  return { cleared: true, previousSize: size };
}

function clearTmdbDetailsCache() {
  const size = tmdbDetailsCache.size;
  tmdbDetailsCache.clear();
  logger.info("TMDB details cache cleared", { previousSize: size });
  return { cleared: true, previousSize: size };
}

function clearTmdbDiscoverCache() {
  const size = tmdbDiscoverCache.size;
  tmdbDiscoverCache.clear();
  logger.info("TMDB discover cache cleared", { previousSize: size });
  return { cleared: true, previousSize: size };
}

function removeTmdbDiscoverCacheItem(cacheKey) {
  if (!cacheKey) {
    return {
      success: false,
      message: "No cache key provided",
    };
  }

  if (!tmdbDiscoverCache.has(cacheKey)) {
    return {
      success: false,
      message: "Cache key not found",
      key: cacheKey,
    };
  }

  tmdbDiscoverCache.delete(cacheKey);
  logger.info("TMDB discover cache item removed", { cacheKey });

  return {
    success: true,
    message: "Cache item removed successfully",
    key: cacheKey,
  };
}

function listTmdbDiscoverCacheKeys() {
  const keys = tmdbDiscoverCache.keys();
  logger.info("TMDB discover cache keys listed", { count: keys.length });

  return {
    success: true,
    count: keys.length,
    keys,
  };
}

function clearAiCache() {
  const size = aiRecommendationsCache.size;
  aiRecommendationsCache.clear();
  logger.info("AI recommendations cache cleared", { previousSize: size });
  return { cleared: true, previousSize: size };
}

function removeAiCacheByKeywords(keywords) {
  try {
    if (!keywords || typeof keywords !== "string") {
      throw new Error("Invalid keywords parameter");
    }

    const searchPhrase = keywords.toLowerCase().trim();
    const removedEntries = [];
    let totalRemoved = 0;

    const cacheKeys = aiRecommendationsCache.keys();

    for (const key of cacheKeys) {
      const query = key.split("_")[0].toLowerCase();
      if (query.includes(searchPhrase)) {
        const entry = aiRecommendationsCache.get(key);
        if (entry) {
          removedEntries.push({
            key,
            timestamp: new Date(entry.timestamp).toISOString(),
            query: key.split("_")[0],
          });
          aiRecommendationsCache.delete(key);
          totalRemoved++;
        }
      }
    }

    logger.info("AI recommendations cache entries removed by keywords", {
      keywords: searchPhrase,
      totalRemoved,
      removedEntries,
    });

    return {
      removed: totalRemoved,
      entries: removedEntries,
    };
  } catch (error) {
    logger.error("Error in removeAiCacheByKeywords:", {
      error: error.message,
      stack: error.stack,
      keywords,
    });
    throw error;
  }
}

function purgeEmptyAiCacheEntries() {
  const cacheKeys = aiRecommendationsCache.keys();
  let purgedCount = 0;
  const totalScanned = cacheKeys.length;

  logger.info("Starting purge of empty AI cache entries...", { totalEntries: totalScanned });

  for (const key of cacheKeys) {
    const cachedItem = aiRecommendationsCache.get(key);

    const recommendations = cachedItem?.data?.recommendations;
    const hasMovies = recommendations?.movies?.length > 0;
    const hasSeries = recommendations?.series?.length > 0;

    if (!hasMovies && !hasSeries) {
      aiRecommendationsCache.delete(key);
      purgedCount++;
      logger.debug("Purged empty AI cache entry", { key });
    }
  }

  const remaining = aiRecommendationsCache.size;
  logger.info("Completed purge of empty AI cache entries.", {
    scanned: totalScanned,
    purged: purgedCount,
    remaining: remaining,
  });

  return {
    scanned: totalScanned,
    purged: purgedCount,
    remaining: remaining,
  };
}

function clearRpdbCache() {
  const size = rpdbCache.size;
  rpdbCache.clear();
  logger.info("RPDB cache cleared", { previousSize: size });
  return { cleared: true, previousSize: size };
}

function clearFanartCache() {
  const size = fanartCache.size;
  fanartCache.clear();
  logger.info("Fanart.tv cache cleared", { previousSize: size });
  return { cleared: true, previousSize: size };
}

function clearTraktCache() {
  const size = traktCache.size;
  traktCache.clear();
  logger.info("Trakt cache cleared", { previousSize: size });
  return { cleared: true, previousSize: size };
}

function clearTraktRawDataCache() {
  const size = traktRawDataCache.size;
  traktRawDataCache.clear();
  logger.info("Trakt raw data cache cleared", { previousSize: size });
  return { cleared: true, previousSize: size };
}

function clearQueryAnalysisCache() {
  const size = queryAnalysisCache.size;
  queryAnalysisCache.clear();
  logger.info("Query analysis cache cleared", { previousSize: size });
  return { cleared: true, previousSize: size };
}

function clearSimilarContentCache() {
  const size = similarContentCache.size;
  similarContentCache.clear();
  logger.info("Similar content cache cleared", { previousSize: size });
  return { cleared: true, previousSize: size };
}

function getCacheStats() {
  return {
    tmdbCache: {
      size: tmdbCache.size,
      maxSize: tmdbCache.max,
      usagePercentage: ((tmdbCache.size / tmdbCache.max) * 100).toFixed(2) + "%",
      itemCount: tmdbCache.size,
    },
    tmdbDetailsCache: {
      size: tmdbDetailsCache.size,
      maxSize: tmdbDetailsCache.max,
      usagePercentage:
        ((tmdbDetailsCache.size / tmdbDetailsCache.max) * 100).toFixed(2) + "%",
      itemCount: tmdbDetailsCache.size,
    },
    tmdbDiscoverCache: {
      size: tmdbDiscoverCache.size,
      maxSize: tmdbDiscoverCache.max,
      usagePercentage:
        ((tmdbDiscoverCache.size / tmdbDiscoverCache.max) * 100).toFixed(2) + "%",
      itemCount: tmdbDiscoverCache.size,
    },
    aiCache: {
      size: aiRecommendationsCache.size,
      maxSize: aiRecommendationsCache.max,
      usagePercentage:
        ((aiRecommendationsCache.size / aiRecommendationsCache.max) * 100).toFixed(2) + "%",
      itemCount: aiRecommendationsCache.size,
    },
    rpdbCache: {
      size: rpdbCache.size,
      maxSize: rpdbCache.max,
      usagePercentage: ((rpdbCache.size / rpdbCache.max) * 100).toFixed(2) + "%",
      itemCount: rpdbCache.size,
    },
    fanartCache: {
      size: fanartCache.size,
      maxSize: fanartCache.max,
      usagePercentage: ((fanartCache.size / fanartCache.max) * 100).toFixed(2) + "%",
      itemCount: fanartCache.size,
    },
    traktCache: {
      size: traktCache.size,
      maxSize: traktCache.max,
      usagePercentage: ((traktCache.size / traktCache.max) * 100).toFixed(2) + "%",
      itemCount: traktCache.size,
    },
    traktRawDataCache: {
      size: traktRawDataCache.size,
      maxSize: traktRawDataCache.max,
      usagePercentage:
        ((traktRawDataCache.size / traktRawDataCache.max) * 100).toFixed(2) + "%",
      itemCount: traktRawDataCache.size,
    },
    queryAnalysisCache: {
      size: queryAnalysisCache.size,
      maxSize: queryAnalysisCache.max,
      usagePercentage:
        ((queryAnalysisCache.size / queryAnalysisCache.max) * 100).toFixed(2) + "%",
      itemCount: queryAnalysisCache.size,
    },
    similarContentCache: {
      size: similarContentCache.size,
      maxSize: similarContentCache.max,
      usagePercentage:
        ((similarContentCache.size / similarContentCache.max) * 100).toFixed(2) + "%",
      itemCount: similarContentCache.size,
    },
  };
}

function serializeAllCaches() {
  return {
    tmdbCache: tmdbCache.serialize(),
    tmdbDetailsCache: tmdbDetailsCache.serialize(),
    tmdbDiscoverCache: tmdbDiscoverCache.serialize(),
    aiRecommendationsCache: aiRecommendationsCache.serialize(),
    rpdbCache: rpdbCache.serialize(),
    fanartCache: fanartCache.serialize(),
    traktCache: traktCache.serialize(),
    traktRawDataCache: traktRawDataCache.serialize(),
    queryAnalysisCache: queryAnalysisCache.serialize(),
    similarContentCache: similarContentCache.serialize(),
    stats: {
      queryCounter: queryCounter,
    },
  };
}

function deserializeAllCaches(data) {
  if (!data) {
    return false;
  }

  let success = true;
  try {
    if (data.tmdbCache) tmdbCache.deserialize(data.tmdbCache);
    if (data.tmdbDetailsCache) tmdbDetailsCache.deserialize(data.tmdbDetailsCache);
    if (data.tmdbDiscoverCache) tmdbDiscoverCache.deserialize(data.tmdbDiscoverCache);
    if (data.aiRecommendationsCache)
      aiRecommendationsCache.deserialize(data.aiRecommendationsCache);
    if (data.aiCache) aiRecommendationsCache.deserialize(data.aiCache);
    if (data.rpdbCache) rpdbCache.deserialize(data.rpdbCache);
    if (data.fanartCache) fanartCache.deserialize(data.fanartCache);
    if (data.traktCache) traktCache.deserialize(data.traktCache);
    if (data.traktRawDataCache) traktRawDataCache.deserialize(data.traktRawDataCache);
    if (data.queryAnalysisCache) queryAnalysisCache.deserialize(data.queryAnalysisCache);
    if (data.similarContentCache) similarContentCache.deserialize(data.similarContentCache);

    if (data.stats && typeof data.stats.queryCounter === "number") {
      queryCounter = data.stats.queryCounter;
      logger.info("Query counter restored from cache", {
        totalQueries: queryCounter,
      });
    }
  } catch (error) {
    logger.error("Error deserializing caches", { error: error.message });
    success = false;
  }

  return success;
}

setInterval(() => {
  const stats = getCacheStats();
  logger.info("Cache statistics", stats);
}, 60 * 60 * 1000);

module.exports = {
  SimpleLRUCache,
  tmdbCache,
  tmdbDetailsCache,
  aiRecommendationsCache,
  rpdbCache,
  fanartCache,
  similarContentCache,
  traktRawDataCache,
  traktCache,
  tmdbDiscoverCache,
  queryAnalysisCache,
  incrementQueryCounter,
  getQueryCount,
  setQueryCount,
  clearTmdbCache,
  clearTmdbDetailsCache,
  clearTmdbDiscoverCache,
  removeTmdbDiscoverCacheItem,
  listTmdbDiscoverCacheKeys,
  clearAiCache,
  removeAiCacheByKeywords,
  purgeEmptyAiCacheEntries,
  clearRpdbCache,
  clearFanartCache,
  clearTraktCache,
  clearTraktRawDataCache,
  clearQueryAnalysisCache,
  clearSimilarContentCache,
  getCacheStats,
  serializeAllCaches,
  deserializeAllCaches,
};
