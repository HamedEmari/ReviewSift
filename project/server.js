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

const PORT = process.env.PORT || 3000;

/*Search games by name */
app.get("/api/search", async (req, res) => {
  try {
    const term = (req.query.term || "").toString().trim();
    if (!term) return res.json({ results: [] });

    const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(
      term
    )}&l=english&cc=US`;

    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    const data = await r.json();

    const results = (data.items || []).map((it) => ({
      appid: it.id,
      name: it.name,
      price: it.price,
      tiny_image: it.tiny_image,
      released: it.released
    }));

    res.json({ results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Search failed." });
  }
});

/** Fetch recent reviews, then ask Gemini to synthesize them */
app.get("/api/reviews", async (req, res) => {
  try {
    const appId = req.query.appId?.toString();
    const max = Math.min(parseInt(req.query.num || "200", 10), 1000);
    if (!appId) return res.status(400).json({ error: "Missing appId." });

    // Pull recent reviews from Steam
    let cursor = "*";
    let all = [];
    while (all.length < max) {
      const url = `https://store.steampowered.com/appreviews/${appId}?json=1&filter=recent&language=all&day_range=365&review_type=all&purchase_type=all&num_per_page=100&cursor=${encodeURIComponent(
        cursor
      )}`;
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      const data = await r.json();

      const chunk = data?.reviews || [];
      if (!chunk.length) break;

      all = all.concat(chunk);
      cursor = data.cursor || cursor;

      if (chunk.length < 100) break; // end of pages
    }

    // Keep a deterministic slice so prompts are stable
    all = all.slice(0, max);

    // Prepare plain texts for the model (trim super long ones)
    const toText = (rv) =>
      `[${rv.voted_up ? "Recommended" : "Not Recommended"} | Helpful:${rv.votes_up} | Playtime:${Math.round(
        (rv.author?.playtime_forever || 0) / 60
      )}h] ${rv.review || ""}`.slice(0, 1400);

    // Cap raw token load: batch reviews 
    const reviewTexts = all.map(toText);
    const batches = [];
    const batchSize = 60; 
    for (let i = 0; i < reviewTexts.length; i += batchSize) {
      batches.push(reviewTexts.slice(i, i + batchSize));
    }

    // Initialize Gemini
    const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });


    // structured JSON
    const partials = [];
    for (const [idx, batch] of batches.entries()) {
      const prompt = buildBatchPrompt(batch, idx + 1, batches.length);
      const resp = await model.generateContent(prompt);
      const txt = resp.response.text();
      const json = safeJson(txt);
      if (json) partials.push(json);
    }

    // merge batches
    const mergePrompt = buildMergePrompt(partials, {
      totalCount: all.length,
      appId
    });
    const mergeResp = await model.generateContent(mergePrompt);
    const merged = safeJson(mergeResp.response.text());

    // Fallback 
    const summary =
      merged ||
      {
        overall: "Summary unavailable",
        verdict: "Unknown",
        positivity: null,
        playtimeAvgHrs: null,
        pros: [],
        cons: [],
        themes: [],
        topKeywords: []
      };

    // Also return a few samples for the UI
    const sample = all.slice(0, 12).map((r) => ({
      voted_up: r.voted_up,
      votes_up: r.votes_up,
      weighted_vote_score: r.weighted_vote_score,
      review: r.review,
      playtime_hours: Math.round((r.author?.playtime_forever || 0) / 60)
    }));

    res.json({ count: all.length, appId, summary, sample });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Review fetch/synthesis failed." });
  }
});

/* ------------------------------ Helpers ------------------------------ */

function buildBatchPrompt(reviews, batchIndex, totalBatches) {
  return [
    `You are analyzing Steam user reviews for a video game (batch ${batchIndex} of ${totalBatches}).`,
    `Each line is one review with a header like: [Recommended|Not Recommended | Helpful:N | Playtime:Nh] text...`,
    ``,
    `GOAL: Produce a compact JSON summary capturing sentiment, common themes, pros, cons,`,
    `average playtime sentiment relationship (if visible), and top keywords. Avoid quoting long text.`,
    ``,
    `Return ONLY a single JSON object with this schema:`,
    `{
      "positivity": number,              // 0..1 fraction of positive-sounding reviews in this batch
      "pros": string[],                  // up to 6 short bullets
      "cons": string[],                  // up to 6 short bullets
      "themes": string[],                // 4–8 recurring topics (e.g., "co-op", "optimization", "story")
      "topKeywords": string[],           // 10–20 single words or short phrases
      "avgPlaytimeHoursObserved": number // rough average playtime mentioned/seen in headers
    }`,
    ``,
    `REVIEWS:\n${reviews.join("\n")}`
  ].join("\n");
}

function buildMergePrompt(partials, meta) {
  return [
    `You are merging ${partials.length} batch summaries of Steam game reviews into one final JSON summary.`,
    `Total reviews fetched: ${meta.totalCount}. Game appId: ${meta.appId}.`,
    ``,
    `INPUT_PARTIALS_JSON =`,
    JSON.stringify(partials),
    ``,
    `TASK: Merge the partials. Weigh items by their implied frequency and consistency.`,
    `Compute a final positivity (0..1), verdict label, overall string (e.g., "78% positive (X/Y recent reviews)"),`,
    `top themes, concise pros/cons (max 6 each), top keywords, and a rough average playtime.`,
    ``,
    `Verdict scale to use:
      - "Overwhelmingly Positive" (>=0.85)
      - "Very Positive"          (>=0.75)
      - "Mostly Positive"        (>=0.65)
      - "Somewhat Positive"      (>=0.55)
      - "Mixed"                  (>=0.45)
      - "Somewhat Negative"      (>=0.35)
      - "Mostly Negative"        (>=0.25)
      - "Very Negative"          (<0.25)`,
    ``,
    `Return ONLY JSON with this schema (no markdown, no commentary):`,
    `{
      "overall": string,           // e.g., "78% positive (156/200 recent reviews)"
      "verdict": string,           // one of the labels above
      "positivity": number,        // 0..1
      "playtimeAvgHrs": number,    // rounded to 0.1
      "pros": string[],            // up to 6
      "cons": string[],            // up to 6
      "themes": string[],          // 6–10 short phrases
      "topKeywords": string[]      // 10–20 concise tokens/phrases
    }`
  ].join("\n");
}

function safeJson(txt) {
  try {
    // strip code fences if any
    const cleaned = txt.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}


app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
