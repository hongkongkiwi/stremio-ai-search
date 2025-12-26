const fetch = require("../utils/fetch");
const logger = require("../utils/logger");
const { withRetry } = require("../utils/apiRetry");
const { rpdbCache, fanartCache } = require("../cache");

const DEFAULT_RPDB_KEY = process.env.RPDB_API_KEY;
const DEFAULT_FANART_KEY = process.env.FANART_API_KEY;

function getRpdbTierFromApiKey(apiKey) {
  if (!apiKey) return -1;
  try {
    const tierMatch = apiKey.match(/^t(\\d+)-/);
    if (tierMatch && tierMatch[1] !== undefined) {
      return parseInt(tierMatch[1]);
    }
    return -1;
  } catch (error) {
    logger.error("Error parsing RPDB tier from API key", {
      error: error.message,
    });
    return -1;
  }
}

async function fetchFanartThumbnail(imdbId, fanartApiKey) {
  if (!imdbId) return null;

  const effectiveFanartKey = fanartApiKey || DEFAULT_FANART_KEY;
  if (!effectiveFanartKey) {
    logger.debug("No Fanart.tv API key available", { imdbId });
    return null;
  }

  const cacheKey = `fanart_thumb_${imdbId}`;

  if (fanartCache.has(cacheKey)) {
    const cached = fanartCache.get(cacheKey);
    logger.debug("Fanart thumbnail cache hit", {
      imdbId,
      cacheKey,
      cachedAt: new Date(cached.timestamp).toISOString(),
      age: `${Math.round((Date.now() - cached.timestamp) / 1000)}s`,
      keyType: fanartApiKey ? "user" : "default",
    });
    return cached.data;
  }

  logger.debug("Fanart thumbnail cache miss", {
    imdbId,
    cacheKey,
    keyType: fanartApiKey ? "user" : "default",
  });

  try {
    let fanart;
    try {
      const FanartApi = require("fanart.tv");
      fanart = new FanartApi(effectiveFanartKey);
    } catch (requireError) {
      logger.debug("Fanart.tv package not installed", {
        imdbId,
        error: "Package 'fanart.tv' not found. Install with: npm install fanart.tv",
      });
      return null;
    }

    logger.info("Making Fanart.tv API call", {
      imdbId,
      keyType: fanartApiKey ? "user" : "default",
      apiKeyPrefix: effectiveFanartKey.substring(0, 4) + "...",
    });

    const data = await withRetry(
      async () => {
        return await fanart.movies.get(imdbId);
      },
      {
        maxRetries: 3,
        baseDelay: 1000,
        shouldRetry: (error) => !error.status || error.status !== 401,
        operationName: "Fanart.tv API call",
      }
    );

    const thumbnail = data?.moviethumb
      ?.filter((thumb) => thumb.lang === "en" || !thumb.lang || thumb.lang.trim() === "")
      ?.sort((a, b) => b.likes - a.likes)[0]?.url;

    fanartCache.set(cacheKey, {
      timestamp: Date.now(),
      data: thumbnail,
    });

    logger.info("Fanart thumbnail API response", {
      imdbId,
      thumbnail: thumbnail ? "found" : "not_found",
      url: thumbnail ? thumbnail.substring(0, 50) + "..." : null,
      keyType: fanartApiKey ? "user" : "default",
    });

    return thumbnail;
  } catch (error) {
    logger.error("Fanart.tv API error", {
      imdbId,
      error: error.message,
      keyType: fanartApiKey ? "user" : "default",
    });

    fanartCache.set(cacheKey, {
      timestamp: Date.now(),
      data: null,
    });

    return null;
  }
}

async function getLandscapeThumbnail(tmdbData, imdbId, fanartApiKey) {
  if (fanartApiKey && imdbId) {
    try {
      const fanartThumb = await fetchFanartThumbnail(imdbId, fanartApiKey);
      if (fanartThumb) {
        logger.debug("Using Fanart.tv thumbnail", { imdbId, thumbnail: fanartThumb });
        return fanartThumb;
      }
    } catch (error) {
      logger.debug("Fanart.tv thumbnail fetch failed", { imdbId, error: error.message });
    }
  }

  if (tmdbData?.backdrop) {
    const landscapeBackdrop = tmdbData.backdrop.replace("/original", "/w780");
    logger.debug("Using TMDB backdrop as thumbnail", { imdbId, thumbnail: landscapeBackdrop });
    return landscapeBackdrop;
  }

  logger.debug("Using portrait poster as thumbnail fallback", {
    imdbId,
    thumbnail: tmdbData?.poster,
  });
  return tmdbData?.poster || null;
}

async function fetchRpdbPoster(
  imdbId,
  rpdbKey,
  posterType = "poster-default",
  isTier0User = false
) {
  if (!imdbId || !rpdbKey) {
    return null;
  }

  const cacheKey = `rpdb_${imdbId}_${posterType}`;
  const userTier = getRpdbTierFromApiKey(rpdbKey);
  const isDefaultKey = rpdbKey === DEFAULT_RPDB_KEY;
  const keyType = isDefaultKey ? "default" : "user";

  if (isTier0User && rpdbCache.has(cacheKey)) {
    const cached = rpdbCache.get(cacheKey);
    logger.debug("RPDB cache hit", { imdbId, cacheKey, keyType });
    return cached.data;
  }

  try {
    const response = await fetch(
      `https://api.ratingposterdb.com/${rpdbKey}/imdb/${imdbId}.json`
    );
    if (!response.ok) {
      throw new Error(`RPDB API error: ${response.status}`);
    }
    const data = await response.json();
    const posterUrl = data?.[posterType];

    if (isTier0User) {
      rpdbCache.set(cacheKey, {
        timestamp: Date.now(),
        data: posterUrl,
      });
    }

    if (!posterUrl) {
      logger.info("RPDB poster missing, fallback needed", {
        imdbId,
        keyType,
        userTier,
      });
    }

    return posterUrl || null;
  } catch (error) {
    logger.error("RPDB API error", {
      imdbId,
      error: error.message,
      keyType,
      userTier,
    });
    return null;
  }
}

module.exports = {
  getLandscapeThumbnail,
  fetchFanartThumbnail,
  fetchRpdbPoster,
  getRpdbTierFromApiKey,
};
