const fetch = require("../utils/fetch");
const logger = require("../utils/logger");
const { withRetry } = require("../utils/apiRetry");
const { tmdbCache, tmdbDetailsCache } = require("../cache");

const TMDB_API_BASE =
  (process.env.TMDB_API_BASE || "https://api.themoviedb.org/3").replace(
    /\/+$/,
    ""
  );

async function searchTMDB(title, type, year, tmdbKey, language = "en-US", includeAdult = false) {
  const startTime = Date.now();
  logger.debug("Starting TMDB search", { title, type, year, includeAdult });
  const cacheKey = `${title}-${type}-${year}-${language}-adult:${includeAdult}`;

  if (tmdbCache.has(cacheKey)) {
    const cached = tmdbCache.get(cacheKey);
    logger.info("TMDB cache hit", {
      cacheKey,
      cachedAt: new Date(cached.timestamp).toISOString(),
      age: `${Math.round((Date.now() - cached.timestamp) / 1000)}s`,
      responseTime: `${Date.now() - startTime}ms`,
      title,
      type,
      year,
      language,
      hasImdbId: !!cached.data?.imdb_id,
      tmdbId: cached.data?.tmdb_id,
    });
    return cached.data;
  }

  logger.info("TMDB cache miss", { cacheKey, title, type, year, language });

  try {
    const searchType = type === "movie" ? "movie" : "tv";
    const searchParams = new URLSearchParams({
      api_key: tmdbKey,
      query: title,
      year: year,
      include_adult: includeAdult,
      language: language,
    });

    const searchUrl = `${TMDB_API_BASE}/search/${searchType}?${searchParams.toString()}`;

    logger.info("Making TMDB API call", {
      url: searchUrl.replace(tmdbKey, "***"),
      params: {
        type: searchType,
        query: title,
        year,
        language,
      },
    });

    const responseData = await withRetry(
      async () => {
        const searchResponse = await fetch(searchUrl);
        if (!searchResponse.ok) {
          const errorData = await searchResponse.json().catch(() => ({}));
          let errorMessage;

          if (searchResponse.status === 401) {
            errorMessage = "Invalid TMDB API key";
          } else if (searchResponse.status === 429) {
            errorMessage = "TMDB API rate limit exceeded";
          } else {
            errorMessage = `TMDB API error: ${searchResponse.status} ${
              errorData?.status_message || ""
            }`;
          }

          const error = new Error(errorMessage);
          error.status = searchResponse.status;
          error.isRateLimit = searchResponse.status === 429;
          error.isInvalidKey = searchResponse.status === 401;
          throw error;
        }
        return searchResponse.json();
      },
      {
        maxRetries: 3,
        initialDelay: 1000,
        maxDelay: 8000,
        operationName: "TMDB search API call",
        shouldRetry: (error) =>
          !error.isInvalidKey &&
          (!error.status || error.status >= 500 || error.isRateLimit),
      }
    );

    if (responseData.status_code) {
      logger.error("TMDB API error response", {
        duration: `${Date.now() - startTime}ms`,
        status_code: responseData.status_code,
        status_message: responseData.status_message,
        query: title,
        year: year,
      });
    } else {
      logger.info("TMDB API response", {
        duration: `${Date.now() - startTime}ms`,
        resultCount: responseData?.results?.length,
        status: "success",
        query: title,
        year: year,
        firstResult: responseData?.results?.[0]
          ? {
              id: responseData.results[0].id,
              title:
                responseData.results[0].title || responseData.results[0].name,
              year:
                responseData.results[0].release_date ||
                responseData.results[0].first_air_date,
              hasExternalIds: !!responseData.results[0].external_ids,
            }
          : null,
      });
    }

    if (responseData?.results?.[0]) {
      const result = responseData.results[0];

      const tmdbData = {
        poster: result.poster_path
          ? `https://image.tmdb.org/t/p/w500${result.poster_path}`
          : null,
        backdrop: result.backdrop_path
          ? `https://image.tmdb.org/t/p/original${result.backdrop_path}`
          : null,
        tmdbRating: result.vote_average,
        genres: result.genre_ids,
        overview: result.overview || "",
        tmdb_id: result.id,
        title: result.title || result.name,
        release_date: result.release_date || result.first_air_date,
      };

      if (!tmdbData.imdb_id) {
        const detailsCacheKey = `details_${searchType}_${result.id}_${language}`;
        let detailsData;

        if (tmdbDetailsCache.has(detailsCacheKey)) {
          const cachedDetails = tmdbDetailsCache.get(detailsCacheKey);
          logger.info("TMDB details cache hit", {
            cacheKey: detailsCacheKey,
            tmdbId: result.id,
            cachedAt: new Date(cachedDetails.timestamp).toISOString(),
            age: `${Math.round((Date.now() - cachedDetails.timestamp) / 1000)}s`,
            hasImdbId: !!(
              cachedDetails.data?.imdb_id ||
              cachedDetails.data?.external_ids?.imdb_id
            ),
          });
          detailsData = cachedDetails.data;
        } else {
          const detailsUrl = `${TMDB_API_BASE}/${searchType}/${result.id}?api_key=${tmdbKey}&append_to_response=external_ids&language=${language}`;

          logger.info("TMDB details cache miss", {
            cacheKey: detailsCacheKey,
            tmdbId: result.id,
          });

          logger.info("Making TMDB details API call", {
            url: detailsUrl.replace(tmdbKey, "***"),
            movieId: result.id,
            type: searchType,
          });

          detailsData = await withRetry(
            async () => {
              const detailsResponse = await fetch(detailsUrl);
              if (!detailsResponse.ok) {
                const errorData = await detailsResponse
                  .json()
                  .catch(() => ({}));
                const error = new Error(
                  `TMDB details API error: ${detailsResponse.status} ${
                    errorData?.status_message || ""
                  }`
                );
                error.status = detailsResponse.status;
                throw error;
              }
              return detailsResponse.json();
            },
            {
              maxRetries: 3,
              initialDelay: 1000,
              maxDelay: 8000,
              operationName: "TMDB details API call",
            }
          );

          logger.info("TMDB details response", {
            duration: `${Date.now() - startTime}ms`,
            hasImdbId: !!(
              detailsData?.imdb_id || detailsData?.external_ids?.imdb_id
            ),
            tmdbId: detailsData?.id,
            type: searchType,
          });

          tmdbDetailsCache.set(detailsCacheKey, {
            timestamp: Date.now(),
            data: detailsData,
          });

          logger.debug("TMDB details result cached", {
            cacheKey: detailsCacheKey,
            tmdbId: result.id,
            hasImdbId: !!(
              detailsData?.imdb_id || detailsData?.external_ids?.imdb_id
            ),
          });
        }

        if (detailsData) {
          tmdbData.imdb_id =
            detailsData.imdb_id || detailsData.external_ids?.imdb_id;

          logger.debug("IMDB ID extraction result", {
            title,
            type,
            tmdbId: result.id,
            hasImdbId: !!tmdbData.imdb_id,
            imdbId: tmdbData.imdb_id || "not_found",
          });
        }
      }

      tmdbCache.set(cacheKey, {
        timestamp: Date.now(),
        data: tmdbData,
      });

      logger.debug("TMDB result cached", {
        cacheKey,
        duration: Date.now() - startTime,
        hasData: !!tmdbData,
        hasImdbId: !!tmdbData.imdb_id,
        title,
        type,
        tmdbId: tmdbData.tmdb_id,
      });
      return tmdbData;
    }

    logger.debug("No TMDB results found", {
      title,
      type,
      year,
      duration: Date.now() - startTime,
    });

    tmdbCache.set(cacheKey, {
      timestamp: Date.now(),
      data: null,
    });
    return null;
  } catch (error) {
    logger.error("TMDB Search Error:", {
      error: error.message,
      stack: error.stack,
      errorType: error.isRateLimit
        ? "rate_limit"
        : error.isInvalidKey
        ? "invalid_key"
        : error.status
        ? `http_${error.status}`
        : "unknown",
      params: { title, type, year, tmdbKeyLength: tmdbKey?.length },
      retryAttempts: error.retryCount || 0,
    });
    return null;
  }
}

async function searchTMDBExactMatch(
  title,
  type,
  tmdbKey,
  language = "en-US",
  includeAdult = false
) {
  const startTime = Date.now();
  logger.debug("Starting TMDB exact match search", { title, type, includeAdult });
  const cacheKey = `tmdb_search_${title}-${type}-${language}-adult:${includeAdult}`;
  logger.debug("Starting TMDB search", { title, type, includeAdult });
  if (tmdbCache.has(cacheKey)) {
    const cached = tmdbCache.get(cacheKey);
    logger.info("TMDB search cache hit", {
      cacheKey,
      cachedAt: new Date(cached.timestamp).toISOString(),
      age: `${Math.round((Date.now() - cached.timestamp) / 1000)}s`,
      resultCount: cached.data?.length || 0,
    });
    const responseData = cached.data;
    if (responseData && responseData.length > 0) {
      const normalizedTitle = title.toLowerCase().trim();
      const exactMatch = responseData.find((result) => {
        const resultTitle = (result.title || result.name || "").toLowerCase().trim();
        return resultTitle === normalizedTitle;
      });
      return { isExactMatch: !!exactMatch, results: responseData };
    }
    return { isExactMatch: false, results: [] };
  }

  logger.info("TMDB search cache miss", { cacheKey, title, type, language });

  try {
    const searchType = type === "movie" ? "movie" : "tv";
    const searchParams = new URLSearchParams({
      api_key: tmdbKey,
      query: title,
      include_adult: includeAdult,
      language: language,
    });
    const searchUrl = `${TMDB_API_BASE}/search/${searchType}?${searchParams.toString()}`;
    logger.info("Making TMDB search API call", {
      url: searchUrl.replace(tmdbKey, "***"),
      params: { type: searchType, query: title, language },
    });
    const responseData = await withRetry(
      async () => {
        const searchResponse = await fetch(searchUrl);
        if (!searchResponse.ok) {
          const errorData = await searchResponse.json().catch(() => ({}));
          let errorMessage;
          if (searchResponse.status === 401) {
            errorMessage = "Invalid TMDB API key";
          } else if (searchResponse.status === 429) {
            errorMessage = "TMDB API rate limit exceeded";
          } else {
            errorMessage = `TMDB API error: ${searchResponse.status} ${
              errorData?.status_message || ""
            }`;
          }
          const error = new Error(errorMessage);
          error.status = searchResponse.status;
          error.isRateLimit = searchResponse.status === 429;
          error.isInvalidKey = searchResponse.status === 401;
          throw error;
        }
        return searchResponse.json();
      },
      {
        maxRetries: 3,
        initialDelay: 1000,
        maxDelay: 8000,
        operationName: "TMDB search API call",
        shouldRetry: (error) =>
          !error.isInvalidKey &&
          (!error.status || error.status >= 500 || error.isRateLimit),
      }
    );

    const results = responseData?.results || [];
    tmdbCache.set(cacheKey, {
      timestamp: Date.now(),
      data: results,
    });
    logger.info("TMDB search results cached", { cacheKey, count: results.length });

    if (results.length > 0) {
      const normalizedTitle = title.toLowerCase().trim();
      const exactMatch = responseData.results.find((result) => {
        const resultTitle = (result.title || result.name || "")
          .toLowerCase()
          .trim();
        return resultTitle === normalizedTitle;
      });
      if (exactMatch) {
        logger.info("TMDB exact match found within results", {
          title,
          exactMatchTitle: exactMatch.title || exactMatch.name,
        });
      }
      return { isExactMatch: !!exactMatch, results: results };
    }
    logger.debug("No TMDB exact match found", {
      title,
      type,
      duration: Date.now() - startTime,
    });
    return { isExactMatch: false, results: [] };
  } catch (error) {
    logger.error("TMDB Search Error:", {
      error: error.message,
      stack: error.stack,
      params: { title, type },
    });
    return { isExactMatch: false, results: [] };
  }
}

async function getTmdbDetailsByImdbId(imdbId, type, tmdbKey, language = "en-US") {
  const cacheKey = `tmdb_details_${imdbId}_${type}_${language}`;
  if (tmdbDetailsCache.has(cacheKey)) {
    const cached = tmdbDetailsCache.get(cacheKey);
    if (cached?.data) {
      return cached.data;
    }
  }

  try {
    const findUrl = `${TMDB_API_BASE}/find/${imdbId}?api_key=${tmdbKey}&language=${language}&external_source=imdb_id`;
    const response = await withRetry(
      async () => {
        const detailsResponse = await fetch(findUrl);
        if (!detailsResponse.ok) {
          const errorData = await detailsResponse.json().catch(() => ({}));
          const error = new Error(
            `TMDB find API error: ${detailsResponse.status} ${errorData?.status_message || ""}`
          );
          error.status = detailsResponse.status;
          throw error;
        }
        return detailsResponse.json();
      },
      {
        maxRetries: 3,
        initialDelay: 1000,
        maxDelay: 8000,
        operationName: "TMDB find API call",
      }
    );

    const results = type === "movie" ? response.movie_results : response.tv_results;
    if (results && results.length > 0) {
      const tmdbDetails = results[0];
      tmdbDetailsCache.set(cacheKey, {
        timestamp: Date.now(),
        data: tmdbDetails,
      });
      return tmdbDetails;
    }
  } catch (error) {
    logger.error("TMDB find error", {
      imdbId,
      type,
      error: error.message,
    });
  }

  return null;
}

module.exports = {
  searchTMDB,
  searchTMDBExactMatch,
  getTmdbDetailsByImdbId,
};
