const logger = require("./logger");

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
    crime: /\b(crime|criminal|detective)\b/i,
    mystery: /\b(mystery|mysterious|detective|whodunit)\b/i,
    war: /\b(war|military|combat)\b/i,
    western: /\b(western|cowboy)\b/i,
    family: /\b(family|kid|kids|children)\b/i,
    history: /\b(history|historical|period)\b/i,
    music: /\b(music|musical|concert)\b/i,
    adventure: /\b(adventure|journey|quest)\b/i,
    superhero: /\b(superhero|super hero|super-hero|marvel|dc)\b/i,
    biography: /\b(biography|biopic|based on true story)\b/i,
  };

  const criteria = {
    genres: [],
    mood: [],
    era: null,
  };

  Object.entries(basicGenres).forEach(([genre, regex]) => {
    if (regex.test(q)) {
      criteria.genres.push(genre);
    }
  });

  if (/\b(dark|gritty|serious|intense|disturbing|violent|brutal)\b/i.test(q)) {
    criteria.mood.push("dark");
  }
  if (/\b(light|uplifting|feel[-\s]?good|heartwarming|sweet)\b/i.test(q)) {
    criteria.mood.push("uplifting");
  }
  if (/\b(funny|hilarious|comedic|comedy|laugh)\b/i.test(q)) {
    criteria.mood.push("funny");
  }
  if (/\b(epic|grand|sweeping|large[-\s]?scale)\b/i.test(q)) {
    criteria.mood.push("epic");
  }

  const eraMatch = q.match(/\b(19\d{2}|20\d{2})s\b/);
  if (eraMatch) {
    criteria.era = eraMatch[1];
  }

  return criteria;
}

// Add this function to better detect recommendation queries
function isRecommendationQuery(query) {
  if (!query) return false;

  // Convert query to lowercase for easier matching
  const lowerQuery = query.toLowerCase();

  // List of keywords that indicate a recommendation query
  const recommendationKeywords = [
    "recommend",
    "recommendation",
    "suggest",
    "suggestion",
    "similar",
    "like",
    "more",
    "best",
    "top",
    "great",
    "good",
    "awesome",
    "favorite",
    "favourite",
    "best",
    "top",
    "popular",
    "highly rated",
    "critically acclaimed",
    "award",
    "award-winning",
    "oscar",
    "emmy",
    "must watch",
    "must-see",
    "hidden gem",
    "underrated",
    "overrated",
    "classic",
    "cult",
    "trending",
    "new",
    "new release",
    "latest",
  ];

  return recommendationKeywords.some((keyword) => lowerQuery.includes(keyword));
}

module.exports = {
  determineIntentFromKeywords,
  extractGenreCriteria,
  isRecommendationQuery,
};
