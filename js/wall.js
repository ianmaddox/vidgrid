let allVids = [];
const players = {};
let soundCell = false;
let tunedIn = false;
let popcornStarted = false;
let t;
let rows;
let cols;
let cells;
let rowHeight;
let cellWidth;

const POOL_URL = "data/video-pool.json";
const POPCORN_MS = 10000;
const TUNEIN_ANIM_MS = 3200;

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

function cellMarkup(id) {
  return (
    '<div id="' + id + '_toob" class="toob"></div>' +
    '<div id="' + id + '_vid" class="vid"></div>'
  );
}

function staticOverlay(id) {
  const toob = $("#" + id + "_toob");
  toob
    .removeClass("faded clickThru")
    .css("background-position", Math.random() * 100 + "% " + Math.random() * 100 + "%");
}

function randVid() {
  return shuffle(allVids.slice())[0];
}

function mute(id) {
  if (!id || !players[id] || typeof players[id].getVolume !== "function") {
    return;
  }
  fadeOut(id);
  $("#" + id + "_toob").removeClass("clickThru");
  $("#" + id).removeClass("glow");
}

function unMute(id) {
  if (soundCell === id) {
    return;
  }
  if (soundCell) {
    mute(soundCell);
  }
  soundCell = id;
  fadeIn(id);
  $("#" + id + "_toob").addClass("clickThru");
  $("#" + id).addClass("glow");
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

function play(id) {
  delete players[id];
  $("#" + id).removeClass("toob").html(cellMarkup(id));
  staticOverlay(id);
  const video = randVid();
  const muted = id !== soundCell;
  players[id] = new YT.Player(id + "_vid", {
    videoId: video,
    playerVars: {
      autoplay: 1,
      mute: muted ? 1 : 0,
      controls: 0,
      modestbranding: 1,
      rel: 0,
      playsinline: 1,
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
    id = $(event.target.a).parent().attr("id");
  }
  if (id) {
    play(id);
  }
}

function onPlayerReady(event) {
  const id = $(event.target.a).parent().attr("id");
  if (id !== soundCell) {
    if (typeof event.target.mute === "function") {
      event.target.mute();
    } else {
      event.target.setVolume(0);
    }
  }
  event.target.playVideo();

  setInterval(() => {
    if (!players[id] || typeof players[id].getPlayerState !== "function") {
      return;
    }
    if (players[id].getPlayerState() < 1) {
      console.log("Unsticking", id);
      playNext(null, id);
    }
  }, 10000);
}

function onPlayerStateChange(event) {
  const id = $(event.target.a).parent().attr("id");
  switch (event.data) {
    case YT.PlayerState.PLAYING:
      $("#" + id + "_toob").addClass("faded");
      $("#" + id + "_vid").children().height($("#" + id).height());
      if (soundCell && !$("#" + soundCell).hasClass("glow")) {
        $("#" + soundCell).addClass("glow");
      }
      break;
    case YT.PlayerState.ENDED:
      playNext(event);
      break;
  }
}

function vidError(event) {
  console.log("Vid Error", event);
  playNext(event);
}

function startPopcorn() {
  if (popcornStarted) {
    return;
  }
  popcornStarted = true;

  const indices = Array.from({ length: cells }, (_, i) => i);
  soundCell = t.idLinear(shuffle(indices.slice())[0]);

  const schedule = indices.map((index) => ({
    index,
    delay: Math.random() * POPCORN_MS,
  }));
  schedule.sort((a, b) => a.delay - b.delay);

  for (const { index, delay } of schedule) {
    setTimeout(() => {
      const id = t.idLinear(index);
      staticOverlay(id);
      play(id);
    }, delay);
  }
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

function beginTuneIn() {
  $("#tuneSound").on("play", () => {
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
  }, 400);

  setTimeout(dismissTuneIn, TUNEIN_ANIM_MS);
}

function dismissTuneIn() {
  const tune = $("#tuneIn");
  tune.addClass("faded");
  setTimeout(() => {
    tune.css("display", "none");
    tune.remove();
    loadYouTubeApi();
  }, 600);
}

function initWall() {
  hideLoading();

  const baseHeight = 300;
  const baseWidth = 300;
  rows = Math.ceil($("body").height() / baseHeight);
  cols = Math.ceil($("body").width() / baseWidth);
  rowHeight = Math.floor($("body").height() / rows) + "px";
  cellWidth = Math.floor($("body").width() / cols) + "px";
  cells = rows * cols;
  t = new table("tableParent", rows, cols);

  $(document).on("click", ".toob", (e) => {
    const id = $(e.target).closest("td").attr("id") || $(e.target).parent().attr("id");
    unMute(id);
  });

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const id = t.getID(r, c);
      $("#" + id).css("height", rowHeight);
      $("#" + id).css("width", cellWidth);
      t.set(r, c, cellMarkup(id));
      staticOverlay(id);
    }
  }

  beginTuneIn();
}

fetch(POOL_URL)
  .then((response) => {
    if (!response.ok) {
      throw new Error("HTTP " + response.status + " loading " + POOL_URL);
    }
    return response.json();
  })
  .then((data) => {
    if (!data.videoIds || data.videoIds.length === 0) {
      throw new Error("video-pool.json has no videoIds — run: python scripts/build_feeds.py");
    }
    allVids = data.videoIds;
    console.log("Loaded", allVids.length, "videos from pool (generated", data.generatedAt, ")");
    initWall();
  })
  .catch((err) => {
    showPoolError(
      "Could not load video pool. Run: python scripts/build_feeds.py — " + err.message
    );
  });
