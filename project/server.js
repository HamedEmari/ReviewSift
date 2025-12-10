import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);


const PORT = process.env.PORT || 3000;

/* ------------------------------ Helpers ------------------------------ */

async function fetchJson(url) {
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    const err = new Error(`HTTP ${r.status} from ${url}`);
    err.httpStatus = r.status;
    err.body = body;
    throw err;
  }
  return r.json();
}

function verdictFromPositivity(p) {
  if (p >= 0.85) return "Overwhelmingly Positive";
  if (p >= 0.75) return "Very Positive";
  if (p >= 0.65) return "Mostly Positive";
  if (p >= 0.55) return "Somewhat Positive";
  if (p >= 0.45) return "Mixed";
  if (p >= 0.35) return "Somewhat Negative";
  if (p >= 0.25) return "Mostly Negative";
  return "Very Negative";
}

function tokenize(text) {
  return (text || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && w.length <= 24);
}

function topTermsFromReviews(reviews, limit = 15) {
  const stop = new Set([
    "this","that","with","have","game","play","just","like","you","your","for","and","the","are",
    "but","not","was","its","they","them","from","out","get","too","very","all","can","cant",
    "still","really","more","when","what","been","one","time","much","after","before","into"
  ]);

  const freq = new Map();
  for (const r of reviews) {
    for (const w of tokenize(r.review)) {
      if (stop.has(w)) continue;
      freq.set(w, (freq.get(w) || 0) + 1);
    }
  }

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([w]) => w);
}

function heuristicSummary(all) {
  const posCount = all.filter((r) => r.voted_up).length;
  const positivity = all.length ? posCount / all.length : 0;

  const avgPlaytime =
    all.length
      ? all.reduce((acc, r) => acc + (r.author?.playtime_forever || 0), 0) /
        all.length /
        60
      : 0;

  const positives = all.filter((r) => r.voted_up);
  const negatives = all.filter((r) => !r.voted_up);

  const posKeywords = topTermsFromReviews(positives, 8);
  const negKeywords = topTermsFromReviews(negatives, 8);
  const topKeywords = topTermsFromReviews(all, 18);

  const pros = posKeywords.slice(0, 6).map((k) => `Players frequently mention: ${k}`);
  const cons = negKeywords.slice(0, 6).map((k) => `Common complaint around: ${k}`);

  const themes = [...new Set(topKeywords.slice(0, 10))];

  return {
    overall: `${Math.round(positivity * 100)}% positive (${posCount}/${all.length})`,
    verdict: verdictFromPositivity(positivity),
    positivity,
    playtimeAvgHrs: Math.round(avgPlaytime * 10) / 10,
    pros,
    cons,
    themes,
    topKeywords
  };
}

function safeJson(txt) {
  try {
    const raw = (txt || "").trim();

    const noFences = raw
      .replace(/^```(?:json)?/i, "")
      .replace(/```$/i, "")
      .trim();

    const first = noFences.indexOf("{");
    const last = noFences.lastIndexOf("}");
    const sliced =
      first !== -1 && last !== -1 && last > first
        ? noFences.slice(first, last + 1)
        : noFences;

    return JSON.parse(sliced);
  } catch {
    return null;
  }
}

function buildBatchPrompt(reviews, batchIndex, totalBatches) {
  return [
    `You are analyzing Steam user reviews for a video game (batch ${batchIndex} of ${totalBatches}).`,
    `Each line is one review with a header like: [Recommended|Not Recommended | Helpful:N | Playtime:Nh] text...`,
    ``,
    `Return ONLY JSON (no markdown, no commentary) with this schema:`,
    `{
      "positivity": number,
      "pros": string[],
      "cons": string[],
      "themes": string[],
      "topKeywords": string[],
      "avgPlaytimeHoursObserved": number
    }`,
    ``,
    `REVIEWS:\n${reviews.join("\n")}`
  ].join("\n");
}

function buildMergePrompt(partials, meta) {
  return [
    `You are merging batch summaries of Steam game reviews into one final summary.`,
    `Total reviews fetched: ${meta.totalCount}. Game appId: ${meta.appId}.`,
    ``,
    `INPUT_PARTIALS_JSON = ${JSON.stringify(partials)}`,
    ``,
    `Return ONLY JSON (no markdown, no commentary) with this schema:`,
    `{
      "overall": string,
      "verdict": string,
      "positivity": number,
      "playtimeAvgHrs": number,
      "pros": string[],
      "cons": string[],
      "themes": string[],
      "topKeywords": string[]
    }`,
    ``,
    `Verdict scale:
      - "Overwhelmingly Positive" (>=0.85)
      - "Very Positive"          (>=0.75)
      - "Mostly Positive"        (>=0.65)
      - "Somewhat Positive"      (>=0.55)
      - "Mixed"                  (>=0.45)
      - "Somewhat Negative"      (>=0.35)
      - "Mostly Negative"        (>=0.25)
      - "Very Negative"          (<0.25)`
  ].join("\n");
}

/* ------------------------------ Routes ------------------------------ */

/* Search games by name */
app.get("/api/search", async (req, res) => {
  try {
    const term = (req.query.term || "").toString().trim();
    if (!term) return res.json({ results: [] });

    const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(
      term
    )}&l=english&cc=US`;

    const data = await fetchJson(url);

    const results = (data.items || []).map((it) => ({
      appid: it.id,
      name: it.name,
      price: it.price,
      tiny_image: it.tiny_image,
      released: it.released
    }));

    res.json({ results });
  } catch (err) {
    console.error("Search failed:", err);
    res.status(500).json({ error: "Search failed." });
  }
});

/* Fetch reviews, then ask Gemini to synthesize them */
app.get("/api/reviews", async (req, res) => {
  try {
    const appId = req.query.appId?.toString();
    const max = Math.min(parseInt(req.query.num || "200", 10), 1000);
    if (!appId) return res.status(400).json({ error: "Missing appId." });

    const allowedLangs = new Set(["english", "spanish", "schinese", "portuguese", "russian", "all"]);
    const langRaw = (req.query.lang || "english").toString().trim().toLowerCase();
    const lang = allowedLangs.has(langRaw) ? langRaw : "english";

    // -------- 1) Pull reviews from Steam  --------
    let cursor = "*";
    let all = [];

    while (all.length < max) {
      const url = `https://store.steampowered.com/appreviews/${appId}?json=1&filter=recent&language=${encodeURIComponent(
        lang
      )}&day_range=365&review_type=all&purchase_type=all&num_per_page=100&cursor=${encodeURIComponent(
        cursor
      )}`;

      const data = await fetchJson(url);

      if (!data || data.success !== 1) break;

      const rawChunk = data.reviews || [];

      // Force language filtering ourselves (Steam includes reviews[].language)
      const chunk =
        lang === "all"
        ? rawChunk
        : rawChunk.filter((r) => (r.language || "").toLowerCase() === lang);

        if (!chunk.length) {

        const nextCursor = data.cursor || cursor;
        if (nextCursor === cursor) break;
        cursor = nextCursor;
        continue;
    }

    all = all.concat(chunk);



      const nextCursor = data.cursor || cursor;
      if (nextCursor === cursor) break;
      cursor = nextCursor;

      if (chunk.length < 100) break;
    }

    all = all.slice(0, max);

    const sample = all.slice(0, 12).map((r) => ({
      voted_up: r.voted_up,
      votes_up: r.votes_up,
      weighted_vote_score: r.weighted_vote_score,
      review: r.review,
      playtime_hours: Math.round((r.author?.playtime_forever || 0) / 60)
    }));

    if (!all.length) {
      return res.json({
        count: 0,
        appId,
        lang,
        summary: {
          overall: "No reviews returned by Steam for this language.",
          verdict: "Unknown",
          positivity: null,
          playtimeAvgHrs: null,
          pros: [],
          cons: [],
          themes: [],
          topKeywords: []
        },
        sample: []
      });
    }

    // -------- 2) Local fallback summary --------
    const fallback = heuristicSummary(all);

    // -------- 3) Optional Gemini synthesis --------
    const key = (process.env.GOOGLE_API_KEY || "").trim();
    if (!key) {
      return res.json({ count: all.length, appId, lang, summary: fallback, sample });
    }

    let summary = fallback;

    try {
      const toText = (rv) =>
        `[${rv.voted_up ? "Recommended" : "Not Recommended"} | Helpful:${rv.votes_up} | Playtime:${Math.round(
          (rv.author?.playtime_forever || 0) / 60
        )}h] ${(rv.review || "").replace(/\s+/g, " ")}`.slice(0, 1400);

      const reviewTexts = all.map(toText).slice(0, 80);

      const batches = [];
      const batchSize = 50;
      for (let i = 0; i < reviewTexts.length; i += batchSize) {
        batches.push(reviewTexts.slice(i, i + batchSize));
      }

      const genAI = new GoogleGenerativeAI(key);

      const model = genAI.getGenerativeModel({
        model: "gemini-2.0-flash",
        generationConfig: {
          responseMimeType: "application/json"
        }
      });

      const partials = [];
      for (const [idx, batch] of batches.entries()) {
        const prompt = buildBatchPrompt(batch, idx + 1, batches.length);
        const resp = await model.generateContent(prompt);
        const txt = resp.response.text();
        const json = safeJson(txt);
        if (json) partials.push(json);
      }

      if (partials.length) {
        const mergePrompt = buildMergePrompt(partials, {
          totalCount: all.length,
          appId
        });
        const mergeResp = await model.generateContent(mergePrompt);
        const merged = safeJson(mergeResp.response.text());
        if (merged) summary = merged;
      }
    } catch (aiErr) {
      console.error("AI synthesis failed, using fallback summary:", aiErr);
    }

    return res.json({ count: all.length, appId, lang, summary, sample });
  } catch (err) {
    console.error("Review fetch failed:", err);
    res.status(500).json({ error: "Review fetch failed." });
  }
});

app.post("/api/art", async (req, res) => {
  try {
    const key = (process.env.GOOGLE_API_KEY || "").trim();
    if (!key) {
      console.error("No GOOGLE_API_KEY found in env for /api/art");
      return res.status(500).json({ error: "Server missing AI key." });
    }

    const { appId, name, verdict, positivity, themes = [], topKeywords = [], pros = [], cons = [] } = req.body || {};
    if (!name) return res.status(400).json({ error: "Missing game name." });

    const themesText = themes.slice(0, 4).join(", ");
    const keywordsText = topKeywords.slice(0, 10).join(", ");
    const prosText = pros.slice(0, 3).join("; ");
    const consText = cons.slice(0, 2).join("; ");

    const p = typeof positivity === "number" ? positivity : 0.5;
    let mood = "balanced, neutral mood";
    if (p >= 0.8) mood = "very positive, triumphant, vibrant mood";
    else if (p >= 0.6) mood = "optimistic, adventurous mood";
    else if (p < 0.4) mood = "dark, moody, tense atmosphere";

    const prompt = [
      `Create a cinematic digital illustration.`,
      `Do not include text.`,
      `Mood: ${mood}`,
      themesText ? `Themes: ${themesText}` : "",
      keywordsText ? `Keywords: ${keywordsText}` : "",
      prosText ? `Players praise: ${prosText}` : "",
      consText ? `Players complain about: ${consText}` : ""
    ].filter(Boolean).join("\n");

    const genAI = new GoogleGenerativeAI(key);

    const imageModel = genAI.getGenerativeModel({
      model: "gemini-2.0-flash-exp",
      generationConfig: { responseModalities: ["Text", "Image"] }
    });

    const resp = await imageModel.generateContent(prompt);
    const parts = resp.response?.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find(p => p.inlineData && p.inlineData.data);
    if (!imagePart) {
      console.error("No inlineData image returned from Gemini");
      return res.status(500).json({ error: "Image generation failed." });
    }

    const base64 = imagePart.inlineData.data;
    const mime = imagePart.inlineData.mimeType || "image/png";
    res.json({ appId, name, imageUrl: `data:${mime};base64,${base64}` });
  } catch (err) {
    console.error("AI art generation failed:", err);
    res.status(500).json({ error: "AI art generation failed." });
  }
});




app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
