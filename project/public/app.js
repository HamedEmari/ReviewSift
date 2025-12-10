const $ = (id) => document.getElementById(id);

const resultsEl = $("results");
const emptyEl = $("empty");
const overviewEl = $("overview");
const prosEl = $("pros");
const consEl = $("cons");
const keywordsEl = $("keywords");
const samplesEl = $("samples");
const searchBtn = $("searchBtn");
const queryInput = $("query");
const langSelect = $("lang");
const genPosterBtn = document.getElementById("genPosterBtn");
const aiArtEl = document.getElementById("aiArt");
let currentGame = null;
let currentSummary = null;


let lastGame = null;

searchBtn.addEventListener("click", () => doSearch());
queryInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") doSearch();
});

genPosterBtn.addEventListener("click", () => {
  if (!currentGame || !currentSummary) {
    aiArtEl.innerHTML = "<div>Select a game first.</div>";
    return;
  }
  generatePoster(currentGame, currentSummary);
});


langSelect?.addEventListener("change", () => {
  if (lastGame) fetchReviews(lastGame);
});

function langLabel(code) {
  const map = {
    english: "English",
    spanish: "Spanish",
    schinese: "Chinese (Simplified)",
    portuguese: "Portuguese",
    russian: "Russian"
  };
  return map[code] || code || "English";
}

async function doSearch() {
  const term = queryInput.value.trim();
  resultsEl.innerHTML = "";
  overviewEl.innerHTML = "";
  prosEl.innerHTML = "";
  consEl.innerHTML = "";
  keywordsEl.innerHTML = "";
  samplesEl.innerHTML = "";
  emptyEl.textContent = "Searching…";

  if (!term) {
    emptyEl.textContent = "Type a game name to search.";
    return;
  }

  const res = await fetch(`/api/search?term=${encodeURIComponent(term)}`);
  const data = await res.json();
  const items = data.results || [];

  if (!items.length) {
    emptyEl.textContent = "No matches found.";
    return;
  }

  emptyEl.textContent = "";
  for (const g of items.slice(0, 12)) {
    const div = document.createElement("div");
    div.className = "game";
    div.innerHTML = `
      <img src="${g.tiny_image || ""}" alt="">
      <div>
        <div><strong>${g.name}</strong></div>
        <div class="muted">${g.released ? `Released: ${g.released}` : ""}</div>
      </div>
      <div><span class="pill">${g.price || "Price varies"}</span></div>
    `;
    div.addEventListener("click", () => fetchReviews(g));
    resultsEl.appendChild(div);
  }
}

async function fetchReviews(game) {
  lastGame = game;
  currentGame = game;
  currentSummary = null;
  aiArtEl.innerHTML = "";

  const lang = (langSelect?.value || "english").trim();

  overviewEl.innerHTML = "Fetching recent reviews… (AI synthesis running)";
  prosEl.innerHTML = "";
  consEl.innerHTML = "";
  keywordsEl.innerHTML = "";
  samplesEl.innerHTML = "";

  const res = await fetch(
    `/api/reviews?appId=${game.appid}&num=300&lang=${encodeURIComponent(lang)}`
  );
  const data = await res.json();

  if (!data || !data.summary) {
    overviewEl.textContent = "No reviews available or AI failed.";
    return;
  }

  const s = data.summary;
  const usedLang = data.lang || (langSelect?.value || "english").trim();


  overviewEl.innerHTML = `
    <div class="stat"><div class="k">Game</div><div class="v">${escapeHtml(game.name)}</div></div>
    <div class="stat"><div class="k">Language</div><div class="v">${escapeHtml(langLabel(lang))}</div></div>
    <div class="divider"></div>
    <div class="stat"><div class="k">Overall</div><div class="v">${escapeHtml(s.overall)}</div></div>
    <div class="stat"><div class="k">Verdict</div><div class="v">${escapeHtml(s.verdict)}</div></div>
    <div class="stat"><div class="k">Avg. playtime (hrs)</div><div class="v">${s.playtimeAvgHrs ?? "–"}</div></div>
    <div class="small">AI summary generated from ${data.count} recent reviews.</div>
  `;

  currentSummary = s;

  // Keywords
  keywordsEl.innerHTML = (s.topKeywords || [])
    .map((k) => `<span class="pill">${escapeHtml(k)}</span>`)
    .join("");

  // Pros/Cons
  const pros = (s.pros || []).slice(0, 6);
  const cons = (s.cons || []).slice(0, 6);

  prosEl.innerHTML = listify(pros, "pos");
  consEl.innerHTML = listify(cons, "neg");

  // Samples
  samplesEl.innerHTML = (data.sample || [])
    .map(
      (r) => `
      <div class="sample">
        <div class="small" style="display:flex;gap:8px;align-items:center;margin-bottom:6px;">
          <span class="badge ${r.voted_up ? "pos" : "neg"}">${r.voted_up ? "Recommended" : "Not Recommended"}</span>
          <span class="muted">Playtime: ${r.playtime_hours}h • Helpful: ${r.votes_up}</span>
        </div>
        <div>${escapeHtml(r.review)}</div>
      </div>`
    )
    .join("");
}

function listify(arr, cls) {
  if (!arr || !arr.length) return `<div class="small muted">No highlights yet.</div>`;
  return `<ul>${arr.map((s) => `<li class="${cls}">${escapeHtml(s)}</li>`).join("")}</ul>`;
}

function escapeHtml(s) {
  return (s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
async function generatePoster(game, summary) {
  aiArtEl.innerHTML = '<div class="small">Generating AI poster…</div>';

  try {
    const res = await fetch("/api/art", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appId: game.appid,
        name: game.name,
        verdict: summary.verdict,
        positivity: summary.positivity,
        themes: summary.themes,
        topKeywords: summary.topKeywords,
        pros: summary.pros,
        cons: summary.cons
      })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error("AI art API error:", res.status, err);
      aiArtEl.innerHTML = '<div class="small">Image API error.</div>';
      return;
    }

    const data = await res.json();

    if (!data.imageUrl) {
      console.error("AI art response missing imageUrl:", data);
      aiArtEl.innerHTML = '<div class="small">No image returned.</div>';
      return;
    }

    aiArtEl.innerHTML = `<img src="${data.imageUrl}" alt="AI vibe poster" />`;
  } catch (err) {
    console.error("AI art fetch failed:", err);
    aiArtEl.innerHTML = '<div class="small">Failed to generate image.</div>';
  }
}

