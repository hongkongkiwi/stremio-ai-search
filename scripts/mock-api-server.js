/* eslint-disable no-console */
const http = require("http");
const { URL } = require("url");

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function okConfiguration() {
  return {
    images: {
      base_url: "https://image.tmdb.org/t/p/",
      secure_base_url: "https://image.tmdb.org/t/p/",
      poster_sizes: ["w92", "w154", "w185", "w342", "w500", "original"],
      backdrop_sizes: ["w300", "w780", "w1280", "original"],
    },
    change_keys: [],
  };
}

function movieResult(id, title, year, imdbId) {
  return {
    id,
    title,
    release_date: `${year}-01-01`,
    poster_path: "/poster.jpg",
    backdrop_path: "/backdrop.jpg",
    vote_average: 8.2,
    genre_ids: [28, 878],
    overview: `Overview for ${title}`,
    imdb_id: imdbId,
  };
}

function tvResult(id, name, year, imdbId) {
  return {
    id,
    name,
    first_air_date: `${year}-01-01`,
    poster_path: "/poster.jpg",
    backdrop_path: "/backdrop.jpg",
    vote_average: 8.0,
    genre_ids: [10759, 18],
    overview: `Overview for ${name}`,
    imdb_id: imdbId,
  };
}

function makeSearchResults(kind, query) {
  const q = String(query || "").toLowerCase();
  if (kind === "movie") {
    if (q.includes("matrix")) {
      return [movieResult(603, "The Matrix", 1999, "tt0133093")];
    }
    if (q.includes("inception")) {
      return [movieResult(27205, "Inception", 2010, "tt1375666")];
    }
    return [
      movieResult(100, "Mock Movie One", 2001, "tt0000100"),
      movieResult(101, "Mock Movie Two", 2002, "tt0000101"),
    ];
  }

  if (q.includes("breaking bad")) {
    return [tvResult(1396, "Breaking Bad", 2008, "tt0903747")];
  }
  return [
    tvResult(200, "Mock Series One", 2011, "tt0000200"),
    tvResult(201, "Mock Series Two", 2012, "tt0000201"),
  ];
}

function buildChatCompletions(prompt) {
  const p = String(prompt || "").toLowerCase();
  const wantsSeries = p.includes("series recommendation expert");

  const lines = wantsSeries
    ? [
        "series|Breaking Bad|2008",
        "series|Mock Series One|2011",
        "series|Mock Series Two|2012",
        "series|Mock Series Three|2013",
        "series|Mock Series Four|2014",
      ]
    : [
        "movie|The Matrix|1999",
        "movie|Inception|2010",
        "movie|Mock Movie One|2001",
        "movie|Mock Movie Two|2002",
        "movie|Mock Movie Three|2003",
      ];

  return {
    id: "chatcmpl_mock",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "mock",
    choices: [{ index: 0, message: { role: "assistant", content: lines.join("\n") } }],
  };
}

function getQueryParam(url, name) {
  const v = url.searchParams.get(name);
  return v === null ? "" : v;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    // OpenAI-compatible: /v1/chat/completions
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      const body = await readJson(req);
      const prompt = body?.messages?.[0]?.content || "";
      return sendJson(res, 200, buildChatCompletions(prompt));
    }

    // TMDB: /3/configuration
    if (req.method === "GET" && url.pathname === "/3/configuration") {
      const apiKey = getQueryParam(url, "api_key");
      if (!apiKey || apiKey === "bad") return sendJson(res, 401, { status_message: "Invalid API key" });
      return sendJson(res, 200, okConfiguration());
    }

    // TMDB: /3/search/movie or /3/search/tv
    if (req.method === "GET" && url.pathname === "/3/search/movie") {
      const query = getQueryParam(url, "query");
      return sendJson(res, 200, { results: makeSearchResults("movie", query) });
    }
    if (req.method === "GET" && url.pathname === "/3/search/tv") {
      const query = getQueryParam(url, "query");
      return sendJson(res, 200, { results: makeSearchResults("tv", query) });
    }

    // TMDB: /3/movie/:id and /3/tv/:id (details)
    const movieMatch = url.pathname.match(/^\/3\/movie\/(\d+)$/);
    if (req.method === "GET" && movieMatch) {
      const id = Number(movieMatch[1]);
      const imdbId = id === 603 ? "tt0133093" : `tt${String(id).padStart(7, "0")}`;
      return sendJson(res, 200, {
        ...movieResult(id, id === 603 ? "The Matrix" : "Mock Movie One", 1999, imdbId),
        external_ids: { imdb_id: imdbId },
      });
    }
    const tvMatch = url.pathname.match(/^\/3\/tv\/(\d+)$/);
    if (req.method === "GET" && tvMatch) {
      const id = Number(tvMatch[1]);
      const imdbId = id === 1396 ? "tt0903747" : `tt${String(id).padStart(7, "0")}`;
      return sendJson(res, 200, {
        ...tvResult(id, id === 1396 ? "Breaking Bad" : "Mock Series One", 2008, imdbId),
        external_ids: { imdb_id: imdbId },
      });
    }

    // TMDB: /3/find/:imdbId
    const findMatch = url.pathname.match(/^\/3\/find\/(tt\d+)$/);
    if (req.method === "GET" && findMatch) {
      const imdbId = findMatch[1];
      const wantsMovie = getQueryParam(url, "external_source") === "imdb_id";
      const movie_results = [movieResult(603, "The Matrix", 1999, imdbId)];
      const tv_results = [tvResult(1396, "Breaking Bad", 2008, imdbId)];
      return sendJson(res, 200, {
        movie_results: wantsMovie ? movie_results : movie_results,
        tv_results: tv_results,
      });
    }

    return sendJson(res, 404, { error: "Not found", path: url.pathname });
  } catch (e) {
    return sendJson(res, 500, { error: e.message });
  }
});

const port = Number(process.env.MOCK_PORT) || 8787;
server.listen(port, () => {
  console.log(`Mock API server listening on http://127.0.0.1:${port}`);
  console.log(`- OpenAI compat: POST /v1/chat/completions`);
  console.log(`- TMDB: GET /3/configuration, /3/search/movie, /3/search/tv, /3/movie/:id, /3/tv/:id, /3/find/:imdbId`);
});

