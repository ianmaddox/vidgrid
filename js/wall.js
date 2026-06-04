let allVids = [];
let allPlaylists = [];
let activePlaylist = null;
let videoMeta = {};
let wallControlsVisible = false;
let playlistMenuOpen = false;
let gridScalerMenuOpen = false;
let gridScaleDelta = 0;
let soundLinearIndex = 0;
let soundGridR = 0;
let soundGridC = 0;
let resizeDebounceTimer = null;
const GRID_REF_CELL_HEIGHT = 300;
const RESIZE_DEBOUNCE_MS = 120;
const players = {};
const cellRetries = {};
const cellLastVideo = {};
const cellLastHealthy = {};
const cellLastTime = {};
const cellRevealed = {};
const cellStallHits = {};
const cellStartHits = {};
const cellPlayKicks = {};
const cellLastKick = {};
const videoAspectById = {};
const MAX_AUTOPLAY_KICKS = 5;
const KICK_COOLDOWN_MS = 900;
let soundCell = false;
let soundEnabled = false;
let autoplayUnlocked = false;
let tunedIn = false;
let popcornStarted = false;
let popcornScheduleGeneration = 0;
const popcornTimers = [];
let bootFinished = false;
let cellMonitorStarted = false;
let t;
let rows;
let cols;
let cells;

const POOL_URL = "data/video-pool.json";
const PLAYLIST_COOKIE = "vidgrid_playlist";
const PLAYLIST_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
const POPCORN_MS = 10000;
const TUNEIN_ANIM_MS = 5000;
const STATIC_BEAT_MS = 500;
const VIDEO_ASPECT = 16 / 9;
const COVER_OVERSCAN = 1.22;
const MAX_CELL_RETRIES = 12;
const YT_ERROR_CODES = new Set([2, 5, 100, 101, 150]);

const HEALTH_DEFAULT = {
  monitorMs: 1500,
  stallSamples: 4,
  stallEpsilon: 0.15,
  noProgressSamples: 6,
  playbackTimeoutMs: 12000,
  stalePlaybackMs: 10000,
  minPlayBeforeNearEndSec: 12,
};

/** Pool was built with per-video metadata — trust embeddable flags, ease stall checks. */
const HEALTH_WITH_POOL_META = {
  monitorMs: 2500,
  stallSamples: 8,
  stallEpsilon: 0.4,
  noProgressSamples: 12,
  playbackTimeoutMs: 22000,
  stalePlaybackMs: 28000,
  minPlayBeforeNearEndSec: 20,
};

let healthCfg = HEALTH_DEFAULT;

const PLAYER_VARS = {
  autoplay: 1,
  controls: 0,
  modestbranding: 1,
  rel: 0,
  playsinline: 1,
  iv_load_policy: 3,
  cc_load_policy: 0,
  disablekb: 1,
  fs: 0,
  autohide: 1,
  showinfo: 0,
  origin: window.location.origin,
};

function showPoolError(message) {
  hideLoading();
  $("#poolError").text(message).show();
  console.error(message);
}

function hideLoading() {
  const el = $("#loading");
  if (!el.length || !el.is(":visible")) {
    return;
  }
  el.addClass("done");
  setTimeout(() => el.hide(), 450);
}

function shuffle(o) {
  for (let j, x, i = o.length; i; j = Math.floor(Math.random() * i), x = o[--i], o[i] = o[j], o[j] = x);
  return o;
}

function cellIdFromEvent(event) {
  return $(event.target.a).closest("td").attr("id");
}

function cellMarkup(id) {
  return '<div id="' + id + '_vid" class="vid"></div>';
}

function isEmbeddable(videoId) {
  const meta = videoMeta[videoId];
  return !meta || meta.embeddable !== false;
}

function loadVideoMeta(videos) {
  videoMeta = videos || {};
  if (Object.keys(videoMeta).length > 0) {
    healthCfg = HEALTH_WITH_POOL_META;
  }
  for (const videoId of Object.keys(videoMeta)) {
    const meta = videoMeta[videoId];
    if (meta.aspectRatio) {
      videoAspectById[videoId] = meta.aspectRatio;
    } else if (meta.width && meta.height) {
      videoAspectById[videoId] = meta.width / meta.height;
    }
  }
}

function isLegacyPool(pool) {
  if (pool.videos) {
    return true;
  }
  const playlists = pool.playlists || [];
  return playlists.some((pl) => pl.videoIds && pl.videoIds.length);
}

function manifestUrlFor(playlist) {
  const path = playlist.manifest;
  if (!path) {
    return null;
  }
  return path.startsWith("data/") ? path : "data/" + path;
}

function playlistHasVideos(playlist) {
  if (playlist.videoCount > 0) {
    return true;
  }
  return Boolean(playlist.videoIds && playlist.videoIds.length);
}

async function loadManifest(playlist) {
  const url = manifestUrlFor(playlist);
  if (!url) {
    throw new Error("playlist missing manifest: " + playlist.id);
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error("HTTP " + response.status + " loading " + url);
  }
  const manifest = await response.json();
  playlist.videoIds = manifest.videoIds || [];
  playlist.videos = manifest.videos || {};
  return manifest;
}

async function ensureManifestLoaded(playlist) {
  if (playlist.videoIds && playlist.videoIds.length) {
    return;
  }
  await loadManifest(playlist);
}

function applyEmbeddableFilter() {
  if (!Object.keys(videoMeta).length) {
    return 0;
  }
  const embeddable = allVids.filter(isEmbeddable);
  const dropped = allVids.length - embeddable.length;
  if (embeddable.length === 0) {
    throw new Error("video pool has no embeddable videos after metadata filter");
  }
  allVids = embeddable;
  return dropped;
}

function readPlaylistCookie() {
  const match = document.cookie.match(
    new RegExp("(?:^|; )" + PLAYLIST_COOKIE + "=([^;]*)")
  );
  return match ? decodeURIComponent(match[1]) : null;
}

function writePlaylistCookie(playlistId) {
  document.cookie = (
    PLAYLIST_COOKIE + "=" + encodeURIComponent(playlistId)
    + "; path=/; max-age=" + PLAYLIST_COOKIE_MAX_AGE + "; SameSite=Lax"
  );
}

function playlistById(playlistId) {
  return allPlaylists.find((pl) => pl.id === playlistId) || null;
}

function pickInitialPlaylist() {
  if (!allPlaylists.length) {
    return null;
  }
  const withVideos = allPlaylists.filter(playlistHasVideos);
  if (!withVideos.length) {
    return null;
  }
  const savedId = readPlaylistCookie();
  if (savedId) {
    const saved = playlistById(savedId);
    if (saved && playlistHasVideos(saved)) {
      return saved;
    }
  }
  return shuffle(withVideos.slice())[0];
}

function applyActivePlaylist(playlist) {
  activePlaylist = playlist;
  allVids = playlist.videoIds.slice();
  loadVideoMeta(playlist.videos);
  const dropped = applyEmbeddableFilter();
  return dropped;
}

function loadPoolIndex(pool) {
  allPlaylists = pool.playlists || [];
  if (!allPlaylists.length) {
    throw new Error(
      "video-pool.json has no playlists — run: python scripts/build_feeds.py"
    );
  }
  return pool;
}

function loadPoolLegacy(pool) {
  allPlaylists = pool.playlists || [];
  if (!allPlaylists.length) {
    throw new Error(
      "video-pool.json has no playlists — run: python scripts/build_feeds.py"
    );
  }
  loadVideoMeta(pool.videos);
  return pool;
}

async function activateInitialPlaylist(pool, legacy) {
  const initial = pickInitialPlaylist();
  if (!initial) {
    throw new Error("video-pool.json has no playlists with videos");
  }
  if (!legacy) {
    await ensureManifestLoaded(initial);
  }
  const savedId = readPlaylistCookie();
  const fromCookie = Boolean(savedId && initial.id === savedId);
  const dropped = applyActivePlaylist(initial);
  writePlaylistCookie(activePlaylist.id);
  const metaCount = Object.keys(videoMeta).length;
  const source = fromCookie ? "cookie" : "random";
  console.log(
    "Loaded playlist",
    activePlaylist.title || activePlaylist.id,
    "(" + source + ",",
    allVids.length,
    "videos, generated",
    pool.generatedAt,
    metaCount ? ", " + metaCount + " with build metadata" : "",
    dropped ? ", " + dropped + " non-embeddable removed" : "",
    metaCount ? ", relaxed health monitor" : "",
    legacy ? ", legacy monolithic pool" : "",
    ")"
  );
  renderPlaylistMenu();
}

function updatePlaylistMenuSelection() {
  if (!activePlaylist) {
    return;
  }
  $("#playlistMenu .playlist-menu-item").each(function updateItem() {
    const item = $(this);
    item.toggleClass("active", item.data("playlistId") === activePlaylist.id);
  });
}

function renderPlaylistMenu() {
  const menu = $("#playlistMenu");
  menu.empty();
  for (const playlist of allPlaylists) {
    if (!playlistHasVideos(playlist)) {
      continue;
    }
    const label = playlist.title || playlist.id;
    const item = $("<button>", {
      type: "button",
      class: "playlist-menu-item",
      role: "menuitem",
      text: label,
    });
    item.data("playlistId", playlist.id);
    if (activePlaylist && playlist.id === activePlaylist.id) {
      item.addClass("active");
    }
    item.on("click", (e) => {
      e.stopPropagation();
      closePlaylistMenu();
      switchPlaylist(playlist);
    });
    menu.append(item);
  }
}

function openPlaylistMenu() {
  playlistMenuOpen = true;
  $("#playlistPickerBtn").attr("aria-expanded", "true");
  $("#playlistMenu").prop("hidden", false);
}

function closePlaylistMenu() {
  playlistMenuOpen = false;
  $("#playlistPickerBtn").attr("aria-expanded", "false");
  $("#playlistMenu").prop("hidden", true);
}

function togglePlaylistMenu() {
  if (playlistMenuOpen) {
    closePlaylistMenu();
  } else {
    closeGridScalerMenu();
    openPlaylistMenu();
  }
}

function maybeShowWallControls() {
  if (wallControlsVisible) {
    return;
  }
  wallControlsVisible = true;
  $("#wallControls").prop("hidden", false);
  updateGridScaleButtons();
}

function closeAllWallMenus() {
  closePlaylistMenu();
  closeGridScalerMenu();
}

async function switchPlaylist(playlist) {
  if (!playlist || !playlistHasVideos(playlist)) {
    return;
  }
  if (activePlaylist && playlist.id === activePlaylist.id) {
    return;
  }
  try {
    await ensureManifestLoaded(playlist);
  } catch (err) {
    console.error("Failed to load playlist manifest:", err);
    return;
  }
  writePlaylistCookie(playlist.id);
  applyActivePlaylist(playlist);
  updatePlaylistMenuSelection();
  console.log("Switched playlist:", activePlaylist.title || activePlaylist.id);

  const cellIds = Object.keys(players);
  if (!cellIds.length) {
    return;
  }
  restartPopcornForCells(cellIds);
}

function closeGridScalerMenu() {
  gridScalerMenuOpen = false;
  $("#gridScalerBtn").attr("aria-expanded", "false");
  $("#gridScalerMenu").prop("hidden", true);
}

function toggleGridScalerMenu() {
  if (gridScalerMenuOpen) {
    closeGridScalerMenu();
  } else {
    closePlaylistMenu();
    gridScalerMenuOpen = true;
    $("#gridScalerBtn").attr("aria-expanded", "true");
    $("#gridScalerMenu").prop("hidden", false);
    updateGridScaleButtons();
  }
}

function computeGridShape(scaleDelta) {
  const bodyH = Math.max(1, Math.floor($("body").height()));
  const bodyW = Math.max(1, Math.floor($("body").width()));
  const baseRows = Math.max(1, Math.round(bodyH / GRID_REF_CELL_HEIGHT));
  const baseCellH = bodyH / baseRows;
  const baseCols = Math.max(1, Math.round(bodyW / (baseCellH * VIDEO_ASPECT)));
  const rowsOut = Math.max(1, baseRows + scaleDelta);
  const colsOut = Math.max(1, baseCols + scaleDelta);
  return { rows: rowsOut, cols: colsOut, cells: rowsOut * colsOut };
}

function isMinGridSize() {
  const shape = computeGridShape(gridScaleDelta);
  return shape.rows <= 1 && shape.cols <= 1;
}

function updateGridScaleButtons() {
  $("#gridScaleDown").prop("disabled", isMinGridSize());
}

function makeCellId() {
  return Number(Math.random().toString().substr(2)).toString(32);
}

function pickRandomIndices(removeCount, size) {
  if (removeCount <= 0 || size <= 0) {
    return [];
  }
  const count = Math.min(removeCount, size);
  const indices = Array.from({ length: size }, (_, i) => i);
  shuffle(indices);
  return indices.slice(0, count).sort((a, b) => a - b);
}

function gridBodyRows() {
  return $("#tableParent tbody tr");
}

function removeColumnAtIndex(colIndex) {
  gridBodyRows().each(function removeColCell() {
    const $cell = $(this).children("td").eq(colIndex);
    const id = $cell.attr("id");
    if (id) {
      destroyPlayer(id);
    }
    $cell.remove();
  });
  cols -= 1;
}

function removeRowAtIndex(rowIndex) {
  const $row = gridBodyRows().eq(rowIndex);
  $row.children("td[id]").each(function destroyRowCell() {
    destroyPlayer(this.id);
  });
  $row.remove();
  rows -= 1;
}

function insertColumnAtRandomPosition() {
  const newIds = [];
  gridBodyRows().each(function insertColCell() {
    const id = makeCellId();
    const $cell = $("<td>", { id });
    const $cells = $(this).children("td");
    const pos = Math.floor(Math.random() * ($cells.length + 1));
    if (pos >= $cells.length) {
      $(this).append($cell);
    } else {
      $cells.eq(pos).before($cell);
    }
    ensureCellChrome(id);
    newIds.push(id);
  });
  cols += 1;
  if (popcornStarted) {
    for (const id of newIds) {
      play(id);
    }
  }
}

function insertRowAtRandomPosition() {
  const $tbody = $("#tableParent tbody");
  const $row = $("<tr>");
  const newIds = [];
  for (let c = 0; c < cols; c++) {
    const id = makeCellId();
    $row.append($("<td>", { id }));
    newIds.push(id);
  }
  const $trs = $tbody.children("tr");
  const pos = Math.floor(Math.random() * ($trs.length + 1));
  if (pos >= $trs.length) {
    $tbody.append($row);
  } else {
    $trs.eq(pos).before($row);
  }
  for (const id of newIds) {
    ensureCellChrome(id);
  }
  rows += 1;
  if (popcornStarted) {
    for (const id of newIds) {
      play(id);
    }
  }
}

function rebuildMapFromDom() {
  const map = [];
  gridBodyRows().each(function mapRow(rowIndex) {
    const row = [];
    $(this).children("td").each(function mapCell(colIndex) {
      row.push({ id: this.id, r: rowIndex, c: colIndex });
    });
    map.push(row);
  });
  if (!t) {
    t = { rows: 0, cols: 0, cells: 0, map: [] };
  }
  t.map = map;
  t.rows = map.length || 1;
  t.cols = map.length && map[0].length ? map[0].length : 1;
  t.cells = t.rows * t.cols;
  rows = t.rows;
  cols = t.cols;
  cells = t.cells;
}

function resolveSoundAfterDomResize() {
  if (soundCell && document.getElementById(soundCell)) {
    const pos = gridPosForCellId(soundCell);
    if (pos) {
      soundGridR = pos.r;
      soundGridC = pos.c;
      syncSoundFromGridPos();
      return;
    }
  }
  soundGridR = 0;
  soundGridC = 0;
  syncSoundFromGridPos();
}

function gridPosForCellId(id) {
  if (!t) {
    return null;
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (t.getID(r, c) === id) {
        return { r, c };
      }
    }
  }
  return null;
}

function syncSoundFromGridPos() {
  if (!t) {
    return;
  }
  soundGridR = Math.min(Math.max(0, soundGridR), rows - 1);
  soundGridC = Math.min(Math.max(0, soundGridC), cols - 1);
  soundCell = t.getID(soundGridR, soundGridC);
  soundLinearIndex = soundGridR * cols + soundGridC;
}

function resizeGridToTarget(tgtRows, tgtCols) {
  if (!t || (tgtRows === rows && tgtCols === cols)) {
    applyCellDimensions();
    return;
  }

  const colsToRemove = pickRandomIndices(Math.max(0, cols - tgtCols), cols);
  const rowsToRemove = pickRandomIndices(Math.max(0, rows - tgtRows), rows);

  for (let i = colsToRemove.length - 1; i >= 0; i--) {
    removeColumnAtIndex(colsToRemove[i]);
  }
  for (let i = rowsToRemove.length - 1; i >= 0; i--) {
    removeRowAtIndex(rowsToRemove[i]);
  }

  const colsToAdd = tgtCols - cols;
  for (let i = 0; i < colsToAdd; i++) {
    insertColumnAtRandomPosition();
  }

  const rowsToAdd = tgtRows - rows;
  for (let i = 0; i < rowsToAdd; i++) {
    insertRowAtRandomPosition();
  }

  rebuildMapFromDom();
  resolveSoundAfterDomResize();
  syncSoundFocusUi();
  applyCellDimensions();

  for (const id of Object.keys(players)) {
    fitPlayerCover(id);
  }

  updateGridScaleButtons();
}

function applyGridShape() {
  const shape = computeGridShape(gridScaleDelta);
  if (!t) {
    rows = shape.rows;
    cols = shape.cols;
    cells = shape.cells;
    t = new table("tableParent", rows, cols);
    mountGridCells();
    updateGridScaleButtons();
    return;
  }
  resizeGridToTarget(shape.rows, shape.cols);
}

function mountGridCells() {
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      t.set(r, c, cellMarkup(t.getID(r, c)));
    }
  }
  applyCellDimensions();
}

function scaleGridUp() {
  gridScaleDelta += 1;
  applyGridShape();
}

function scaleGridDown() {
  if (isMinGridSize()) {
    return;
  }
  gridScaleDelta -= 1;
  applyGridShape();
}

function initWallControls() {
  $("#playlistPickerBtn").on("click", (e) => {
    e.stopPropagation();
    unlockAutoplay();
    togglePlaylistMenu();
  });

  $("#gridScalerBtn").on("click", (e) => {
    e.stopPropagation();
    unlockAutoplay();
    toggleGridScalerMenu();
  });

  $("#gridScaleUp").on("click", (e) => {
    e.stopPropagation();
    scaleGridUp();
  });

  $("#gridScaleDown").on("click", (e) => {
    e.stopPropagation();
    scaleGridDown();
  });

  $(document).on("click", () => {
    closeAllWallMenus();
  });

  $("#playlistMenu, #gridScalerMenu").on("click", (e) => {
    e.stopPropagation();
  });
}

function randVid(excludeId) {
  let pool = allVids;
  if (excludeId && pool.length > 1) {
    pool = pool.filter((v) => v !== excludeId);
  }
  return shuffle(pool.slice())[0];
}

function ensureCellChrome(id) {
  const cell = $("#" + id);
  if (!cell.find(".vid").length) {
    cell.append(cellMarkup(id));
  }
  if (!cell.find(".toob").length) {
    cell.prepend('<div id="' + id + '_toob" class="toob"></div>');
  }
}

function markCellHealthy(id) {
  cellLastHealthy[id] = Date.now();
}

function resetCellPlaybackState(id) {
  delete cellLastTime[id];
  delete cellRevealed[id];
  delete cellStallHits[id];
  delete cellStartHits[id];
  delete cellPlayKicks[id];
  delete cellLastKick[id];
}

function videoAspectForCell(id) {
  const videoId = cellLastVideo[id];
  if (videoId && videoAspectById[videoId]) {
    return videoAspectById[videoId];
  }
  return VIDEO_ASPECT;
}

function revealCell(id) {
  if (cellRevealed[id]) {
    return;
  }
  cellRevealed[id] = true;
  cellRetries[id] = 0;
  markCellHealthy(id);
  $("#" + id + "_toob").addClass("faded");
  fitPlayerCover(id);
  requestAnimationFrame(() => {
    fitPlayerCover(id);
    requestAnimationFrame(() => {
      fitPlayerCover(id);
      $("#" + id + "_vid").addClass("is-playing");
    });
  });
  syncSoundFocusUi();
  maybeShowWallControls();
}

function scheduleCoverFit(id) {
  [0, 60, 150, 300].forEach((delay) => {
    setTimeout(() => fitPlayerCover(id), delay);
  });
}

function fitPlayerCover(id) {
  const player = players[id];
  if (!player || typeof player.getIframe !== "function") {
    return;
  }
  const iframe = player.getIframe();
  if (!iframe) {
    return;
  }
  const cw = $("#" + id).innerWidth();
  const ch = $("#" + id).innerHeight();
  if (!cw || !ch) {
    return;
  }
  const videoAspect = videoAspectForCell(id);
  const cellAspect = cw / ch;
  let w;
  let h;
  if (cellAspect > videoAspect) {
    w = cw;
    h = cw / videoAspect;
  } else {
    h = ch;
    w = ch * videoAspect;
  }
  const coverScale = Math.max(cw / w, ch / h, 1) * COVER_OVERSCAN;
  w *= coverScale;
  h *= coverScale;
  $(iframe).css({
    position: "absolute",
    left: (cw - w) / 2,
    top: (ch - h) / 2,
    width: w,
    height: h,
    maxWidth: "none",
    maxHeight: "none",
    border: 0,
    transform: "none",
  });
}

function kickPlayback(id, reason) {
  const player = players[id];
  if (!player || typeof player.playVideo !== "function") {
    return false;
  }
  const now = Date.now();
  if (now - (cellLastKick[id] || 0) < KICK_COOLDOWN_MS) {
    return false;
  }
  cellLastKick[id] = now;
  cellPlayKicks[id] = (cellPlayKicks[id] || 0) + 1;
  if (cellPlayKicks[id] > MAX_AUTOPLAY_KICKS) {
    console.warn("Autoplay kicks exhausted:", id, reason);
    rotateCell(id, reason);
    return true;
  }
  markCellHealthy(id);
  player.playVideo();
  return true;
}

function retryCell(id, reason) {
  cellRetries[id] = (cellRetries[id] || 0) + 1;
  if (cellRetries[id] > MAX_CELL_RETRIES) {
    console.warn("Cell gave up after retries:", id, reason);
    return;
  }
  play(id);
}

function rotateCell(id, reason) {
  cellRetries[id] = 0;
  play(id);
}

function setPlayerAudible(id, audible) {
  const player = players[id];
  if (!player) {
    return;
  }
  if (audible) {
    if (typeof player.unMute === "function") {
      player.unMute();
    }
    if (typeof player.setVolume === "function") {
      player.setVolume(100);
    }
  } else if (typeof player.mute === "function") {
    player.mute();
  } else if (typeof player.setVolume === "function") {
    player.setVolume(0);
  }
}

function syncSoundFocusUi() {
  $("td").removeClass("glow");
  if (soundCell && soundEnabled) {
    $("#" + soundCell).addClass("glow");
  }
}

function muteCellAudio(id) {
  if (!id || !players[id]) {
    return;
  }
  fadeOut(id);
  setPlayerAudible(id, false);
  $("#" + id).removeClass("glow");
}

function unMuteCellAudio(id) {
  if (!id || !players[id]) {
    return;
  }
  fadeIn(id);
  setPlayerAudible(id, true);
  $("#" + id).addClass("glow");
}

function applySoundCellIfReady() {
  if (!autoplayUnlocked || !soundCell || !soundEnabled || !players[soundCell]) {
    return;
  }
  unMuteCellAudio(soundCell);
}

/** Unlocks audible YouTube embeds after a user gesture (cell click). Does not play tune-in. */
function unlockAutoplay() {
  if (autoplayUnlocked) {
    return;
  }
  autoplayUnlocked = true;
  applySoundCellIfReady();
}

function tryPlayTuneIn() {
  const tune = document.getElementById("tuneSound");
  if (!tune) {
    return;
  }
  tune.play().then(() => unlockAutoplay()).catch(() => {});
}

function handleToobClick(id) {
  if (!id || !players[id]) {
    return;
  }
  unlockAutoplay();

  if (soundCell === id && soundEnabled) {
    muteCellAudio(id);
    soundEnabled = false;
    return;
  }

  if (soundCell && soundCell !== id) {
    muteCellAudio(soundCell);
  }

  soundCell = id;
  const pos = gridPosForCellId(id);
  if (pos) {
    soundGridR = pos.r;
    soundGridC = pos.c;
    syncSoundFromGridPos();
  }
  soundEnabled = true;
  unMuteCellAudio(id);
}

function fadeOut(id) {
  if (!players[id] || typeof players[id].getVolume !== "function") {
    return;
  }
  const vol = players[id].getVolume();
  if (vol > 33) {
    players[id].setVolume(vol - 33);
    setTimeout(fadeOut, 200, id);
  } else {
    players[id].setVolume(0);
  }
}

function fadeIn(id) {
  if (!players[id] || typeof players[id].getVolume !== "function") {
    return;
  }
  const vol = players[id].getVolume();
  if (vol < 66) {
    players[id].setVolume(vol + 33);
    setTimeout(fadeIn, 100, id);
  } else {
    players[id].setVolume(100);
  }
}

function destroyPlayer(id) {
  const player = players[id];
  if (player && typeof player.destroy === "function") {
    try {
      player.destroy();
    } catch (err) {
      /* player may already be torn down */
    }
  }
  delete players[id];
  delete cellLastHealthy[id];
  resetCellPlaybackState(id);
}

function isNearVideoEnd(player) {
  if (typeof player.getDuration !== "function" || typeof player.getCurrentTime !== "function") {
    return false;
  }
  const duration = player.getDuration();
  const time = player.getCurrentTime();
  if (duration <= 0 || time < healthCfg.minPlayBeforeNearEndSec) {
    return false;
  }
  return time >= duration - 1;
}

function play(id) {
  destroyPlayer(id);
  ensureCellChrome(id);
  $("#" + id + "_toob").removeClass("faded");
  $("#" + id + "_vid").empty().removeClass("is-playing").addClass("has-player");
  resetCellPlaybackState(id);

  const previous = cellLastVideo[id];
  const video = randVid(previous);
  cellLastVideo[id] = video;

  players[id] = new YT.Player(id + "_vid", {
    videoId: video,
    playerVars: {
      ...PLAYER_VARS,
      mute: 1,
    },
    events: {
      onReady: onPlayerReady,
      onStateChange: onPlayerStateChange,
      onError: vidError,
    },
  });
}

function playNext(event, id) {
  if (id === undefined && event && event.target && event.target.a) {
    id = cellIdFromEvent(event);
  }
  if (id) {
    rotateCell(id, "play-next");
  }
}

function onPlayerReady(event) {
  const id = cellIdFromEvent(event);
  setPlayerAudible(id, false);
  fitPlayerCover(id);
  scheduleCoverFit(id);
  event.target.playVideo();
  if (id === soundCell) {
    syncSoundFocusUi();
    applySoundCellIfReady();
  }
}

function onPlayerStateChange(event) {
  const id = cellIdFromEvent(event);
  const player = event.target;
  switch (event.data) {
    case YT.PlayerState.PLAYING:
      cellPlayKicks[id] = 0;
      fitPlayerCover(id);
      break;
    case YT.PlayerState.BUFFERING:
      fitPlayerCover(id);
      break;
    case YT.PlayerState.ENDED:
      rotateCell(id, "ended");
      break;
    case YT.PlayerState.PAUSED:
      if (isNearVideoEnd(player)) {
        rotateCell(id, "paused-at-end");
      }
      break;
  }
}

function vidError(event) {
  const id = cellIdFromEvent(event);
  const code = event.data;
  retryCell(id, YT_ERROR_CODES.has(code) ? "yt-error-" + code : "yt-error");
}

function pollCellTime(id, player) {
  if (typeof player.getCurrentTime !== "function") {
    return;
  }
  const time = player.getCurrentTime();
  const prev = cellLastTime[id];

  if (time > 0) {
    if (!cellRevealed[id]) {
      revealCell(id);
    }
    const state = player.getPlayerState();
    const timeFrozen =
      prev !== undefined
      && Math.abs(time - prev) < healthCfg.stallEpsilon
      && !isNearVideoEnd(player);
    if (timeFrozen && state === YT.PlayerState.PLAYING) {
      cellStallHits[id] = (cellStallHits[id] || 0) + 1;
      if (cellStallHits[id] >= healthCfg.stallSamples) {
        rotateCell(id, "time-frozen");
        return;
      }
    } else {
      cellStallHits[id] = 0;
      markCellHealthy(id);
    }
    cellStartHits[id] = 0;
  } else if (!cellRevealed[id]) {
    const state = player.getPlayerState();
    if (state === YT.PlayerState.BUFFERING || state === YT.PlayerState.CUED) {
      cellStartHits[id] = 0;
      markCellHealthy(id);
    } else if (
      state === YT.PlayerState.UNSTARTED
      || state === YT.PlayerState.PAUSED
    ) {
      cellStartHits[id] = 0;
      kickPlayback(id, "autoplay-stuck-" + state);
    } else {
      cellStartHits[id] = (cellStartHits[id] || 0) + 1;
      if (cellStartHits[id] >= healthCfg.noProgressSamples) {
        rotateCell(id, "time-never-started");
        return;
      }
    }
  }

  cellLastTime[id] = time;
}

function monitorCells() {
  for (const id of Object.keys(players)) {
    const player = players[id];
    if (!player || typeof player.getPlayerState !== "function") {
      continue;
    }
    const state = player.getPlayerState();

    pollCellTime(id, player);

    if (state === YT.PlayerState.ENDED) {
      rotateCell(id, "monitor-ended");
      continue;
    }

    if (isNearVideoEnd(player)) {
      rotateCell(id, "monitor-near-end");
      continue;
    }

    if (state === YT.PlayerState.PAUSED && isNearVideoEnd(player)) {
      rotateCell(id, "monitor-paused-end");
      continue;
    }

    if (cellRevealed[id]) {
      continue;
    }

    if (state === YT.PlayerState.BUFFERING || state === YT.PlayerState.CUED) {
      markCellHealthy(id);
      continue;
    }

    if (
      !cellRevealed[id]
      && (state === YT.PlayerState.UNSTARTED || state === YT.PlayerState.PAUSED)
    ) {
      kickPlayback(id, "monitor-autoplay-" + state);
      continue;
    }

    const lastHealthy = cellLastHealthy[id] || 0;
    const idleMs = Date.now() - lastHealthy;
    if (idleMs > healthCfg.stalePlaybackMs) {
      retryCell(id, "monitor-stale-" + state);
    } else if (idleMs > healthCfg.playbackTimeoutMs && (cellStartHits[id] || 0) >= 2) {
      retryCell(id, "monitor-timeout");
    }
  }
}

function startCellMonitor() {
  if (cellMonitorStarted) {
    return;
  }
  cellMonitorStarted = true;
  setInterval(monitorCells, healthCfg.monitorMs);
}

function clearPopcornSchedule() {
  popcornScheduleGeneration += 1;
  for (const timerId of popcornTimers) {
    clearTimeout(timerId);
  }
  popcornTimers.length = 0;
}

function schedulePopcornPlays(cellIds) {
  const generation = popcornScheduleGeneration;
  const schedule = cellIds.map((id) => ({
    id,
    delay: Math.random() * POPCORN_MS,
  }));
  schedule.sort((a, b) => a.delay - b.delay);

  for (const { id, delay } of schedule) {
    const timerId = setTimeout(() => {
      if (generation !== popcornScheduleGeneration) {
        return;
      }
      play(id);
    }, delay);
    popcornTimers.push(timerId);
  }
}

function restartPopcornForCells(cellIds) {
  if (!cellIds.length) {
    return;
  }
  clearPopcornSchedule();
  schedulePopcornPlays(cellIds);
}

function startPopcorn() {
  if (popcornStarted) {
    return;
  }
  popcornStarted = true;
  startCellMonitor();

  const indices = Array.from({ length: cells }, (_, i) => i);
  soundLinearIndex = shuffle(indices.slice())[0];
  soundGridR = Math.floor(soundLinearIndex / cols);
  soundGridC = soundLinearIndex % cols;
  syncSoundFromGridPos();
  soundEnabled = true;
  syncSoundFocusUi();

  const cellIds = indices.map((index) => t.idLinear(index));
  schedulePopcornPlays(cellIds);

  setTimeout(maybeShowWallControls, POPCORN_MS + 500);
}

function loadYouTubeApi() {
  const po = document.createElement("script");
  po.type = "text/javascript";
  po.async = true;
  po.src = "https://www.youtube.com/iframe_api";
  const s = document.getElementsByTagName("script")[0];
  s.parentNode.insertBefore(po, s);
}

function onYouTubeIframeAPIReady() {
  startPopcorn();
}

function finishBootSequence() {
  if (bootFinished) {
    return;
  }
  bootFinished = true;

  $("#tuneIn")
    .removeClass("doTuneIn faded")
    .addClass("static-underlay");

  $("#tableParent").addClass("grid-visible");
  setTimeout(loadYouTubeApi, STATIC_BEAT_MS);
}

function beginTuneIn() {
  tryPlayTuneIn();

  $("#tuneSound").on("play", () => {
    unlockAutoplay();
    if (!tunedIn) {
      $("#tuneIn").addClass("doTuneIn");
    }
    tunedIn = true;
  });

  setTimeout(() => {
    if (!tunedIn) {
      $("#tuneIn").addClass("doTuneIn");
    }
    tunedIn = true;
  }, 300);

  const tune = document.getElementById("tuneIn");
  const onTuneEnd = (event) => {
    if (event.animationName !== "tvPowerOn") {
      return;
    }
    tune.removeEventListener("animationend", onTuneEnd);
    finishBootSequence();
  };
  tune.addEventListener("animationend", onTuneEnd);
  setTimeout(finishBootSequence, TUNEIN_ANIM_MS + 100);
}

function applyCellDimensions() {
  const bodyH = Math.floor($("body").height());
  const bodyW = Math.floor($("body").width());
  const baseRow = Math.floor(bodyH / rows);
  const baseCol = Math.floor(bodyW / cols);
  const remH = bodyH - baseRow * rows;
  const remW = bodyW - baseCol * cols;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const id = t.getID(r, c);
      const h = baseRow + (r === rows - 1 ? remH : 0);
      const w = baseCol + (c === cols - 1 ? remW : 0);
      $("#" + id).css({ height: h, width: w });
      fitPlayerCover(id);
    }
  }
}

function buildGrid() {
  const shape = computeGridShape(gridScaleDelta);
  rows = shape.rows;
  cols = shape.cols;
  cells = shape.cells;
  t = new table("tableParent", rows, cols);
  mountGridCells();
  soundGridR = 0;
  soundGridC = 0;
  syncSoundFromGridPos();
  updateGridScaleButtons();
}

function handleWindowResize() {
  if (resizeDebounceTimer) {
    clearTimeout(resizeDebounceTimer);
  }
  resizeDebounceTimer = setTimeout(() => {
    resizeDebounceTimer = null;
    const shape = computeGridShape(gridScaleDelta);
    if (!t) {
      buildGrid();
      return;
    }
    if (shape.rows !== rows || shape.cols !== cols) {
      resizeGridToTarget(shape.rows, shape.cols);
      return;
    }
    applyCellDimensions();
  }, RESIZE_DEBOUNCE_MS);
}

function initWall() {
  hideLoading();

  $(document).on("click", ".toob", (e) => {
    const id = $(e.currentTarget).closest("td").attr("id");
    handleToobClick(id);
  });

  $(window).on("resize", handleWindowResize);

  buildGrid();
  initWallControls();
  beginTuneIn();
}

fetch(POOL_URL)
  .then((response) => {
    if (!response.ok) {
      throw new Error("HTTP " + response.status + " loading " + POOL_URL);
    }
    return response.json();
  })
  .then(async (data) => {
    const legacy = isLegacyPool(data);
    if (legacy) {
      loadPoolLegacy(data);
    } else {
      loadPoolIndex(data);
    }
    await activateInitialPlaylist(data, legacy);
    initWall();
  })
  .catch((err) => {
    showPoolError(
      "Could not load video pool. Run: python scripts/build_feeds.py — " + err.message
    );
  });
