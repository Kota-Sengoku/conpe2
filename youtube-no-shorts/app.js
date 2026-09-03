"use strict";

/*
 * No Shorts Tube
 * YouTube Data API v3 を使い、登録チャンネルの新着フィードとキーワード検索から
 * ショート動画を取り除いて表示する個人用サイト。
 * API キー・登録チャンネルはすべてブラウザの localStorage にのみ保存する。
 */

const LS_KEYS = {
  apiKey: "nst_api_key",
  channels: "nst_channels",
  shortsMode: "nst_shorts_mode",
};

const API_BASE = "https://www.googleapis.com/youtube/v3";
const MAX_AUTO_ROUNDS = 3; // Shorts除外後の件数が少ないときに自動追加取得する上限回数
const MIN_RESULTS_BEFORE_AUTOLOAD = 6;

// ---------- state ----------

const state = {
  channels: loadChannels(), // [{id, title, thumbnail, uploadsPlaylistId, nextPageToken}]
  shortsMode: localStorage.getItem(LS_KEYS.shortsMode) || "duration",
  home: { shown: [], exhausted: false },
  search: { query: "", nextPageToken: null, shown: [], exhausted: false },
};

// ---------- storage helpers ----------

function getApiKey() {
  return localStorage.getItem(LS_KEYS.apiKey) || "";
}

function loadChannels() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEYS.channels) || "[]");
  } catch {
    return [];
  }
}

function saveChannels() {
  localStorage.setItem(LS_KEYS.channels, JSON.stringify(state.channels));
}

// ---------- YouTube API ----------

class ApiError extends Error {}

async function ytFetch(endpoint, params) {
  const apiKey = getApiKey();
  if (!apiKey) throw new ApiError("APIキーが設定されていません。「設定」からYouTube Data APIキーを入力してください。");
  const url = new URL(`${API_BASE}/${endpoint}`);
  url.searchParams.set("key", apiKey);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const reason = body?.error?.message || `${res.status} ${res.statusText}`;
    throw new ApiError(`YouTube APIエラー: ${reason}`);
  }
  return res.json();
}

function parseIsoDuration(iso) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || "");
  if (!m) return 0;
  const h = parseInt(m[1] || "0", 10);
  const mi = parseInt(m[2] || "0", 10);
  const s = parseInt(m[3] || "0", 10);
  return h * 3600 + mi * 60 + s;
}

function formatDuration(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

async function isShortByOEmbed(videoId) {
  try {
    const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(
      "https://www.youtube.com/shorts/" + videoId
    )}&format=json`;
    const res = await fetch(url);
    return res.ok; // /shorts/{id} が存在すればショート
  } catch {
    return null; // 判定不能(CORS等) -> 長さ判定にフォールバック
  }
}

/** videoIds (最大50件ずつ) の詳細を取得し、ショートを除いた配列を返す */
async function fetchDetailsAndFilterShorts(videoIds) {
  const details = new Map();
  for (let i = 0; i < videoIds.length; i += 50) {
    const chunk = videoIds.slice(i, i + 50);
    const data = await ytFetch("videos", {
      part: "snippet,contentDetails,statistics",
      id: chunk.join(","),
    });
    for (const item of data.items || []) {
      details.set(item.id, item);
    }
  }

  const result = [];
  for (const id of videoIds) {
    const item = details.get(id);
    if (!item) continue;
    const durationSeconds = parseIsoDuration(item.contentDetails?.duration);
    let isShort = durationSeconds > 0 && durationSeconds <= 60;

    if (state.shortsMode === "oembed") {
      const oembedResult = await isShortByOEmbed(id);
      if (oembedResult !== null) isShort = oembedResult;
    }

    if (isShort) continue;

    result.push({
      id,
      title: item.snippet.title,
      channelTitle: item.snippet.channelTitle,
      publishedAt: item.snippet.publishedAt,
      thumbnail:
        item.snippet.thumbnails?.medium?.url ||
        item.snippet.thumbnails?.default?.url,
      durationSeconds,
    });
  }
  return result;
}

async function resolveChannel(rawInput) {
  const input = rawInput.trim();
  if (!input) throw new ApiError("チャンネル名またはURLを入力してください。");

  let handle = null;
  let channelId = null;

  const idMatch = input.match(/UC[0-9A-Za-z_-]{22}/);
  if (idMatch) {
    channelId = idMatch[0];
  } else {
    const handleMatch = input.match(/@([\w.-]+)/);
    if (handleMatch) handle = handleMatch[1];
    else if (input.startsWith("@")) handle = input.slice(1);
  }

  let data;
  if (channelId) {
    data = await ytFetch("channels", { part: "snippet,contentDetails", id: channelId });
  } else if (handle) {
    data = await ytFetch("channels", { part: "snippet,contentDetails", forHandle: handle });
  } else {
    const searchData = await ytFetch("search", {
      part: "snippet",
      type: "channel",
      q: input,
      maxResults: 1,
    });
    const found = searchData.items?.[0];
    if (!found) throw new ApiError(`チャンネルが見つかりませんでした: ${input}`);
    data = await ytFetch("channels", {
      part: "snippet,contentDetails",
      id: found.snippet.channelId || found.id.channelId,
    });
  }

  const item = data.items?.[0];
  if (!item) throw new ApiError(`チャンネルが見つかりませんでした: ${input}`);

  return {
    id: item.id,
    title: item.snippet.title,
    thumbnail: item.snippet.thumbnails?.default?.url || "",
    uploadsPlaylistId: item.contentDetails.relatedPlaylists.uploads,
    nextPageToken: null,
  };
}

/** 1チャンネルの次ページ分の動画IDとページトークンを取得 */
async function fetchChannelPlaylistPage(channel) {
  if (channel.nextPageToken === "DONE") return { videoIds: [], done: true };
  const data = await ytFetch("playlistItems", {
    part: "contentDetails",
    playlistId: channel.uploadsPlaylistId,
    maxResults: 15,
    pageToken: channel.nextPageToken || undefined,
  });
  channel.nextPageToken = data.nextPageToken || "DONE";
  const videoIds = (data.items || []).map((i) => i.contentDetails.videoId);
  return { videoIds, done: channel.nextPageToken === "DONE" };
}

// ---------- rendering ----------

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) node.appendChild(child);
  return node;
}

function renderVideoCard(video) {
  const publishedDate = new Date(video.publishedAt).toLocaleDateString("ja-JP");
  const card = el("div", { class: "video-card" }, [
    el("div", { class: "video-thumb-wrap" }, [
      el("img", { src: video.thumbnail, alt: video.title, loading: "lazy" }),
      el("span", { class: "video-duration", text: formatDuration(video.durationSeconds) }),
    ]),
    el("div", { class: "video-info" }, [
      el("p", { class: "video-title", text: video.title }),
      el("p", { class: "video-meta", text: `${video.channelTitle} ・ ${publishedDate}` }),
    ]),
  ]);
  card.addEventListener("click", () => openPlayer(video.id));
  return card;
}

function appendVideos(gridEl, videos) {
  const frag = document.createDocumentFragment();
  for (const v of videos) frag.appendChild(renderVideoCard(v));
  gridEl.appendChild(frag);
}

function openPlayer(videoId) {
  const container = document.getElementById("playerContainer");
  container.innerHTML = "";
  const iframe = el("iframe", {
    src: `https://www.youtube.com/embed/${videoId}?autoplay=1`,
    allow: "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture",
    allowfullscreen: "true",
  });
  container.appendChild(iframe);
  document.getElementById("playerModal").classList.remove("hidden");
}

function closePlayer() {
  document.getElementById("playerModal").classList.add("hidden");
  document.getElementById("playerContainer").innerHTML = "";
}

// ---------- home feed ----------

async function loadHomeRound() {
  if (state.channels.length === 0) {
    document.getElementById("homeMessage").textContent =
      "登録チャンネルがありません。「設定」から見たいチャンネルを追加してください。";
    document.getElementById("loadMoreHomeBtn").classList.add("hidden");
    return;
  }

  const msgEl = document.getElementById("homeMessage");
  const gridEl = document.getElementById("homeGrid");
  const moreBtn = document.getElementById("loadMoreHomeBtn");
  msgEl.textContent = "読み込み中...";

  try {
    let addedCount = 0;
    for (let round = 0; round < MAX_AUTO_ROUNDS; round++) {
      const activeChannels = state.channels.filter((c) => c.nextPageToken !== "DONE");
      if (activeChannels.length === 0) {
        state.home.exhausted = true;
        break;
      }

      const pages = await Promise.all(activeChannels.map(fetchChannelPlaylistPage));
      const videoIds = pages.flatMap((p) => p.videoIds);
      saveChannels();

      if (videoIds.length > 0) {
        const filtered = await fetchDetailsAndFilterShorts(videoIds);
        filtered.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
        appendVideos(gridEl, filtered);
        addedCount += filtered.length;
        state.home.shown.push(...filtered);
      }

      if (addedCount >= MIN_RESULTS_BEFORE_AUTOLOAD) break;
    }

    msgEl.textContent = state.home.shown.length === 0
      ? "表示できる動画がありません(全てショートだった可能性があります)。"
      : "";
    moreBtn.classList.toggle("hidden", state.channels.every((c) => c.nextPageToken === "DONE"));
  } catch (err) {
    msgEl.textContent = err.message || String(err);
  }
}

function resetHome() {
  state.home = { shown: [], exhausted: false };
  document.getElementById("homeGrid").innerHTML = "";
  document.getElementById("homeMessage").textContent = "";
}

// ---------- search ----------

async function runSearch(query, { reset }) {
  const msgEl = document.getElementById("searchMessage");
  const gridEl = document.getElementById("searchGrid");
  const moreBtn = document.getElementById("loadMoreSearchBtn");

  if (reset) {
    state.search = { query, nextPageToken: null, shown: [], exhausted: false };
    gridEl.innerHTML = "";
  }

  msgEl.textContent = "検索中...";
  try {
    let addedCount = 0;
    for (let round = 0; round < MAX_AUTO_ROUNDS; round++) {
      if (state.search.exhausted) break;

      const data = await ytFetch("search", {
        part: "snippet",
        type: "video",
        q: state.search.query,
        maxResults: 25,
        pageToken: state.search.nextPageToken || undefined,
      });
      state.search.nextPageToken = data.nextPageToken || null;
      if (!data.nextPageToken) state.search.exhausted = true;

      const videoIds = (data.items || []).map((i) => i.id.videoId).filter(Boolean);
      if (videoIds.length > 0) {
        const filtered = await fetchDetailsAndFilterShorts(videoIds);
        appendVideos(gridEl, filtered);
        addedCount += filtered.length;
        state.search.shown.push(...filtered);
      }

      if (addedCount >= MIN_RESULTS_BEFORE_AUTOLOAD) break;
    }

    msgEl.textContent = state.search.shown.length === 0
      ? "該当する動画が見つかりませんでした(全てショートだった可能性があります)。"
      : "";
    moreBtn.classList.toggle("hidden", state.search.exhausted);
  } catch (err) {
    msgEl.textContent = err.message || String(err);
  }
}

// ---------- channel management UI ----------

function renderChannelList() {
  const listEl = document.getElementById("channelList");
  listEl.innerHTML = "";
  for (const ch of state.channels) {
    const li = el("li", {}, [
      el("img", { src: ch.thumbnail || "", alt: "" }),
      el("span", { class: "ch-name", text: ch.title }),
      el("button", { class: "remove-btn", text: "削除" }),
    ]);
    li.querySelector(".remove-btn").addEventListener("click", () => {
      state.channels = state.channels.filter((c) => c.id !== ch.id);
      saveChannels();
      renderChannelList();
      resetHome();
    });
    listEl.appendChild(li);
  }
}

async function addChannel() {
  const input = document.getElementById("channelInput");
  const value = input.value;
  if (!value.trim()) return;
  try {
    const channel = await resolveChannel(value);
    if (state.channels.some((c) => c.id === channel.id)) {
      alert("すでに登録済みのチャンネルです。");
      return;
    }
    state.channels.push(channel);
    saveChannels();
    renderChannelList();
    input.value = "";
    resetHome();
    loadHomeRound();
  } catch (err) {
    alert(err.message || String(err));
  }
}

// ---------- init / event wiring ----------

function switchTab(tabName) {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tabName);
  });
  document.getElementById("homeTab").classList.toggle("hidden", tabName !== "home");
  document.getElementById("searchTab").classList.toggle("hidden", tabName !== "search");
}

function initSettingsPanel() {
  const apiKeyInput = document.getElementById("apiKeyInput");
  apiKeyInput.value = getApiKey();

  document.getElementById("toggleApiKeyVisBtn").addEventListener("click", (e) => {
    const showing = apiKeyInput.type === "text";
    apiKeyInput.type = showing ? "password" : "text";
    e.target.textContent = showing ? "表示" : "隠す";
  });

  document.getElementById("saveApiKeyBtn").addEventListener("click", () => {
    localStorage.setItem(LS_KEYS.apiKey, apiKeyInput.value.trim());
    alert("APIキーを保存しました。");
    resetHome();
    loadHomeRound();
  });

  const shortsModeSelect = document.getElementById("shortsModeSelect");
  shortsModeSelect.value = state.shortsMode;
  shortsModeSelect.addEventListener("change", () => {
    state.shortsMode = shortsModeSelect.value;
    localStorage.setItem(LS_KEYS.shortsMode, state.shortsMode);
  });

  document.getElementById("addChannelBtn").addEventListener("click", addChannel);
  document.getElementById("channelInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") addChannel();
  });

  renderChannelList();
}

function init() {
  initSettingsPanel();

  document.getElementById("settingsBtn").addEventListener("click", () => {
    document.getElementById("settingsPanel").classList.toggle("hidden");
  });

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  document.getElementById("refreshHomeBtn").addEventListener("click", () => {
    for (const ch of state.channels) ch.nextPageToken = null;
    saveChannels();
    resetHome();
    loadHomeRound();
  });

  document.getElementById("loadMoreHomeBtn").addEventListener("click", loadHomeRound);

  document.getElementById("searchForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const query = document.getElementById("searchInput").value.trim();
    if (query) runSearch(query, { reset: true });
  });

  document.getElementById("loadMoreSearchBtn").addEventListener("click", () => {
    runSearch(state.search.query, { reset: false });
  });

  document.getElementById("closePlayerBtn").addEventListener("click", closePlayer);
  document.getElementById("playerModal").addEventListener("click", (e) => {
    if (e.target.id === "playerModal") closePlayer();
  });

  if (!getApiKey()) {
    document.getElementById("settingsPanel").classList.remove("hidden");
    document.getElementById("homeMessage").textContent =
      "まず「設定」からYouTube Data APIキーを入力してください。";
  } else {
    loadHomeRound();
  }
}

document.addEventListener("DOMContentLoaded", init);
