const fetch = require("../utils/fetch");
const logger = require("../utils/logger");
const { withRetry } = require("../utils/apiRetry");
const { traktRawDataCache, traktCache } = require("../cache");

const TRAKT_API_BASE = "https://api.trakt.tv";

async function fetchTraktIncrementalData(
  clientId,
  accessToken,
  type,
  lastUpdate,
  makeApiCall
) {
  // Format date for Trakt API (ISO string without milliseconds)
  const startDate = new Date(lastUpdate).toISOString().split(".")[0] + "Z";

  const endpoints = [
    `${TRAKT_API_BASE}/users/me/watched/${type}?extended=full&start_at=${startDate}&page=1&limit=100`,
    `${TRAKT_API_BASE}/users/me/ratings/${type}?extended=full&start_at=${startDate}&page=1&limit=100`,
    `${TRAKT_API_BASE}/users/me/history/${type}?extended=full&start_at=${startDate}&page=1&limit=100`,
  ];

  const headers = {
    "Content-Type": "application/json",
    "trakt-api-version": "2",
    "trakt-api-key": clientId,
    Authorization: `Bearer ${accessToken}`,
  };

  // Fetch all data in parallel
  const responses = await Promise.all(
    endpoints.map((endpoint) =>
      makeApiCall(endpoint, headers)
        .then((res) => res.json())
        .catch((err) => {
          logger.error("Trakt API Error:", { endpoint, error: err.message });
          return [];
        })
    )
  );

  return {
    watched: responses[0] || [],
    rated: responses[1] || [],
    history: responses[2] || [],
  };
}

// Main function to fetch Trakt data with optimizations
async function fetchTraktWatchedAndRated(
  clientId,
  accessToken,
  type = "movies",
  config = null,
  helpers = {}
) {
  logger.info("fetchTraktWatchedAndRated called", {
    hasClientId: !!clientId,
    clientIdLength: clientId?.length,
    hasAccessToken: !!accessToken,
    accessTokenLength: accessToken?.length,
    type,
  });

  if (!clientId || !accessToken) {
    logger.error("Missing Trakt credentials", {
      hasClientId: !!clientId,
      hasAccessToken: !!accessToken,
    });
    return null;
  }

  const makeApiCall =
    helpers.makeApiCall ||
    (async (url, headers) => {
    return await withRetry(
      async () => {
        const response = await fetch(url, { headers });
        
        if (response.status === 401) {
          logger.warn(
            "Trakt access token is expired. Personalized recommendations will be unavailable until the user updates their configuration."
          );
        }
        
        return response;
      },
      {
        maxRetries: 3,
        baseDelay: 1000,
        shouldRetry: (error) => !error.status || (error.status !== 401 && error.status !== 403),
        operationName: "Trakt API call"
      }
    );
  });

  const rawCacheKey = `trakt_raw_${accessToken}_${type}`;
  const processedCacheKey = `trakt_${accessToken}_${type}`;

  // Check if we have processed data in cache
  if (traktCache.has(processedCacheKey)) {
    const cached = traktCache.get(processedCacheKey);
    logger.info("Trakt processed cache hit", {
      cacheKey: processedCacheKey,
      type,
      cachedAt: new Date(cached.timestamp).toISOString(),
      age: `${Math.round((Date.now() - cached.timestamp) / 1000)}s`,
    });
    return cached.data;
  }

  // Check if we have raw data that needs updating
  let rawData;
  let isIncremental = false;

  if (traktRawDataCache.has(rawCacheKey)) {
    const cachedRaw = traktRawDataCache.get(rawCacheKey);
    const lastUpdate = cachedRaw.lastUpdate || cachedRaw.timestamp;

    // Always do incremental updates when cache exists, regardless of age
    logger.info("Performing incremental Trakt update", {
      cacheKey: rawCacheKey,
      lastUpdate: new Date(lastUpdate).toISOString(),
      age: `${Math.round((Date.now() - lastUpdate) / 1000)}s`,
    });

    try {
      // Fetch only new data since last update
      const newData = await fetchTraktIncrementalData(
        clientId,
        accessToken,
        type,
        lastUpdate,
        makeApiCall
      );

      // Merge with existing data
      if (!helpers.mergeAndDeduplicate) {
        throw new Error("Missing mergeAndDeduplicate helper");
      }

      rawData = {
        watched: helpers.mergeAndDeduplicate(newData.watched, cachedRaw.data.watched),
        rated: helpers.mergeAndDeduplicate(newData.rated, cachedRaw.data.rated),
        history: helpers.mergeAndDeduplicate(newData.history, cachedRaw.data.history),
        lastUpdate: Date.now(),
      };

      isIncremental = true;

      // Update raw data cache
      traktRawDataCache.set(rawCacheKey, {
        timestamp: Date.now(),
        lastUpdate: Date.now(),
        data: rawData,
      });

      logger.info("Incremental Trakt update completed", {
        newWatchedCount: newData.watched.length,
        newRatedCount: newData.rated.length,
        newHistoryCount: newData.history.length,
        totalWatchedCount: rawData.watched.length,
        totalRatedCount: rawData.rated.length,
        totalHistoryCount: rawData.history.length,
      });
    } catch (error) {
      logger.error(
        "Incremental Trakt update failed, falling back to full refresh",
        {
          error: error.message,
        }
      );
      isIncremental = false;
    }
  }

  // If we don't have raw data or incremental update failed, do a full refresh
  if (!rawData) {
    logger.info("Performing full Trakt data refresh", { type });

    try {
      const fetchStart = Date.now();
      // Use the original fetch logic for a full refresh but without limits
      const endpoints = [
        `${TRAKT_API_BASE}/users/me/watched/${type}?extended=full&page=1&limit=100`,
        `${TRAKT_API_BASE}/users/me/ratings/${type}?extended=full&page=1&limit=100`,
        `${TRAKT_API_BASE}/users/me/history/${type}?extended=full&page=1&limit=100`,
      ];

      const headers = {
        "Content-Type": "application/json",
        "trakt-api-version": "2",
        "trakt-api-key": clientId,
        Authorization: `Bearer ${accessToken}`,
      };

      const responses = await Promise.all(
        endpoints.map((endpoint) =>
          makeApiCall(endpoint, headers)
            .then((res) => res.json())
            .catch((err) => {
              logger.error("Trakt API Error:", {
                endpoint,
                error: err.message,
              });
              return [];
            })
        )
      );

      const fetchTime = Date.now() - fetchStart;
      const [watched, rated, history] = responses;

      rawData = {
        watched: watched || [],
        rated: rated || [],
        history: history || [],
        lastUpdate: Date.now(),
      };

      // Update raw data cache
      traktRawDataCache.set(rawCacheKey, {
        timestamp: Date.now(),
        lastUpdate: Date.now(),
        data: rawData,
      });

      logger.info("Full Trakt refresh completed", {
        fetchTimeMs: fetchTime,
        watchedCount: rawData.watched.length,
        ratedCount: rawData.rated.length,
        historyCount: rawData.history.length,
      });
    } catch (error) {
      logger.error("Trakt API Error:", {
        error: error.message,
        stack: error.stack,
      });
      return null;
    }
  }

  // Process the data (raw or incrementally updated) in parallel
  const processingStart = Date.now();
  if (!helpers.processPreferencesInParallel) {
    throw new Error("Missing processPreferencesInParallel helper");
  }
  const preferences = await helpers.processPreferencesInParallel(
    rawData.watched,
    rawData.rated,
    rawData.history
  );
  const processingTime = Date.now() - processingStart;

  // Create the final result
  const result = {
    watched: rawData.watched,
    rated: rawData.rated,
    history: rawData.history,
    preferences,
    lastUpdate: rawData.lastUpdate,
    isIncrementalUpdate: isIncremental,
  };

  // Cache the processed result
  traktCache.set(processedCacheKey, {
    timestamp: Date.now(),
    data: result,
  });

  logger.info("Trakt data processing and caching completed", {
    processingTimeMs: processingTime,
    isIncremental: isIncremental,
    cacheKey: processedCacheKey,
  });

  return result;
}

module.exports = {
  fetchTraktWatchedAndRated,
};
