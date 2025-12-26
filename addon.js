const { addonBuilder } = require("stremio-addon-sdk");
const fetch = require("./utils/fetch");
const logger = require("./utils/logger");
const { decryptConfig } = require("./utils/crypto");
const { withRetry } = require("./utils/apiRetry");
const {
  createAiTextGenerator,
  getAiProviderConfigFromConfig,
} = require("./utils/aiProvider");
const { getMcpContext } = require("./utils/mcp");
const {
  DEFAULT_NUM_RESULTS,
  DEFAULT_ENABLE_SIMILAR,
  DEFAULT_INCLUDE_ADULT,
  DEFAULT_SIMILAR_NUM_RESULTS,
} = require("./config/defaults");
const {
  aiRecommendationsCache,
  similarContentCache,
  traktRawDataCache,
  traktCache,
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
  incrementQueryCounter,
  getQueryCount,
  setQueryCount,
} = require("./cache");
const {
  searchTMDB,
  searchTMDBExactMatch,
  getTmdbDetailsByImdbId,
} = require("./services/tmdb");
const { fetchTraktWatchedAndRated } = require("./services/trakt");
const {
  getLandscapeThumbnail,
  fetchRpdbPoster,
  getRpdbTierFromApiKey,
} = require("./services/posters");
const DEFAULT_RPDB_KEY = process.env.RPDB_API_KEY;
const ENABLE_LOGGING = process.env.ENABLE_LOGGING === "true" || false;
const DEFAULT_TRAKT_CLIENT_ID = process.env.TRAKT_CLIENT_ID;
const MAX_AI_RECOMMENDATIONS = 30;

const HOST = process.env.HOST
  ? `https://${process.env.HOST}`
  : "https://stremio.itcon.au";
const PORT = 7000;
const BASE_PATH = "/aisearch";

const DEFAULT_GEMINI_MODEL = "gemini-2.0-flash-lite";

// Helper function to merge and deduplicate Trakt items
function mergeAndDeduplicate(newItems, existingItems) {
  // Create a map of existing items by ID for quick lookup
  const existingMap = new Map();
  existingItems.forEach((item) => {
    const media = item.movie || item.show;
    const id = item.id || media?.ids?.trakt;
    if (id) {
      existingMap.set(id, item);
    }
  });

  // Add new items, replacing existing ones if newer
  newItems.forEach((item) => {
    const media = item.movie || item.show;
    const id = item.id || media?.ids?.trakt;
    if (id) {
      // If item exists, keep the newer one based on last_activity or just replace
      if (
        !existingMap.has(id) ||
        (item.last_activity &&
          existingMap.get(id).last_activity &&
          new Date(item.last_activity) >
            new Date(existingMap.get(id).last_activity))
      ) {
        existingMap.set(id, item);
      }
    }
  });

  // Convert map back to array
  return Array.from(existingMap.values());
}

// Modular functions for processing different aspects of Trakt data
function processGenres(watchedItems, ratedItems) {
  const genres = new Map();

  // Process watched items
  watchedItems?.forEach((item) => {
    const media = item.movie || item.show;
    media.genres?.forEach((genre) => {
      genres.set(genre, (genres.get(genre) || 0) + 1);
    });
  });

  // Process rated items with weights
  ratedItems?.forEach((item) => {
    const media = item.movie || item.show;
    const weight = item.rating / 5; // normalize rating to 0-1
    media.genres?.forEach((genre) => {
      genres.set(genre, (genres.get(genre) || 0) + weight);
    });
  });

  // Convert to sorted array
  return Array.from(genres.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([genre, count]) => ({ genre, count }));
}

function processActors(watchedItems, ratedItems) {
  const actors = new Map();

  // Process watched items
  watchedItems?.forEach((item) => {
    const media = item.movie || item.show;
    media.cast?.forEach((actor) => {
      actors.set(actor.name, (actors.get(actor.name) || 0) + 1);
    });
  });

  // Process rated items with weights
  ratedItems?.forEach((item) => {
    const media = item.movie || item.show;
    const weight = item.rating / 5; // normalize rating to 0-1
    media.cast?.forEach((actor) => {
      actors.set(actor.name, (actors.get(actor.name) || 0) + weight);
    });
  });

  // Convert to sorted array
  return Array.from(actors.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([actor, count]) => ({ actor, count }));
}

function processDirectors(watchedItems, ratedItems) {
  const directors = new Map();

  // Process watched items
  watchedItems?.forEach((item) => {
    const media = item.movie || item.show;
    media.crew?.forEach((person) => {
      if (person.job === "Director") {
        directors.set(person.name, (directors.get(person.name) || 0) + 1);
      }
    });
  });

  // Process rated items with weights
  ratedItems?.forEach((item) => {
    const media = item.movie || item.show;
    const weight = item.rating / 5; // normalize rating to 0-1
    media.crew?.forEach((person) => {
      if (person.job === "Director") {
        directors.set(person.name, (directors.get(person.name) || 0) + weight);
      }
    });
  });

  // Convert to sorted array
  return Array.from(directors.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([director, count]) => ({ director, count }));
}

function processYears(watchedItems, ratedItems) {
  const years = new Map();

  // Process watched items
  watchedItems?.forEach((item) => {
    const media = item.movie || item.show;
    const year = parseInt(media.year);
    if (year) {
      years.set(year, (years.get(year) || 0) + 1);
    }
  });

  // Process rated items with weights
  ratedItems?.forEach((item) => {
    const media = item.movie || item.show;
    const year = parseInt(media.year);
    const weight = item.rating / 5; // normalize rating to 0-1
    if (year) {
      years.set(year, (years.get(year) || 0) + weight);
    }
  });

  // If no years data, return null
  if (years.size === 0) {
    return null;
  }

  // Create year range object
  return {
    start: Math.min(...years.keys()),
    end: Math.max(...years.keys()),
    preferred: Array.from(years.entries()).sort((a, b) => b[1] - a[1])[0]?.[0],
  };
}

function processRatings(ratedItems) {
  const ratings = new Map();

  // Process ratings distribution
  ratedItems?.forEach((item) => {
    ratings.set(item.rating, (ratings.get(item.rating) || 0) + 1);
  });

  // Convert to sorted array
  return Array.from(ratings.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([rating, count]) => ({ rating, count }));
}

// Process all preferences in parallel
async function processPreferencesInParallel(watched, rated, history) {
  const processingStart = Date.now();

  // Run all processing functions in parallel
  const [genres, actors, directors, yearRange, ratings] = await Promise.all([
    Promise.resolve(processGenres(watched, rated)),
    Promise.resolve(processActors(watched, rated)),
    Promise.resolve(processDirectors(watched, rated)),
    Promise.resolve(processYears(watched, rated)),
    Promise.resolve(processRatings(rated)),
  ]);

  const processingTime = Date.now() - processingStart;
  logger.debug("Trakt preference processing completed", {
    processingTimeMs: processingTime,
    genresCount: genres.length,
    actorsCount: actors.length,
    directorsCount: directors.length,
    hasYearRange: !!yearRange,
    ratingsCount: ratings.length,
  });

  return {
    genres,
    actors,
    directors,
    yearRange,
    ratings,
  };
}

/**
 * Creates a Stremio meta object with a dynamically generated SVG poster for displaying errors.
 * @param {string} title - The title of the error message.
 * @param {string} message - The main body of the error message.
 * @returns {object} A Stremio meta object.
 */
function createErrorMeta(title, message) {
  // Simple text wrapping for the message
  const words = message.split(' ');
  let lines = [];
  let currentLine = words[0] || '';
  for (let i = 1; i < words.length; i++) {
    let testLine = currentLine + ' ' + words[i];
    if (testLine.length > 35) { // Approx characters per line
      lines.push(currentLine);
      currentLine = words[i];
    } else {
      currentLine = testLine;
    }
  }
  lines.push(currentLine);

  // Generate tspan elements for each line
  const messageTspans = lines.map((line, index) => `<tspan x="250" y="${560 + index * 30}">${line}</tspan>`).join('');

  const svg = `
    <svg width="500" height="750" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#2d2d2d" />
      <path d="M250 50 L450 400 L50 400 Z" fill="#c0392b"/>
      <path d="M250 120 L400 380 L100 380 Z" fill="#e74c3c"/>
      <text fill="white" font-size="60" font-family="Arial, sans-serif" x="250" y="270" text-anchor="middle" font-weight="bold">!</text>
      <text fill="white" font-size="32" font-family="Arial, sans-serif" x="250" y="500" text-anchor="middle" font-weight="bold">${title}</text>
      <text fill="white" font-size="24" font-family="Arial, sans-serif" text-anchor="middle">
        ${messageTspans}
      </text>
      <text fill="#bdc3c7" font-size="20" font-family="Arial, sans-serif" x="250" y="700" text-anchor="middle">Please check the addon configuration.</text>
    </svg>
  `;

  const posterDataUri = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

  return {
    id: `error:${title.replace(/\s+/g, '_')}`,
    type: 'movie',
    name: title,
    description: message,
    poster: posterDataUri,
    posterShape: 'regular',
  };
}

// Function to fetch incremental Trakt data

/**
 * Determines the intent of a search query based on keywords
 * @param {string} query
 * @returns {"movie"|"series"|"ambiguous"}
 */
function determineIntentFromKeywords(query) {
  if (!query) return "ambiguous";

  const normalizedQuery = query.toLowerCase().trim();

  const movieKeywords = {
    strong: [
      /\bmovie(s)?\b/,
      /\bfilm(s)?\b/,
      /\bcinema\b/,
      /\bfeature\b/,
      /\bmotion picture\b/,
    ],
    medium: [
      /\bdirector\b/,
      /\bscreenplay\b/,
      /\bboxoffice\b/,
      /\btheater\b/,
      /\btheatre\b/,
      /\bcinematic\b/,
    ],
    weak: [
      /\bwatch\b/,
      /\bactor\b/,
      /\bactress\b/,
      /\bscreenwriter\b/,
      /\bproducer\b/,
    ],
  };

  const seriesKeywords = {
    strong: [
      /\bseries\b/,
      /\btv show(s)?\b/,
      /\btelevision\b/,
      /\bshow(s)?\b/,
      /\bepisode(s)?\b/,
      /\bseason(s)?\b/,
      /\bdocumentary?\b/,
      /\bdocumentaries?\b/,
    ],
    medium: [
      /\bnetflix\b/,
      /\bhbo\b/,
      /\bhulu\b/,
      /\bamazon prime\b/,
      /\bdisney\+\b/,
      /\bapple tv\+\b/,
      /\bpilot\b/,
      /\bfinale\b/,
    ],
    weak: [
      /\bcharacter\b/,
      /\bcast\b/,
      /\bplot\b/,
      /\bstoryline\b/,
      /\bnarrative\b/,
    ],
  };

  let movieScore = 0;
  let seriesScore = 0;

  for (const pattern of movieKeywords.strong) {
    if (pattern.test(normalizedQuery)) movieScore += 3;
  }

  for (const pattern of movieKeywords.medium) {
    if (pattern.test(normalizedQuery)) movieScore += 2;
  }

  for (const pattern of movieKeywords.weak) {
    if (pattern.test(normalizedQuery)) movieScore += 1;
  }

  for (const pattern of seriesKeywords.strong) {
    if (pattern.test(normalizedQuery)) seriesScore += 3;
  }

  for (const pattern of seriesKeywords.medium) {
    if (pattern.test(normalizedQuery)) seriesScore += 2;
  }

  for (const pattern of seriesKeywords.weak) {
    if (pattern.test(normalizedQuery)) seriesScore += 1;
  }

  if (/\b(netflix|hulu|hbo|disney\+|apple tv\+)\b/.test(normalizedQuery)) {
    seriesScore += 1;
  }

  if (/\b(cinema|theatrical|box office|imax)\b/.test(normalizedQuery)) {
    movieScore += 1;
  }

  if (/\b\d{4}-\d{4}\b/.test(normalizedQuery)) {
    seriesScore += 1;
  }

  logger.debug("Intent detection scores", {
    query: normalizedQuery,
    movieScore,
    seriesScore,
    difference: Math.abs(movieScore - seriesScore),
  });

  const scoreDifference = Math.abs(movieScore - seriesScore);
  const scoreThreshold = 2;

  if (scoreDifference < scoreThreshold) {
    return "ambiguous";
  } else if (movieScore > seriesScore) {
    return "movie";
  } else {
    return "series";
  }
}

function extractGenreCriteria(query) {
  const q = query.toLowerCase();

  const basicGenres = {
    action: /\b(action)\b/i,
    comedy: /\b(comedy|comedies|funny)\b/i,
    drama: /\b(drama|dramas|dramatic)\b/i,
    horror: /\b(horror|scary|frightening)\b/i,
    thriller: /\b(thriller|thrillers|suspense)\b/i,
    romance: /\b(romance|romantic|love)\b/i,
    scifi: /\b(sci-?fi|science\s*fiction)\b/i,
    fantasy: /\b(fantasy|magical)\b/i,
    documentary: /\b(documentary|documentaries)\b/i,
    animation: /\b(animation|animations|animated|anime)\b/i,
    adventure: /\b(adventure|adventures)\b/i,
    crime: /\b(crime|criminal|detective|detectives)\b/i,
    mystery: /\b(mystery|mysteries|detective|detectives)\b/i,
    family: /\b(family|kid-friendly|children|childrens)\b/i,
    biography: /\b(biography|biopic|biographical|biopics)\b/i,
    history: /\b(history|historical)\b/i,
    gore: /\b(gore|gory|bloody)\b/i,
    // TV specific genres
    reality: /\b(reality|realty)\s*(tv|show|series)?\b/i,
    "talk show": /\b(talk\s*show|talk\s*series)\b/i,
    soap: /\b(soap\s*opera?|soap\s*series|soap)\b/i,
    news: /\b(news|newscast|news\s*program)\b/i,
    kids: /\b(kids?|children|childrens|youth)\b/i,
  };

  const subGenres = {
    cyberpunk: /\b(cyberpunk|cyber\s*punk)\b/i,
    noir: /\b(noir|neo-noir)\b/i,
    psychological: /\b(psychological)\b/i,
    superhero: /\b(superhero|comic\s*book|marvel|dc)\b/i,
    musical: /\b(musical|music)\b/i,
    war: /\b(war|military)\b/i,
    western: /\b(western|cowboy)\b/i,
    sports: /\b(sports?|athletic)\b/i,
  };

  const moods = {
    feelGood: /\b(feel-?good|uplifting|heartwarming)\b/i,
    dark: /\b(dark|gritty|disturbing)\b/i,
    thoughtProvoking: /\b(thought-?provoking|philosophical|deep)\b/i,
    intense: /\b(intense|gripping|edge.*seat)\b/i,
    lighthearted: /\b(light-?hearted|fun|cheerful)\b/i,
  };

  // Create a set of all supported genres for quick lookup
  const supportedGenres = new Set([
    ...Object.keys(basicGenres),
    ...Object.keys(subGenres),
  ]);

  // Add common genre aliases that might appear in exclusions
  const genreAliases = {
    "sci-fi": "scifi",
    "science fiction": "scifi",
    "rom-com": "comedy",
    "romantic comedy": "comedy",
    "rom com": "comedy",
    "super hero": "superhero",
    "super-hero": "superhero",
  };

  // Add aliases to supported genres
  Object.keys(genreAliases).forEach((alias) => {
    supportedGenres.add(alias);
  });

  const combinedPattern =
    /(?:action[- ]comedy|romantic[- ]comedy|sci-?fi[- ]horror|dark[- ]comedy|romantic[- ]thriller)/i;

  // First, find all negated genres
  const notPattern = /\b(?:not|no|except|excluding)\s+(\w+(?:\s+\w+)?)/gi;
  const excludedGenres = new Set();
  let match;
  while ((match = notPattern.exec(q)) !== null) {
    const negatedTerm = match[1].toLowerCase().trim();
    // Check if it's a direct genre or has an alias
    if (supportedGenres.has(negatedTerm)) {
      excludedGenres.add(genreAliases[negatedTerm] || negatedTerm);
    } else {
      // Check against genre patterns
      for (const [genre, pattern] of Object.entries(basicGenres)) {
        if (pattern.test(negatedTerm)) {
          excludedGenres.add(genre);
          break;
        }
      }
      for (const [genre, pattern] of Object.entries(subGenres)) {
        if (pattern.test(negatedTerm)) {
          excludedGenres.add(genre);
          break;
        }
      }
    }
  }

  const genres = {
    include: [],
    exclude: Array.from(excludedGenres),
    mood: [],
    style: [],
  };

  // Handle combined genres
  const combinedMatch = q.match(combinedPattern);
  if (combinedMatch) {
    genres.include.push(combinedMatch[0].toLowerCase().replace(/\s+/g, "-"));
  }

  // After processing exclusions, check for genres to include
  // but make sure they're not in the excluded set
  for (const [genre, pattern] of Object.entries(basicGenres)) {
    if (pattern.test(q) && !excludedGenres.has(genre)) {
      // Don't include if it appears in a negation context
      const genreIndex = q.search(pattern);
      const beforeGenre = q.substring(0, genreIndex);
      if (!beforeGenre.match(/\b(not|no|except|excluding)\s+$/)) {
        genres.include.push(genre);
      }
    }
  }

  for (const [subgenre, pattern] of Object.entries(subGenres)) {
    if (pattern.test(q) && !excludedGenres.has(subgenre)) {
      // Don't include if it appears in a negation context
      const genreIndex = q.search(pattern);
      const beforeGenre = q.substring(0, genreIndex);
      if (!beforeGenre.match(/\b(not|no|except|excluding)\s+$/)) {
        genres.include.push(subgenre);
      }
    }
  }

  for (const [mood, pattern] of Object.entries(moods)) {
    if (pattern.test(q)) {
      genres.mood.push(mood);
    }
  }

  return Object.values(genres).some((arr) => arr.length > 0) ? genres : null;
}

// Add this function to better detect recommendation queries
function isRecommendationQuery(query) {
  return query.toLowerCase().trim().startsWith("recommend");
}

/**
 * Checks if an item is in the user's watch history or rated items
 * @param {Object} item - The item to check
 * @param {Array} watchHistory - The user's watch history from Trakt
 * @param {Array} ratedItems - The user's rated items from Trakt
 * @returns {boolean} - True if the item is in the watch history or rated items
 */
function isItemWatchedOrRated(item, watchHistory, ratedItems) {
  if (!item) {
    return false;
  }

  // Normalize the item name for comparison
  const normalizedName = item.name.toLowerCase().trim();
  const itemYear = parseInt(item.year);

  // Debug logging for specific items (uncomment for troubleshooting)
  // if (normalizedName.includes("specific movie title")) {
  //   logger.debug("Checking specific item", {
  //     item: { name: item.name, year: item.year },
  //     watchHistoryCount: watchHistory?.length || 0,
  //     ratedItemsCount: ratedItems?.length || 0
  //   });
  // }

  // Check if the item exists in watch history
  const isWatched =
    watchHistory &&
    watchHistory.length > 0 &&
    watchHistory.some((historyItem) => {
      const media = historyItem.movie || historyItem.show;
      if (!media) return false;

      const historyName = media.title.toLowerCase().trim();
      const historyYear = parseInt(media.year);

      const isMatch =
        normalizedName === historyName &&
        (!itemYear || !historyYear || itemYear === historyYear);

      // Debug logging for specific items (uncomment for troubleshooting)
      // if (normalizedName.includes("specific movie title") && isMatch) {
      //   logger.debug("Found match in watch history", {
      //     recommendation: { name: item.name, year: item.year },
      //     watchedItem: { title: media.title, year: media.year }
      //   });
      // }

      return isMatch;
    });

  // Check if the item exists in rated items
  const isRated =
    ratedItems &&
    ratedItems.length > 0 &&
    ratedItems.some((ratedItem) => {
      const media = ratedItem.movie || ratedItem.show;
      if (!media) return false;

      const ratedName = media.title.toLowerCase().trim();
      const ratedYear = parseInt(media.year);

      const isMatch =
        normalizedName === ratedName &&
        (!itemYear || !ratedYear || itemYear === ratedYear);

      // Debug logging for specific items (uncomment for troubleshooting)
      // if (normalizedName.includes("specific movie title") && isMatch) {
      //   logger.debug("Found match in rated items", {
      //     recommendation: { name: item.name, year: item.year },
      //     ratedItem: { title: media.title, year: media.year, rating: ratedItem.rating }
      //   });
      // }

      return isMatch;
    });

  return isWatched || isRated;
}

async function toStremioMeta(
  item,
  platform = "unknown",
  tmdbKey,
  rpdbKey,
  rpdbPosterType = "poster-default",
  language = "en-US",
  config,
  includeAdult = false
) {
  if (!item.id || !item.name) {
    return null;
  }

  const type = item.type || (item.id.includes("movie") ? "movie" : "series");

  const enableRpdb =
    config?.EnableRpdb !== undefined ? config.EnableRpdb : false;
  const userRpdbKey = config?.RpdbApiKey;
  const usingUserKey = !!userRpdbKey;
  const usingDefaultKey = !userRpdbKey && !!DEFAULT_RPDB_KEY;
  const userTier = usingUserKey ? getRpdbTierFromApiKey(userRpdbKey) : -1;
  const isTier0User = (usingUserKey && userTier === 0) || usingDefaultKey;

const tmdbData = await searchTMDB(
    item.name,
    type,
    item.year,
    tmdbKey,
    language,
    includeAdult
  );

  if (!tmdbData || !tmdbData.imdb_id) {
    return null;
  }

  // Start with TMDB poster as the default
  let poster = tmdbData.poster;
  let posterSource = "tmdb";

  // Only try RPDB if RPDB is enabled AND (a user key is provided OR a default key exists)
  const effectiveRpdbKey = userRpdbKey || DEFAULT_RPDB_KEY;
  if (enableRpdb && effectiveRpdbKey && tmdbData.imdb_id) {
    try {
      const rpdbPoster = await fetchRpdbPoster(
        tmdbData.imdb_id,
        effectiveRpdbKey,
        rpdbPosterType,
        isTier0User
      );
      if (rpdbPoster) {
        poster = rpdbPoster;
        posterSource = "rpdb";
        logger.debug("Using RPDB poster", {
          imdbId: tmdbData.imdb_id,
          posterType: rpdbPosterType,
          poster: rpdbPoster,
          userTier: usingUserKey
            ? userTier === 0
              ? "tier0"
              : `tier${userTier}`
            : "default-key",
          isTier0User: isTier0User,
          keyType: usingUserKey ? "user" : "default",
        });
      } else {
        logger.debug("No RPDB poster available, using TMDB poster", {
          imdbId: tmdbData.imdb_id,
          tmdbPoster: poster ? "available" : "unavailable",
          userTier: usingUserKey
            ? userTier === 0
              ? "tier0"
              : `tier${userTier}`
            : "default-key",
          isTier0User: isTier0User,
          keyType: usingUserKey ? "user" : "default",
        });
      }
    } catch (error) {
      logger.debug("RPDB poster fetch failed, using TMDB poster", {
        imdbId: tmdbData.imdb_id,
        error: error.message,
        tmdbPoster: poster ? "available" : "unavailable",
        userTier: usingUserKey
          ? userTier === 0
            ? "tier0"
            : `tier${userTier}`
          : "default-key",
        isTier0User: isTier0User,
        keyType: usingUserKey ? "user" : "default",
      });
    }
  }

  if (!poster) {
    logger.debug("No poster available from either source", {
      title: item.name,
      year: item.year,
      imdbId: tmdbData.imdb_id,
    });
    return null;
  }

  const meta = {
    id: tmdbData.imdb_id,
    type: type,
    name: tmdbData.title || tmdbData.name,
    description:
      platform === "android-tv"
        ? (tmdbData.overview || "").slice(0, 200)
        : tmdbData.overview || "",
    year: parseInt(item.year) || 0,
    poster:
      platform === "android-tv" && poster.includes("/w500/")
        ? poster.replace("/w500/", "/w342/")
        : poster,
    background: tmdbData.backdrop,
    posterShape: "regular",
    posterSource,
  };

  if (tmdbData.genres && tmdbData.genres.length > 0) {
    meta.genres = tmdbData.genres
      .map((id) => (type === "series" ? TMDB_TV_GENRES[id] : TMDB_GENRES[id]))
      .filter(Boolean);
  }

  return meta;
}

function detectPlatform(extra = {}) {
  if (extra.headers?.["stremio-platform"]) {
    return extra.headers["stremio-platform"];
  }

  const userAgent = (
    extra.userAgent ||
    extra.headers?.["stremio-user-agent"] ||
    ""
  ).toLowerCase();

  if (
    userAgent.includes("android tv") ||
    userAgent.includes("chromecast") ||
    userAgent.includes("androidtv")
  ) {
    return "android-tv";
  }

  if (
    userAgent.includes("android") ||
    userAgent.includes("mobile") ||
    userAgent.includes("phone")
  ) {
    return "mobile";
  }

  if (
    userAgent.includes("windows") ||
    userAgent.includes("macintosh") ||
    userAgent.includes("linux")
  ) {
    return "desktop";
  }

  return "unknown";
}

const TMDB_GENRES = {
  28: "Action",
  12: "Adventure",
  16: "Animation",
  35: "Comedy",
  80: "Crime",
  99: "Documentary",
  18: "Drama",
  10751: "Family",
  14: "Fantasy",
  36: "History",
  27: "Horror",
  10402: "Music",
  9648: "Mystery",
  10749: "Romance",
  878: "Science Fiction",
  10770: "TV Movie",
  53: "Thriller",
  10752: "War",
  37: "Western",
};

// TV specific genres
const TMDB_TV_GENRES = {
  10759: "Action & Adventure",
  16: "Animation",
  35: "Comedy",
  80: "Crime",
  99: "Documentary",
  18: "Drama",
  10751: "Family",
  10762: "Kids",
  9648: "Mystery",
  10763: "News",
  10764: "Reality",
  10765: "Sci-Fi & Fantasy",
  10766: "Soap",
  10767: "Talk",
  10768: "War & Politics",
  37: "Western",
};

/**
 * Makes an AI call to determine the content type and genres for a recommendation query
 * @param {string} query - The user's search query
 * @param {{ provider: string, model: string, generateText: (prompt: string) => Promise<string> }} aiClient
 * @returns {Promise<{type: string, genres: string[]}>} - The discovered type and genres
 */
async function discoverTypeAndGenres(query, aiClient) {
  const promptText = `
Analyze this recommendation query: "${query}"

Determine:
1. What type of content is being requested (movie, series, or ambiguous)
2. What genres are relevant to this query (be specific and use standard genre names)

Respond in a single line with pipe-separated format:
type|genre1,genre2,genre3

Where:
- type is one of: movie, series, ambiguous
- genres are comma-separated without spaces or all if no specific genres are discovered in the query

Examples:
movie|action,thriller,sci-fi
series|comedy,drama
ambiguous|romance,comedy
movie|all
series|all
ambiguous|all

Do not include any explanatory text before or after your response. Just the single line.
`;

  try {
    logger.info("Making genre discovery API call", {
      query,
      provider: aiClient?.provider,
      model: aiClient?.model,
    });

    // Use withRetry for the AI API call
    const text = await withRetry(
      async () => {
        try {
          const responseText = await aiClient.generateText(promptText);
          logger.info("Genre discovery API response", {
            responseTextLength: responseText.length,
            responseTextSample: responseText,
          });
          return responseText;
        } catch (error) {
          logger.error("Genre discovery API call failed", {
            error: error.message,
            status: error.status || error.httpStatus || 500,
            stack: error.stack,
          });
          error.status = error.status || error.httpStatus || 500;
          throw error;
        }
      },
      {
        maxRetries: 3,
        initialDelay: 2000,
        maxDelay: 10000,
        // Don't retry 400 errors (bad requests)
        shouldRetry: (error) => !error.status || error.status !== 400,
        operationName: "AI genre discovery call",
      }
    );

    // Extract the first line in case there's multiple lines
    const firstLine = text.split("\n")[0].trim();

    // Try to parse the pipe-separated format
    try {
      // Split by pipe to get type and genres
      const parts = firstLine.split("|");

      if (parts.length !== 2) {
        logger.error("Invalid format in genre discovery response", {
          text: firstLine,
          parts: parts.length,
        });
        return { type: "ambiguous", genres: [] };
      }

      // Get type and normalize it
      let type = parts[0].trim().toLowerCase();
      if (type !== "movie" && type !== "series") {
        type = "ambiguous";
      }

      // Get genres
      const genres = parts[1]
        .split(",")
        .map((g) => g.trim())
        .filter((g) => g.length > 0 && g.toLowerCase() !== "ambiguous");

      // If the only genre is "all", clear the genres array to use all genres
      if (genres.length === 1 && genres[0].toLowerCase() === "all") {
        logger.info(
          "'All' genres specified, will use all genres for recommendations",
          {
            query,
            type,
          }
        );
        return {
          type: type,
          genres: [],
        };
      }

      logger.info("Successfully parsed genre discovery response", {
        type: type,
        genresCount: genres.length,
        genres: genres,
      });

      return {
        type: type,
        genres: genres,
      };
    } catch (error) {
      logger.error("Failed to parse genre discovery response", {
        error: error.message,
        text: firstLine,
        fullResponse: text,
      });
      return { type: "ambiguous", genres: [] };
    }
  } catch (error) {
    logger.error("Genre discovery API error", {
      error: error.message,
      stack: error.stack,
    });
    return { type: "ambiguous", genres: [] };
  }
}

/**
 * Filters Trakt data based on specified genres
 * @param {Object} traktData - The complete Trakt data
 * @param {string[]} genres - The genres to filter by
 * @returns {Object} - The filtered Trakt data
 */
function filterTraktDataByGenres(traktData, genres) {
  if (!traktData || !genres || genres.length === 0) {
    return {
      recentlyWatched: [],
      highlyRated: [],
      lowRated: [],
    };
  }

  const { watched, rated } = traktData;
  const genreSet = new Set(genres.map((g) => g.toLowerCase()));

  // Helper function to check if an item has any of the specified genres
  const hasMatchingGenre = (item) => {
    const media = item.movie || item.show;
    if (!media || !media.genres || media.genres.length === 0) return false;

    return media.genres.some((g) => genreSet.has(g.toLowerCase()));
  };

  // Filter watched items by genre
  const recentlyWatched = (watched || []).filter(hasMatchingGenre).slice(0, 100);

  // Filter highly rated items (4-5 stars)
  const highlyRated = (rated || [])
    .filter((item) => item.rating >= 4)
    .filter(hasMatchingGenre)
    .slice(0, 100); // Top 100 highly rated

  // Filter low rated items (1-2 stars)
  const lowRated = (rated || [])
    .filter((item) => item.rating <= 2)
    .filter(hasMatchingGenre)
    .slice(0, 100); // Top 100 low rated

  return {
    recentlyWatched,
    highlyRated,
    lowRated,
  };
}

const catalogHandler = async function (args, req) {
  const startTime = Date.now();
  const { id, type, extra } = args;
  let isHomepageQuery = false;

  try {
    const configData = args.config;

    if (!configData || Object.keys(configData).length === 0) {
      logger.error('Configuration Missing', { reason: 'The addon has not been configured yet. Please set your API keys.' });
      const errorMeta = createErrorMeta('Configuration Missing', 'The addon has not been configured yet. Please set your API keys.');
      return { metas: [errorMeta] };
    }

    const tmdbKey = configData.TmdbApiKey;
    const aiProviderConfig = getAiProviderConfigFromConfig(configData);
    const aiApiKey = aiProviderConfig.apiKey;
    let aiClient;

    try {
      aiClient = createAiTextGenerator(aiProviderConfig);
    } catch (error) {
      logger.error("AI provider configuration error", { error: error.message });
      const errorMeta = createErrorMeta(
        "AI Provider Configuration Error",
        "The selected AI provider is misconfigured. Please review your addon settings."
      );
      return { metas: [errorMeta] };
    }

    if (configData.traktConnectionError) {
      logger.error('Trakt Connection Failed', { reason: 'User access to Trakt.tv has expired or was revoked.' });
      const errorMeta = createErrorMeta('Trakt Connection Failed', 'Your access to Trakt.tv has expired or was revoked. Please log in again via the addon configuration page.');
      return { metas: [errorMeta] };
    }
    if (!tmdbKey || tmdbKey.length < 10) {
      logger.error('TMDB API Key Invalid', { reason: 'Your TMDB API key is missing or invalid.' });
      const errorMeta = createErrorMeta('TMDB API Key Invalid', 'Your TMDB API key is missing or invalid. Please correct it in the addon settings.');
      return { metas: [errorMeta] };
    }
    const tmdbValidationUrl = `https://api.themoviedb.org/3/configuration?api_key=${tmdbKey}`;
    const tmdbResponse = await fetch(tmdbValidationUrl);
    if (!tmdbResponse.ok) {
      logger.error('TMDB API Key Validation Failed', { reason: `The key failed validation (Status: ${tmdbResponse.status}).`, keyUsed: tmdbKey.substring(0, 4) + '...' });
      const errorMeta = createErrorMeta('TMDB API Key Invalid', `The key failed validation (Status: ${tmdbResponse.status}). Please check your TMDB key in the addon settings.`);
      return { metas: [errorMeta] };
    }
    if (!aiApiKey || aiApiKey.length < 10) {
      const providerName =
        aiProviderConfig.provider === "openai-compat"
          ? "OpenAI-Compatible"
          : "Gemini";
      logger.error(`${providerName} API Key Invalid`, {
        reason: `Your ${providerName} API key is missing or invalid.`,
      });
      const errorMeta = createErrorMeta(
        `${providerName} API Key Invalid`,
        `Your ${providerName} API key is missing or invalid. Please correct it in the addon settings.`
      );
      return { metas: [errorMeta] };
    }

    let searchQuery = "";
    if (typeof extra === "string" && extra.includes("search=")) {
      searchQuery = decodeURIComponent(extra.split("search=")[1]);
    } else if (extra?.search) {
      searchQuery = extra.search;
    }

    if (!configData || Object.keys(configData).length === 0) {
      logger.error("Missing configuration - Please configure the addon first");
      logger.emptyCatalog("Missing configuration", { type, extra });
      return {
        metas: [],
        error: "Please configure the addon with valid API keys first",
      };
    }

    if (!searchQuery) {
      if (id.startsWith("aisearch.home.")) {
        isHomepageQuery = true;
        let homepageQueries = configData.HomepageQuery;

        if (!homepageQueries || homepageQueries.trim() === '') {
            homepageQueries = "AI Recommendations:recommend a hidden gem movie, AI Recommendations:recommend a binge-worthy series";
        }

        const idParts = id.split(".");
        
        if (idParts.length === 4 && homepageQueries) {
          const queryIndex = parseInt(idParts[2], 10);
          const catalogEntries = homepageQueries.split(",").map(q => q.trim());
          if (!isNaN(queryIndex) && catalogEntries[queryIndex]) {
            const entry = catalogEntries[queryIndex];
            const parts = entry.split(/:(.*)/s);
            if (parts.length > 1 && parts[1].trim()) {
                searchQuery = parts[1].trim();
            } else {
                searchQuery = entry;
            }
            logger.info("Using custom homepage query from list", { type, query: searchQuery, index: queryIndex });
          }
        }

        // If after all that, we still don't have a search query, it's an error.
        if (!searchQuery) {
          logger.error("Failed to resolve homepage query from ID and config", { id });
          const errorMeta = createErrorMeta('Configuration Error', 'Could not find the matching homepage query for this catalog.');
          return { metas: [errorMeta] };
        }
      } else {
        logger.error("No search query provided");
        logger.emptyCatalog("No search query provided", { type, extra });
        const errorMeta = createErrorMeta('Search Required', 'Please enter a search term to get AI recommendations.');
        return { metas: [errorMeta] }
      }
    }

    // Log the Trakt configuration
    logger.info("Trakt configuration", {
      hasTraktClientId: !!DEFAULT_TRAKT_CLIENT_ID,
      traktClientIdLength: DEFAULT_TRAKT_CLIENT_ID?.length || 0,
      hasTraktAccessToken: !!configData.TraktAccessToken,
      traktAccessTokenLength: configData.TraktAccessToken?.length || 0,
    });

    const aiModel = aiProviderConfig.model;
    const language = configData.TmdbLanguage || "en-US";

    if (!aiApiKey || aiApiKey.length < 10) {
      logger.error("Invalid or missing AI provider API key", {
        aiProvider: aiProviderConfig.provider,
      });
      return { metas: [], error: "Invalid AI provider API key. Please reconfigure the addon with a valid key." };
    }

    if (!tmdbKey || tmdbKey.length < 10) {
      logger.error("Invalid or missing TMDB API key");
      return {
        metas: [],
        error:
          "Invalid TMDB API key. Please reconfigure the addon with a valid key.",
      };
    }

    const rpdbKey = configData.RpdbApiKey || DEFAULT_RPDB_KEY;
    const rpdbPosterType = configData.RpdbPosterType || "poster-default";
    let numResults = parseInt(configData.NumResults) || DEFAULT_NUM_RESULTS;
    // Limit numResults to a maximum of 30
    if (numResults > 30) {
      numResults = MAX_AI_RECOMMENDATIONS;
    }
    const enableAiCache =
      configData.EnableAiCache !== undefined ? configData.EnableAiCache : true;
    // NEW: Read the EnableRpdb flag
    const enableRpdb =
      configData.EnableRpdb !== undefined ? configData.EnableRpdb : false;
    const includeAdult = configData.IncludeAdult === true || DEFAULT_INCLUDE_ADULT;

    if (ENABLE_LOGGING) {
      logger.debug("Catalog handler config", {
        numResults,
        rawNumResults: configData.NumResults,
        type,
        aiProvider: aiProviderConfig.provider,
        hasAiKey: !!aiApiKey,
        hasTmdbKey: !!tmdbKey,
        hasRpdbKey: !!rpdbKey,
        isDefaultRpdbKey: rpdbKey === DEFAULT_RPDB_KEY,
        rpdbPosterType: rpdbPosterType,
        enableAiCache: enableAiCache,
        enableRpdb: enableRpdb,
        includeAdult: includeAdult,
        aiModel: aiModel,
        language: language,
        hasTraktClientId: !!DEFAULT_TRAKT_CLIENT_ID,
        hasTraktAccessToken: !!configData.TraktAccessToken,
      });
    }

    if (!aiApiKey || !tmdbKey) {
      logger.error("Missing API keys in catalog handler");
      logger.emptyCatalog("Missing API keys", { type, extra });
      return { metas: [] };
    }

    const platform = detectPlatform(extra);
    logger.debug("Platform detected", { platform, extra });

    // Only increment the counter and log for initial search queries, not for clicks on individual items
    const isSearchRequest =
      (typeof extra === "string" && extra.includes("search=")) ||
      !!extra?.search;
    if (isSearchRequest) {
      logger.query(searchQuery);
      logger.info("Processing search query", { searchQuery, type });
    }

    // First, determine the intent for ALL queries
    const intent = determineIntentFromKeywords(searchQuery);

    // If the intent is specific (not ambiguous) and doesn't match the requested type,
    // return empty results regardless of whether it's a recommendation or search
    if (intent !== "ambiguous" && intent !== type) {
      logger.error("Intent mismatch - returning empty results", {
        intent,
        type,
        searchQuery,
        message: `This ${
          isRecommendationQuery(searchQuery) ? "recommendation" : "search"
        } appears to be for ${intent}, not ${type}`,
      });
      return { metas: [] };
    }

    let exactMatchMeta = null;
    let tmdbInitialResults = [];
    let matchResult = null; 

    if (!isRecommendationQuery(searchQuery)) {
      logger.info("Checking for TMDB exact match and gathering initial results", {
        searchQuery,
        type,
      });
      
      matchResult = await searchTMDBExactMatch(
        searchQuery,
        type,
        tmdbKey,
        language,
        includeAdult
      );

      if (matchResult) {
        tmdbInitialResults = matchResult.results;
        if (matchResult.isExactMatch) {
          const normalizedTitle = searchQuery.toLowerCase().trim();
          const exactMatchData = matchResult.results.find(r => (r.title || r.name || "").toLowerCase().trim() === normalizedTitle);
          if (exactMatchData) {
            const details = await getTmdbDetailsByImdbId(exactMatchData.id, type, tmdbKey);
            if (details && details.imdb_id) {
              const exactMatchItem = {
                id: `exact_${exactMatchData.id}`,
                name: exactMatchData.title || exactMatchData.name,
                year: (exactMatchData.release_date || exactMatchData.first_air_date || 'N/A').substring(0,4),
                type: type,
              };
            exactMatchMeta = await toStremioMeta(
              exactMatchItem,
              platform,
              tmdbKey,
              rpdbKey,
              rpdbPosterType,
              language,
              configData,
              includeAdult
            );
            if (exactMatchMeta) {
              logger.info("TMDB exact match found and converted to meta", {
                searchQuery,
                exactMatchTitle: exactMatchMeta.name,
              });
            }
          }
        }
      }
    }
    logger.info(`Found ${tmdbInitialResults.length} initial TMDB results for context.`, { searchQuery });
  }

    // Now check if it's a recommendation query
    const isRecommendation = isRecommendationQuery(searchQuery);
    let discoveredType = type;
    let discoveredGenres = [];
    let traktData = null;
    let filteredTraktData = null;

    // For recommendation queries, use the new workflow with genre discovery
    if (isRecommendation) {

      // Make the genre discovery API call
      const discoveryResult = await discoverTypeAndGenres(
        searchQuery,
        aiClient
      );
      discoveredGenres = discoveryResult.genres;

      // Log if we couldn't discover any genres for a recommendation query
      if (discoveredGenres.length === 0) {
        if (ENABLE_LOGGING) {
          logger.emptyCatalog("No genres discovered for recommendation query", {
            type,
            searchQuery,
            isRecommendation: true,
          });
        }
      }

      logger.info("Genre discovery results", {
        query: searchQuery,
        discoveredGenres,
        originalType: type,
      });

      // If Trakt is configured, get user data ONLY for recommendation queries
      if (DEFAULT_TRAKT_CLIENT_ID && configData.TraktAccessToken) {
        logger.info("Fetching Trakt data for recommendation query", {
          hasTraktClientId: !!DEFAULT_TRAKT_CLIENT_ID,
          traktClientIdLength: DEFAULT_TRAKT_CLIENT_ID?.length,
          hasTraktAccessToken: !!configData.TraktAccessToken,
          traktAccessTokenLength: configData.TraktAccessToken?.length,
          isRecommendation: isRecommendation,
          query: searchQuery,
        });

        traktData = await fetchTraktWatchedAndRated(
          DEFAULT_TRAKT_CLIENT_ID,
          configData.TraktAccessToken,
          type === "movie" ? "movies" : "shows",
          configData,
          {
            mergeAndDeduplicate,
            processPreferencesInParallel,
          }
        );

        // Filter Trakt data based on discovered genres if we have any
        if (traktData) {
          if (discoveredGenres.length > 0) {
            filteredTraktData = filterTraktDataByGenres(
              traktData,
              discoveredGenres
            );

            logger.info("Filtered Trakt data by genres", {
              genres: discoveredGenres,
              recentlyWatchedCount: filteredTraktData.recentlyWatched.length,
              highlyRatedCount: filteredTraktData.highlyRated.length,
              lowRatedCount: filteredTraktData.lowRated.length,
            });

            // Log if filtering by genres eliminated all Trakt data
            if (
              filteredTraktData.recentlyWatched.length === 0 &&
              filteredTraktData.highlyRated.length === 0 &&
              filteredTraktData.lowRated.length === 0
            ) {
              if (ENABLE_LOGGING) {
                logger.emptyCatalog("No Trakt data matches discovered genres", {
                  type,
                  searchQuery,
                  discoveredGenres,
                  totalWatched: traktData.watched.length,
                  totalRated: traktData.rated.length,
                });
              }
            }
          } else {
            // When no genres are discovered, use all Trakt data
            filteredTraktData = {
              recentlyWatched: traktData.watched?.slice(0, 100) || [],
              highlyRated: (traktData.rated || [])
                .filter((item) => item.rating >= 4)
                .slice(0, 25),
              lowRated: (traktData.rated || [])
                .filter((item) => item.rating <= 2)
                .slice(0, 25),
            };

            logger.info(
              "Using all Trakt data (no specific genres discovered)",
              {
                totalWatched: traktData.watched?.length || 0,
                totalRated: traktData.rated?.length || 0,
                recentlyWatchedCount: filteredTraktData.recentlyWatched.length,
                highlyRatedCount: filteredTraktData.highlyRated.length,
                lowRatedCount: filteredTraktData.lowRated.length,
              }
            );
          }
        }
      }
    }

    const cacheKey = `${searchQuery}_${type}_${
      traktData ? "trakt" : "no_trakt"
    }`;

    // Only check cache if there's no Trakt data or if it's not a recommendation query
    if (
      enableAiCache &&
      !traktData &&
      !isHomepageQuery &&
      aiRecommendationsCache.has(cacheKey)
    ) {
      const cached = aiRecommendationsCache.get(cacheKey);

      logger.info("AI recommendations cache hit", {
        cacheKey,
        query: searchQuery,
        type,
        model: aiModel,
        cachedAt: new Date(cached.timestamp).toISOString(),
        age: `${Math.round((Date.now() - cached.timestamp) / 1000)}s`,
        responseTime: `${Date.now() - startTime}ms`,
        cachedConfigNumResults: cached.configNumResults,
        requestedResults: numResults,
        hasMovies: !!cached.data?.recommendations?.movies?.length,
        hasSeries: !!cached.data?.recommendations?.series?.length,
      });

      if (cached.configNumResults && numResults > cached.configNumResults) {
        logger.info("NumResults increased, invalidating cache", {
          oldValue: cached.configNumResults,
          newValue: numResults,
        });
        aiRecommendationsCache.delete(cacheKey);
      } else if (
        !cached.data?.recommendations ||
        (type === "movie" && !cached.data.recommendations.movies) ||
        (type === "series" && !cached.data.recommendations.series)
      ) {
        logger.error("Invalid cached data structure, forcing refresh", {
          type,
          cachedData: cached.data,
        });
        aiRecommendationsCache.delete(cacheKey);
      } else {
        // Convert cached recommendations to Stremio meta objects
        const selectedRecommendations =
          type === "movie"
            ? cached.data.recommendations.movies || []
            : cached.data.recommendations.series || [];

        logger.debug("Converting cached recommendations to meta objects", {
          recommendationsCount: selectedRecommendations.length,
          type,
        });

        if (selectedRecommendations.length === 0) {
          logger.error("AI returned no valid recommendations", { 
            query: searchQuery, 
            type: type,
            model: aiModel,
            responseText: text
          });
          const errorMeta = createErrorMeta('No Results Found', 'The AI could not find any recommendations for your query. Please try rephrasing your search.');
          return { metas: [errorMeta] };
        }

        const metaPromises = selectedRecommendations.map((item) =>
          toStremioMeta(
            item,
            platform,
            tmdbKey,
            rpdbKey,
            rpdbPosterType,
            language,
            configData,
            includeAdult
          )
        );

        const metas = (await Promise.all(metaPromises)).filter(Boolean);

        if (metas.length === 0 && !exactMatchMeta) {
          logger.error("All AI recommendations failed TMDB lookup", {
            query: searchQuery,
            type: type,
            recommendationCount: selectedRecommendations.length
          });
          const errorMeta = createErrorMeta('Data Fetch Error', 'Could not retrieve details for any of the AI recommendations. This may be a temporary TMDB issue.');
          return { metas: [errorMeta] };
        }

        logger.debug("Catalog handler response from cache", {
          metasCount: metas.length,
          firstMeta: metas[0],
        });

        let finalMetas = metas;
        if (exactMatchMeta) {
          finalMetas = [
            exactMatchMeta,
            ...metas.filter((meta) => meta.id !== exactMatchMeta.id),
          ];
          logger.info("Added exact match as first result (from cache)", {
            searchQuery,
            exactMatchTitle: exactMatchMeta.name,
            totalResults: finalMetas.length,
            exactMatchId: exactMatchMeta.id,
          });
        }

        if (finalMetas.length === 0) {
            logger.error("No results found for query (from cache)", { query: searchQuery, type: type });
            const errorMeta = createErrorMeta('No Results Found', 'The AI could not find any recommendations for your query. Please try rephrasing your search.');
            return { metas: [errorMeta] };
        }

        // Increment counter for successful cached results
        if (finalMetas.length > 0 && isSearchRequest) {
          incrementQueryCounter();
          logger.info(
            "Query counter incremented for successful cached search",
            {
              searchQuery,
              resultCount: finalMetas.length,
            }
          );
        }

        return { metas: finalMetas };
      }
    }

    if (!enableAiCache) {
      logger.info("AI cache bypassed (disabled in config)", {
        cacheKey,
        query: searchQuery,
        type,
      });
    } else if (traktData) {
      logger.info("AI cache bypassed (using Trakt personalization)", {
        cacheKey,
        query: searchQuery,
        type,
        hasTraktData: true,
      });
    } else {
      logger.info("AI recommendations cache miss", {
        cacheKey,
        query: searchQuery,
        type,
      });
    }

    try {
      const genreCriteria = extractGenreCriteria(searchQuery);
      const currentYear = new Date().getFullYear();

      let franchiseInstruction = `your TOP PRIORITY is to list ALL official mainline movies from that franchise, followed by any relevant spin-offs or related content.`;

      if (type === 'series') {
        franchiseInstruction = `your TOP PRIORITY is to provide a **comprehensive list** of ALL television content related to that franchise. Your search MUST include, but is not limited to:
        - Official narrative series and mini-series (both live-action and animated).
        - Documentary series (e.g., 'making of' or historical series like 'Icons Unearthed').
        - Competition or reality shows (e.g., 'Hogwarts Tournament of Houses', 'Wizards of Baking').
        - Any related TV specials or one-off televised events.`;
      }

      let promptText = [
        `You are a ${type} recommendation expert. Analyze this query: "${searchQuery}"`,
        "",
        "QUERY ANALYSIS:",
      ];

      // Add query analysis section
      if (isRecommendation && discoveredGenres.length > 0) {
        promptText.push(`Discovered genres: ${discoveredGenres.join(", ")}`);
      } else if (genreCriteria?.include?.length > 0) {
        promptText.push(
          `Requested genres: ${genreCriteria.include.join(", ")}`
        );
      }
      if (genreCriteria?.mood?.length > 0) {
        promptText.push(`Mood/Style: ${genreCriteria.mood.join(", ")}`);
      }
      promptText.push("");

      if (traktData) {
        const { preferences } = traktData;

        // For recommendation queries, use the filtered Trakt data if available,
        // otherwise use all Trakt data when no specific genres are discovered
        if (isRecommendation) {
          // If we have filtered Trakt data (specific genres), use it
          // Otherwise, use all Trakt data (when no specific genres are discovered)
          const { recentlyWatched, highlyRated, lowRated } =
            filteredTraktData || {
              recentlyWatched: traktData.watched?.slice(0, 100) || [],
              highlyRated: (traktData.rated || [])
                .filter((item) => item.rating >= 4)
                .slice(0, 25),
              lowRated: (traktData.rated || [])
                .filter((item) => item.rating <= 2)
                .slice(0, 25),
            };

          // Calculate genre overlap if we have discovered genres
          let genreRecommendationStrategy = "";
          if (discoveredGenres.length > 0) {
            const queryGenres = new Set(
              discoveredGenres.map((g) => g.toLowerCase())
            );
            const userGenres = new Set(
              preferences.genres.map((g) => g.genre.toLowerCase())
            );
            const overlap = [...queryGenres].filter((g) => userGenres.has(g));

            // Check if user has watched many movies in the requested genres
            const genreWatchCount = recentlyWatched.filter((item) => {
              const media = item.movie || item.show;
              return (
                media.genres &&
                media.genres.some((g) => queryGenres.has(g.toLowerCase()))
              );
            }).length;

            const hasWatchedManyInGenre = genreWatchCount > 10;

            if (overlap.length > 0) {
              if (hasWatchedManyInGenre) {
                genreRecommendationStrategy =
                  "The user has watched many movies in the requested genres and these genres match their preferences. " +
                  "Focus on finding less obvious, unique, or newer titles in these genres that they might have missed. " +
                  "Consider acclaimed international films, indie gems, or cult classics that fit the genre requirements.";
              } else {
                genreRecommendationStrategy =
                  "Since the requested genres match some of the user's preferred genres, " +
                  "prioritize recommendations that combine these interests while maintaining the specific genre requirements.";
              }
            } else {
              genreRecommendationStrategy =
                "Although the requested genres differ from the user's usual preferences, " +
                "try to find high-quality recommendations that might bridge their interests with the requested genres.";
            }
          }

          promptText.push(
            "USER'S WATCH HISTORY AND PREFERENCES (FILTERED BY RELEVANT GENRES):",
            ""
          );

          if (recentlyWatched.length > 0) {
            promptText.push(
              "Recently watched in these genres:",
              recentlyWatched
                .slice(0, 25)
                .map((item) => {
                  const media = item.movie || item.show;
                  return `- ${media.title} (${media.year}) - ${
                    media.genres?.join(", ") || "N/A"
                  }`;
                })
                .join("\n")
            );
            promptText.push("");
          }

          if (highlyRated.length > 0) {
            promptText.push(
              "Highly rated (4-5 stars) in these genres:",
              highlyRated
                .slice(0, 25)
                .map((item) => {
                  const media = item.movie || item.show;
                  return `- ${media.title} (${item.rating}/5) - ${
                    media.genres?.join(", ") || "N/A"
                  }`;
                })
                .join("\n")
            );
            promptText.push("");
          }

          if (lowRated.length > 0) {
            promptText.push(
              "Low rated (1-2 stars) in these genres:",
              lowRated
                .slice(0, 15)
                .map((item) => {
                  const media = item.movie || item.show;
                  return `- ${media.title} (${item.rating}/5) - ${
                    media.genres?.join(", ") || "N/A"
                  }`;
                })
                .join("\n")
            );
            promptText.push("");
          }

          // Only include top genres if the user isn't already searching for specific genres
          if (discoveredGenres.length === 0) {
            promptText.push(
              "Top genres:",
              preferences.genres
                .map((g) => `- ${g.genre} (Score: ${g.count.toFixed(2)})`)
                .join("\n"),
              ""
            );
          }

          promptText.push(
            "Favorite actors:",
            preferences.actors
              .map((a) => `- ${a.actor} (Score: ${a.count.toFixed(2)})`)
              .join("\n"),
            "",
            "Preferred directors:",
            preferences.directors
              .map((d) => `- ${d.director} (Score: ${d.count.toFixed(2)})`)
              .join("\n"),
            "",
            preferences.yearRange
              ? `User tends to watch content from ${preferences.yearRange.start} to ${preferences.yearRange.end}, with a preference for ${preferences.yearRange.preferred}`
              : "",
            "",
            "RECOMMENDATION STRATEGY:",
            genreRecommendationStrategy ||
              "Balance user preferences with query requirements",
            "1. Focus on the specific requirements from the query (genres, time period, mood)",
            "2. Use user's preferences to refine choices within those requirements",
            "3. Consider their rating patterns to gauge quality preferences",
            "4. Prioritize content with preferred actors/directors when relevant",
            "5. Include some variety while staying within the requested criteria",
            "6. For genre-specific queries, prioritize acclaimed or popular content in that genre that the user hasn't seen",
            "7. Include a mix of well-known classics and hidden gems in the requested genre",
            "8. If the user has watched many content in the requested genre, look for similar but less obvious choices",
            ""
          );
        }
      }

      if (tmdbInitialResults.length > 0) {
        const initialTitles = tmdbInitialResults
          .slice(0, 15)
          .map(item => `- ${item.title || item.name} (${(item.release_date || item.first_air_date || 'N/A').substring(0, 4)})`)
          .join('\n');

        promptText.push(
          "CONTEXT FROM INITIAL DATABASE SEARCH:",
          "The following is a list of relevant titles found in an initial database search. Your main task is use this as the primary data source, add any official entries that might be missing, add similar titles, sort them by relevance and return the comprehensive list.",
          "",
          "Found Titles:",
          initialTitles,
          "",
          "If you are unable to collate ", numResults, " ", type, " recommendations", " add the missing ones from the initial database search results to the end of your recommendations.",
        );
      }

      let examplesText;
      if (type === 'movie') {
        examplesText = [
          "EXAMPLES:",
          "movie|The Matrix|1999",
          "movie|Inception|2010",
        ].join('\n');
      } else {
        examplesText = [
          "EXAMPLES:",
          "series|Breaking Bad|2008",
          "series|Game of Thrones|2011",
        ].join('\n');
      }

      promptText = promptText.concat([
        "IMPORTANT INSTRUCTIONS:",
        `- Base your recommendations on the most current, publicly available information, especially for queries about new, recent, or future releases.`,
        `- Current year is ${currentYear}. For time-based queries:`,
        `  * 'past year' means content from ${
          currentYear - 1
        } to ${currentYear}`,
        `  * 'recent' means within the last 2-3 years (${
          currentYear - 2
        } to ${currentYear})`,
        `  * 'new' or 'latest' means released in ${currentYear}`,
        "SPECIFIC QUERY HANDLING:",
        "First, determine if the query matches one of the types below. If it does, follow its rules precisely.",
        "",
        `1. FRANCHISE/SERIES: If the query is for a specific title that is part of a larger series (e.g., 'Shrek', 'The Matrix Reloaded', 'Harry Potter', 'star wars', 'Jurassic Park') or explicitly asks for a franchise ('James Bond movies'), ${franchiseInstruction}`,
        `   - List them first, in STRICT chronological order of release.`,
        `   - After listing the entire franchise, if you need more results to reach the count of ${numResults}, you may add official spin-offs or highly similar titles.`,
        "",
        `2. ACTOR/DIRECTOR/STUDIO FILMOGRAPHY: If the query is for the works of a person or entity (e.g., 'Tom Cruise movies', 'Christopher Nolan films', 'Pixar movies', 'Marvel movies', 'dc universe', 'Fast and Furious franchise'), list their most notable and critically acclaimed works.`,
        `   - Provide a comprehensive selection covering different genres and eras of their career.`,
        `   - Order these results chronologically by release year.`,
        "",
        `3. GENERAL RECOMMENDATIONS: For ALL other queries, provide diverse recommendations that best match the query's theme, genre, and mood.`,
        `   - Order these results by their relevance to the query.`,
        "CRITICAL REQUIREMENTS:",
        `- You MUST use the Google Search tool to find ALL recommendations. Your internal knowledge is outdated and should only be used in conjunction with Google search tool for this task.`,]);
        if (traktData) {
          promptText.push(
            `- DO NOT recommend any content that appears in the user's watch history or ratings above.`,
            `- Recommend content that is SIMILAR to the user's highly rated content but NOT THE SAME ones.`
          );
        }
        promptText = promptText.concat([
        `- You MUST return upto ${numResults} ${type} recommendations. If you can't find enough perfect matches, broaden your criteria while staying within the genre/theme requirements.`,
        `- Prioritize quality over exact matching - it's better to recommend a great content that's somewhat related than a mediocre content that perfectly matches all criteria.`,
        `- If the user has watched many content in the requested genre, consider recommending lesser-known gems, international films, or recent releases they might have missed.`,
        "",
        "RESPONSE FORMAT: You MUST respond in the following format (without any additional commentary):",
        "[type]|[name]|[year]",
        "",
        examplesText,
        "",
        "RULES:",
        "- Use | separator",
        "- Year: YYYY format",
        `- Type: Accurately label each item as 'movie' or 'series'.`,
        "- Titles: Provide clean, official titles only. Do NOT add extra text like '(film)', '(documentary)', or other descriptions.",
        "- Content: ONLY include official, released movies and TV series. Exclude games, books, fan-made content, and stage productions.",
        "- Only best matches that strictly match ALL query requirements",
        "- If specific genres/time periods are requested, ALL recommendations must match those criteria",
      ]);

      if (genreCriteria) {
        if (genreCriteria.include.length > 0) {
          promptText.push(
            `- Must match genres: ${genreCriteria.include.join(", ")}`
          );
        }
        if (genreCriteria.exclude.length > 0) {
          promptText.push(
            `- Exclude genres: ${genreCriteria.exclude.join(", ")}`
          );
        }
        if (genreCriteria.mood.length > 0) {
          promptText.push(
            `- Match mood/style: ${genreCriteria.mood.join(", ")}`
          );
        }
      }

      // Optional MCP augmentation (server-side only)
      try {
        const mcpContext = await getMcpContext({
          query: searchQuery,
          type,
        });
        if (mcpContext) {
          promptText.push(
            "",
            "MCP CONTEXT (JSON):",
            mcpContext,
            ""
          );
        }
      } catch (error) {
        logger.warn("Failed to fetch MCP context", { error: error.message });
      }

      promptText = promptText.join("\n");

      logger.info("Making AI API call", {
        provider: aiClient.provider,
        model: aiModel,
        query: searchQuery,
        type,
        prompt: promptText,
        genreCriteria,
        numResults,
      });

      // Use withRetry for the AI API call
      const text = await withRetry(
        async () => {
          try {
            const responseText = await aiClient.generateText(promptText);
            logger.info("AI API response", {
              duration: `${Date.now() - startTime}ms`,
              responseTextLength: responseText.length,
              responseTextSample:
                responseText.substring(0, 100) +
                (responseText.length > 100 ? "..." : ""),
            });

            return responseText;
          } catch (error) {
            logger.error("AI API call failed", {
              error: error.message,
              status: error.status || error.httpStatus || 500,
              stack: error.stack,
            });
            error.status = error.status || error.httpStatus || 500;
            throw error;
          }
        },
        {
          maxRetries: 3,
          initialDelay: 2000,
          maxDelay: 10000,
          // Don't retry 400 errors (bad requests)
          shouldRetry: (error) => !error.status || error.status !== 400,
          operationName: "AI API call",
        }
      );

      // Process the response text
      const lines = text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("type|"));

      logger.debug("Parsed recommendation lines", {
        totalLines: text.split("\n").length,
        validLines: lines.length,
      });

      const recommendations = {
        movies: type === "movie" ? [] : undefined,
        series: type === "series" ? [] : undefined,
      };

      let validRecommendations = 0;
      let invalidLines = 0;

      for (const line of lines) {
        try {
          const parts = line.split("|");

          let lineType, name, year;

          if (parts.length === 3) {
            [lineType, name, year] = parts.map((s) => s.trim());
          } else if (parts.length === 2) {
            lineType = parts[0].trim();
            const nameWithYear = parts[1].trim();

            const yearMatch = nameWithYear.match(/\((\d{4})\)$/);
            if (yearMatch) {
              year = yearMatch[1];
              name = nameWithYear
                .substring(0, nameWithYear.lastIndexOf("("))
                .trim();
            } else {
              const anyYearMatch = nameWithYear.match(/\b(19\d{2}|20\d{2})\b/);
              if (anyYearMatch) {
                year = anyYearMatch[0];
                name = nameWithYear.replace(anyYearMatch[0], "").trim();
              } else {
                logger.debug("Missing year in recommendation", {
                  nameWithYear,
                });
                invalidLines++;
                continue;
              }
            }
          } else {
            logger.debug("Invalid recommendation format", { line });
            invalidLines++;
            continue;
          }

          const yearNum = parseInt(year);

          if (!lineType || !name || isNaN(yearNum)) {
            logger.debug("Invalid recommendation data", {
              lineType,
              name,
              year,
              isValidYear: !isNaN(yearNum),
            });
            invalidLines++;
            continue;
          }

          if (lineType === type && name && yearNum) {
            const item = {
              name,
              year: yearNum,
              type,
              id: `ai_${type}_${name
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "_")}`,
            };

            if (type === "movie") recommendations.movies.push(item);
            else if (type === "series") recommendations.series.push(item);

            validRecommendations++;
          }
        } catch (error) {
          logger.error("Error processing recommendation line", {
            line,
            error: error.message,
          });
          invalidLines++;
        }
      }

      logger.info("Recommendation processing complete", {
        validRecommendations,
        invalidLines,
        totalProcessed: lines.length,
      });

      const finalResult = {
        recommendations,
        fromCache: false,
      };

      // Filter out watched items if we have Trakt data and this is a recommendation query
      if (traktData && isRecommendation) {
        const watchHistory = traktData.watched.concat(traktData.history || []);

        // Log a summary of the user's watched and rated items for validation
        const watchedSummary = watchHistory.slice(0, 20).map((item) => {
          const media = item.movie || item.show;
          return {
            title: media.title,
            year: media.year,
            type: item.movie ? "movie" : "show",
          };
        });

        const ratedSummary = traktData.rated.slice(0, 20).map((item) => {
          const media = item.movie || item.show;
          return {
            title: media.title,
            year: media.year,
            rating: item.rating,
            type: item.movie ? "movie" : "show",
          };
        });

        logger.info("User's watch history and ratings (for validation)", {
          totalWatched: watchHistory.length,
          totalRated: traktData.rated.length,
          watchedSample: watchedSummary,
          ratedSample: ratedSummary,
        });

        // Filter out watched and rated items from recommendations
        if (finalResult.recommendations.movies) {
          // Get the list of movies before filtering
          const allMovies = [...finalResult.recommendations.movies];

          const unwatchedMovies = finalResult.recommendations.movies.filter(
            (movie) =>
              !isItemWatchedOrRated(movie, watchHistory, traktData.rated)
          );

          // Find which movies were filtered out
          const filteredMovies = allMovies.filter(
            (movie) =>
              !unwatchedMovies.some(
                (unwatched) =>
                  unwatched.name === movie.name && unwatched.year === movie.year
              )
          );

          logger.info(
            "Filtered out watched and rated movies from recommendations",
            {
              totalRecommendations: finalResult.recommendations.movies.length,
              unwatchedCount: unwatchedMovies.length,
              filteredCount:
                finalResult.recommendations.movies.length -
                unwatchedMovies.length,
              filteredMovies: filteredMovies.map((movie) => ({
                title: movie.name,
                year: movie.year,
              })),
            }
          );

          finalResult.recommendations.movies = unwatchedMovies;
        }

        if (finalResult.recommendations.series) {
          // Get the list of series before filtering
          const allSeries = [...finalResult.recommendations.series];

          const unwatchedSeries = finalResult.recommendations.series.filter(
            (series) =>
              !isItemWatchedOrRated(series, watchHistory, traktData.rated)
          );

          // Find which series were filtered out
          const filteredSeries = allSeries.filter(
            (series) =>
              !unwatchedSeries.some(
                (unwatched) =>
                  unwatched.name === series.name &&
                  unwatched.year === series.year
              )
          );

          logger.info(
            "Filtered out watched and rated series from recommendations",
            {
              totalRecommendations: finalResult.recommendations.series.length,
              unwatchedCount: unwatchedSeries.length,
              filteredCount:
                finalResult.recommendations.series.length -
                unwatchedSeries.length,
              filteredSeries: filteredSeries.map((series) => ({
                title: series.name,
                year: series.year,
              })),
            }
          );

          finalResult.recommendations.series = unwatchedSeries;
        }
      }

      const recommendationsToCache = finalResult.recommendations;
      const hasMoviesToCache = recommendationsToCache.movies && recommendationsToCache.movies.length > 0;
      const hasSeriesToCache = recommendationsToCache.series && recommendationsToCache.series.length > 0;

      // Only cache if there's no Trakt data (not user-specific) and it's not a homepage query
      if ((hasMoviesToCache || hasSeriesToCache) && !traktData && !isHomepageQuery && enableAiCache) {
        aiRecommendationsCache.set(cacheKey, {
          timestamp: Date.now(),
          data: finalResult,
          configNumResults: numResults,
        });

        logger.debug("AI recommendations result cached", {
          cacheKey,
          duration: Date.now() - startTime,
          query: searchQuery,
          type,
          numResults,
        });
      } else {
        // Log the reason for not caching
        let reason = "";
        if (!(hasMoviesToCache || hasSeriesToCache)) {
          reason = "Result was empty";
        } else if (isHomepageQuery) {
          reason = "Dynamic homepage query";
        } else if (traktData) {
          reason = "User-specific Trakt data";
        } else if (!enableAiCache) {
          reason = "AI cache disabled in config";
        }
        logger.debug("AI recommendations not cached", {
          reason,
          duration: Date.now() - startTime,
          query: searchQuery,
          type,
        });
      }

      // Convert recommendations to Stremio meta objects
      const selectedRecommendations =
        type === "movie"
          ? finalResult.recommendations.movies || []
          : finalResult.recommendations.series || [];

      logger.debug("Converting recommendations to meta objects", {
        recommendationsCount: selectedRecommendations.length,
        type,
        originalQuery: searchQuery,
        recommendations: selectedRecommendations.map((r) => ({
          name: r.name,
          year: r.year,
          type: r.type,
          id: r.id,
        })),
      });

      const metaPromises = selectedRecommendations.map((item) =>
        toStremioMeta(
          item,
          platform,
          tmdbKey,
          rpdbKey,
          rpdbPosterType,
          language,
          configData // Pass the whole config down
        )
      );

      const metas = (await Promise.all(metaPromises)).filter(Boolean);

      // Log detailed results
      logger.debug("Meta conversion results", {
        originalQuery: searchQuery,
        type,
        totalRecommendations: selectedRecommendations.length,
        successfulConversions: metas.length,
        failedConversions: selectedRecommendations.length - metas.length,
        recommendations: selectedRecommendations.map((r) => ({
          name: r.name,
          year: r.year,
          type: r.type,
        })),
        convertedMetas: metas.map((m) => ({
          id: m.id,
          name: m.name,
          year: m.year,
          type: m.type,
        })),
      });

      logger.debug("Catalog handler response", {
        metasCount: metas.length,
        firstMeta: metas[0],
        originalQuery: searchQuery,
        type,
        platform,
      });

      let finalMetas = metas;
      if (exactMatchMeta) {
        finalMetas = [
          exactMatchMeta,
          ...metas.filter((meta) => meta.id !== exactMatchMeta.id),
        ];
        logger.info("Added exact match as first result", {
          searchQuery,
          exactMatchTitle: exactMatchMeta.name,
          totalResults: finalMetas.length,
          exactMatchId: exactMatchMeta.id,
        });
      }

      if (finalMetas.length === 0) {
          logger.error("No results found for query (from live API call)", { query: searchQuery, type: type });
          const errorMeta = createErrorMeta('No Results Found', 'The AI could not find any recommendations for your query. Please try rephrasing your search.');
          return { metas: [errorMeta] };
      }

      // Only increment the counter if we're returning non-empty results
      if (finalMetas.length > 0 && isSearchRequest) {
        incrementQueryCounter();
        logger.info("Query counter incremented for successful search", {
          searchQuery,
          resultCount: finalMetas.length,
        });
      }

      return { metas: finalMetas };
    } catch (error) {
      logger.error("AI API Error:", {
        error: error.message,
        status: error.status || error.httpStatus,
        stack: error.stack,
        query: searchQuery,
        aiProvider: aiProviderConfig?.provider,
      });
      let errorMessage = 'The AI model failed to respond. This may be a temporary issue.';

      const status = error.status || error.httpStatus;
      const provider = aiProviderConfig?.provider;

      const isAuthError =
        status === 401 ||
        status === 403 ||
        (typeof error.message === "string" &&
          /api key|unauthorized|forbidden/i.test(error.message));
      const isRateLimit =
        status === 429 ||
        (typeof error.message === "string" && /quota|rate limit/i.test(error.message));
      const isTimeout =
        status === 504 ||
        (typeof error.message === "string" && /timed out|timeout/i.test(error.message));
      const isNetworkError =
        typeof error.message === "string" &&
        /(enotfound|econnrefused|econnreset|network error|fetch failed)/i.test(
          error.message
        );
      const isServerError = status >= 500 && status < 600;
      const isNotFound =
        status === 404 || (typeof error.message === "string" && /not found/i.test(error.message));

      if (isAuthError) {
        errorMessage =
          provider === "openai-compat"
            ? "Your OpenAI-compatible API key is invalid or has been revoked. Please update it in the settings."
            : "Your Gemini API key is invalid or has been revoked. Please update it in the settings.";
      } else if (isRateLimit) {
        errorMessage =
          provider === "openai-compat"
            ? "You have exceeded your OpenAI-compatible provider quota/rate limit. Please check your provider account."
            : "You have exceeded your Gemini API quota for the day. Please check your Google AI Studio account.";
      } else if (isTimeout) {
        errorMessage =
          "The AI provider timed out while responding. Please try again in a moment.";
      } else if (isNetworkError) {
        errorMessage =
          "Could not reach the AI provider. Please check your server network and provider base URL.";
      } else if (isServerError) {
        errorMessage =
          "The AI provider encountered a server error. Please try again later.";
      } else if (isNotFound) {
        errorMessage =
          provider === "openai-compat"
            ? "The selected model was not found. Please try a different model name in the settings."
            : "The selected Gemini Model is invalid or not found. Please try a different model in the settings.";
      }
      const errorMeta = createErrorMeta('AI Error', errorMessage);
      return { metas: [errorMeta] };
    }
  } catch (error) {
    logger.error("Catalog processing error", { error: error.message, stack: error.stack });
    const errorMeta = createErrorMeta('Addon Error', 'A critical error occurred. Please check the server logs for more details.');
    return { metas: [errorMeta] };
  }
};

const streamHandler = async (args, req) => {

  const { config } = args;
  if (config) {
    try {
      const decryptedConfigStr = decryptConfig(config);
      if (decryptedConfigStr) {
        const configData = JSON.parse(decryptedConfigStr);
        const enableSimilar =
          configData.EnableSimilar !== undefined
            ? configData.EnableSimilar
            : DEFAULT_ENABLE_SIMILAR;
        if (!enableSimilar) {
          logger.info("'Similar' recommendations are disabled by user configuration.", { id: args.id });
          return Promise.resolve({ streams: [] });
        }
      }
    } catch (error) {
        logger.error("Failed to read 'EnableSimilar' config in streamHandler, defaulting to enabled.", { error: error.message });
    }
  }

  logger.info("Stream request received, creating AI Recommendations link.", { id: args.id, type: args.type });
  const isWeb = req.headers["origin"]?.includes("web.stremio.com");
  const stremioUrlPrefix = isWeb ? "https://web.stremio.com/#" : "stremio://";

  const stream = {
    name: "✨ AI Search",
    description: "Similar movies and shows.",
    externalUrl: `${stremioUrlPrefix}/detail/${args.type}/ai-recs:${args.id}`,
    behaviorHints: {
      notWebReady: true,
    },
  };

  return Promise.resolve({ streams: [stream] });
};

const metaHandler = async function (args) {
  const { type, id, config } = args;
  const startTime = Date.now();
  const stremioUrlPrefix = "stremio://";

  try {
    if (!id || !id.startsWith('ai-recs:')) {
      return { meta: null };
    }
    if (config) {
      const decryptedConfigStr = decryptConfig(config);
      if (!decryptedConfigStr) {
        throw new Error("Failed to decrypt config data in metaHandler");
      }
      const configData = JSON.parse(decryptedConfigStr);
      const { TmdbApiKey, NumResults, FanartApiKey } = configData;
      const aiProviderConfig = getAiProviderConfigFromConfig(configData);
      const aiClient = createAiTextGenerator(aiProviderConfig);

      const originalId = id.split(':')[1];
      
      // Check similar content cache first
      const cacheKey = `similar_${originalId}_${type}_${NumResults || DEFAULT_SIMILAR_NUM_RESULTS}`;
      const cached = similarContentCache.get(cacheKey);
      if (cached) {
        logger.debug("Similar content cache hit", { 
          originalId, 
          type, 
          cacheKey,
          cachedAt: new Date(cached.timestamp).toISOString(),
          age: `${Math.round((Date.now() - cached.timestamp) / 1000)}s`
        });
        return { meta: cached.data };
      }
      
      logger.debug("Similar content cache miss", { originalId, type, cacheKey });
      let sourceDetails = await getTmdbDetailsByImdbId(originalId, type, TmdbApiKey);
      
      if (!sourceDetails) {
        const fallbackType = type === 'movie' ? 'series' : 'movie';
        sourceDetails = await getTmdbDetailsByImdbId(originalId, fallbackType, TmdbApiKey);
      }

      if (!sourceDetails) {
        throw new Error(`Could not find source details for original ID: ${originalId}`);
      }

      const sourceTitle = sourceDetails.title || sourceDetails.name;
      const sourceYear = (sourceDetails.release_date || sourceDetails.first_air_date || "").substring(0, 4);
      let numResults = parseInt(NumResults) || DEFAULT_SIMILAR_NUM_RESULTS;
      if (numResults > 25) numResults = 25;

      const promptText = `
      You are an expert recommendation engine for movies and TV shows.
      Your task is to generate a list of exactly ${numResults} recommendations that are highly similar to "${sourceTitle} (${sourceYear})".

      Your final list must be constructed in two parts:

      **PART 1: FRANCHISE ENTRIES**
      First, list all other official movies/series from the same franchise as "${sourceTitle}". This is your highest priority.
      *   This part of the list **MUST be sorted chronologically by release year**.

      **PART 2: SIMILAR RECOMMENDATIONS**
      After the franchise entries (if any), fill the remaining slots to reach ${numResults} total recommendations with unrelated titles that are highly similar in mood, theme, and genre.
      *   This part of the list **MUST be sorted by relevance to "${sourceTitle}", with the most similar item first**.

      **CRITICAL RULES:**
      1.  **Exclusion:** You **MUST NOT** include the original item, "${sourceTitle} (${sourceYear})", in your list.
      2.  **Final Output:** Provide **ONLY** the combined list of recommendations. Do not include any headers (like "PART 1"), introductory text, or explanations.

      **Format:**
      Your response must be a list of pipe-separated values, with each entry on a new line:
      type|name|year

      **Example (if the source was 'The Dark Knight' and numResults was 5):**
      movie|Batman Begins|2005
      movie|The Dark Knight Rises|2012
      movie|The Town|2010
      movie|Zodiac|2007
      movie|Prisoners|2013
      `;
      
      const responseText = await withRetry(
        async () => {
          try {
            return await aiClient.generateText(promptText);
          } catch (error) {
            error.status = error.status || error.httpStatus || 500;
            throw error;
          }
        },
        {
          maxRetries: 3,
          initialDelay: 1000,
          shouldRetry: (error) => !error.status || error.status !== 400,
          operationName: "AI API call (similar content)"
        }
      );
      
      const lines = responseText.split('\n').map(line => line.trim()).filter(Boolean);

      const videoPromises = lines.map(async (line) => {
        const parts = line.split('|');
        if (parts.length !== 3) return null;
        const [recType, name, year] = parts.map(p => p.trim());
        const tmdbData = await searchTMDB(name, recType, year, TmdbApiKey);
        if (tmdbData && tmdbData.imdb_id) {
          
          let description = tmdbData.overview || "";

          if (tmdbData.tmdbRating && tmdbData.tmdbRating > 0) {
            const ratingText = `⭐ TMDB Rating: ${tmdbData.tmdbRating.toFixed(1)}/10`;
            description = `${ratingText}\n\n${description}`;
          }

          // Get landscape thumbnail instead of portrait poster
          const landscapeThumbnail = await getLandscapeThumbnail(
            tmdbData,
            tmdbData.imdb_id,
            FanartApiKey
          );

          return {
            id: tmdbData.imdb_id,
            title: tmdbData.title,
            released: new Date(tmdbData.release_date || '1970-01-01').toISOString(),
            overview: description,
            thumbnail: landscapeThumbnail
          };
        }
        return null;
      });

      const videos = (await Promise.all(videoPromises)).filter(Boolean);

      const meta = {
        id: id,
        type: 'series',
        name: `AI: Recommendations for ${sourceTitle}`,
        description: `A collection of titles similar to ${sourceTitle} (${sourceYear}), generated by AI.`,
        poster: sourceDetails.poster_path ? `https://image.tmdb.org/t/p/w500${sourceDetails.poster_path}` : null,
        background: sourceDetails.backdrop_path ? `https://image.tmdb.org/t/p/original${sourceDetails.backdrop_path}` : null,
        videos: videos,
      };

      // Only cache if we have valid recommendations
      if (videos.length > 0) {
        similarContentCache.set(cacheKey, {
          timestamp: Date.now(),
          data: meta
        });

        logger.info(`Successfully generated ${videos.length} recommendations.`, { 
          source: sourceTitle, 
          duration: Date.now() - startTime,
          cached: true
        });
      } else {
        logger.warn(`No valid recommendations generated for similar content`, { 
          source: sourceTitle, 
          duration: Date.now() - startTime,
          cached: false
        });
      }
      return { meta };
    }
  } catch (error) {
    logger.error("Meta Handler Error:", { message: error.message, stack: error.stack, id: id });
  }

  return { meta: null };
};

builder.defineCatalogHandler(catalogHandler);

builder.defineStreamHandler(streamHandler);

builder.defineMetaHandler(metaHandler);

const addonInterface = builder.getInterface();

module.exports = {
  builder,
  addonInterface,
  catalogHandler,
  streamHandler,
  metaHandler,
  clearTmdbCache,
  clearTmdbDetailsCache,
  clearTmdbDiscoverCache,
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
  discoverTypeAndGenres,
  filterTraktDataByGenres,
  incrementQueryCounter,
  getQueryCount,
  setQueryCount,
  removeTmdbDiscoverCacheItem,
  listTmdbDiscoverCacheKeys,
  getRpdbTierFromApiKey,
  searchTMDBExactMatch,
  determineIntentFromKeywords,
};
