const HOST = process.env.HOST
  ? `https://${process.env.HOST}`
  : "https://stremio.itcon.au";
const BASE_PATH = "/aisearch";

const manifest = {
  id: "au.itcon.aisearch",
  version: "1.0.65",
  name: "AI Search",
  description: "AI-powered movie and series recommendations",
  resources: [
    "catalog",
    "meta",
    {
      name: "stream",
      types: ["movie", "series"],
      idPrefixes: ["tt"],
    },
  ],
  types: ["movie", "series"],
  catalogs: [
    {
      type: "movie",
      id: "aisearch.top",
      name: "AI Movie Search",
      extra: [{ name: "search", isRequired: true }],
      isSearch: true,
    },
    {
      type: "series",
      id: "aisearch.top",
      name: "AI Series Search",
      extra: [{ name: "search", isRequired: true }],
      isSearch: true,
    },
    {
      type: "movie",
      id: "aisearch.recommend",
      name: "AI Movie Recommendations",
    },
    {
      type: "series",
      id: "aisearch.recommend",
      name: "AI Series Recommendations",
    },
  ],
  behaviorHints: {
    configurable: true,
    configurationRequired: true,
    searchable: true,
  },
  logo: `${HOST}${BASE_PATH}/logo.png`,
  background: `${HOST}${BASE_PATH}/bg.jpg`,
  contactEmail: "hi@itcon.au",
};

module.exports = {
  manifest,
};
