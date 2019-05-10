// Table
var baseHeight = 240;
var baseWidth = 320;
var rows = Math.ceil($('body').height() / baseHeight);
var cols = Math.ceil($('body').width() / baseWidth);
var cells = rows * cols;
var t = new table('tableParent', rows,cols);
var parser = new RSSParser();
const CORS_PROXY = "https://cors-anywhere.herokuapp.com/"
var players = {};
var soundCell = false;
var feeds = [
  'PL02LhVHOr0eCzWByeX2gHSLA4zCgDaUcd',
  'PL1318A97FDFB405C7',
  'PL1AeKO_GzwBBeYvVCcEt5DurEHBzx-X6E',
  'PL1C494D754EA8475F',
  'PL2776B5E3711B8338',
  'PL2HEDIx6Li8j_jT8JI90WmXeQ657UUKSH',
  'PL2NUgx01KXINGDWZEH7suDv8xyIoum3FP',
  'PL36384B2DAC7D315B',
  'PL5BtCWdAny03GzqXbLsuDsSbK_1uSMNF2',
  'PL5RwN4-BVR1Lu3JkaYv8JFy-xUY9iFZRh',
  'PL7_Q_mRk-hW8ZNRqnrUEzieoIUJ3MhO6a',
  'PL8AB73568A024A458',
  'PL9996BE0C3C64E92E',
  'PL9HVvEQXdWVaGzUP3ieExFQ6X-KzU2p7z',
  'PLAEQD0ULngi67rwmhrkNjMZKvyCReqDV4',
  'PLB7DBFEE942B1583A',
  'PLEBA54137F212640D',
  'PLEWHGtSTRB-FCMpNzL5pQ_3GXYMq-Ai8S',
  'PLEu62FRB9Fxz6ysHnmzBrXugt9UG32lvv',
  'PLEwKmtcft8I_73ekmYLe_nKZA-gkQKfUo',
  'PLF40625A3A2F90B4B',
  'PLG_4mz3l5B2H7iMfPoiNuPbhAglu_lVB-',
  'PLHK0G-RO-wVqzUv55rieH43qLUkNo5SwJ',
  'PLI7BNfpVTvskliZbPyk0P9NzskkaRY5TR',
  'PLIql-6gQAj_razMHNS3gOMzMCvQZ1Arkh',
  'PLJgEVV_uaV5r6tCbi6dzSNHRoQ8sf1MuT',
  'PLMTp9RfQQN7OhFNnMN_VP60wRenSeBaTn',
  'PLQSe03l3Dk-kIb8Nz1GxZ2ApIiN2srw71',
  'PLQZC74AYy7TO_DGodbWQMkR5XxlAxngTJ',
  'PLR4pl38PnQomU4n8hv8O7gX3s6fTqp1OL',
  'PLSHw43gweakP9jWlvFNl7Zm3UQigEZWbE',
  'PLSWhlpTC-l5Gv9zMl_nAVeC0bCx0EgWfj',
  'PLTOMHeKhfLingODNtYygngllSB89jYIRg',
  'PLTXQuaxXBKKx9U04UVXK0ketpBFSCKBbg',
  'PLUs3FEEE2J3nAeayX0MCg-KY00nZayxGn',
  'PLUs3FEEE2J3nY74E81vv9hxWPxUJs885a',
  'PLV8WH6IVZxa8S1AdMelHPQdBeVkoirBnX',
  'PLXhtEIhekVwUSrRWMqHu7wSxRzvOhjUHA',
  'PLZfhJbHjDHamRH300QWhhjE2Z0P0E_NPo',
  'PLbDtFvoBybyxcXJ5VrZ2ERUcboT9c9TlC',
  'PLe8-X14_s3A8pfEUIX7K9UXBqrftchd9H',
  'PLjNhZb2G5ZVigPx3OQn8s1PDyId9fywpO',
  'PLkuWMWdvCcT2ZHtEqQvab4aE34FAIrYUn',
  'PLmNiCGaOQDewerLinorpprY1gmRn9qDrQ',
  'PLomb3VSQH7wg2NixpgeneAWhBp74RHx0b',
  'PLq7JnVtvfZsXizd3OIL02JKkwJ_jmNKbW',
  'PLzYeG2eBkuklNTE_gp9LLs_QnvPnkq2ai',
];
var allVids = [];
$('#loading').value = "20";
$(document).on("click",".toob",(e) => {
  id = $(e.target).parent().attr('id');
  ga('send', 'event', 'video', 'click', players[id].getVideoData().video_id);
  mute(soundCell);
  soundCell = id;
  unMute(soundCell);
});

setInterval(() => {
  ga('send', 'event', 'site', 'minuteWatched', 'cells', cells);
}, 1000 * 60);

var tunedIn = false;
$("#tuneSound").on("play", () => {
  if(tunedIn === false) {
    $("#tuneIn").addClass("doTuneIn");
  }
  tunedIn = true;
});

setTimeout(() => {
  if(tunedIn === false) {
    $("#tuneIn").addClass("doTuneIn");
  }
  tunedIn = true;
},2000);

var i = 0;
console.log("Loading playlists from  youtube...");

for(let feedID of feeds) {
  $('#loading').value = (i+1) / cells;
  //feed = 'http://www.feedsifter.com/?filters=.&feed=https%3A%2F%2Fwww.youtube.com%2Ffeeds%2Fvideos.xml%3Fplaylist_id%3D' + feedID;
  feed = CORS_PROXY + 'https://www.youtube.com/feeds/videos.xml?playlist_id=' + feedID;
  parser.parseURL(feed, (err, parsed) => {
    if(parsed === undefined) {
      console.log("Skipping bad playlist " + feed);
      return;
    }
    console.log("Loaded:", parsed.title, "\n"+feedID);
    parsed.items.forEach((entry) => {
      allVids.push(entry.link.replace('https://www.youtube.com/watch?v=', ''));
      i++;
    })
  })
}

new Promise((resolve, reject) => {
  for(let r = 0; r < rows; r++) {
    for(let c = 0; c < cols; c++) {
      let id = t.getID(r,c);
      t.set(r, c, '<div id="' + id +'_vid" class="vid" style="filter: alpha(opacity=5);width:100%;height:100%"></div>');
      setTimeout(static, Math.random() * 1000, id);
    }
  }
  resolve();
})

// Don't start the vid loadout until after the images are placed
setTimeout(() => {
    $("#tuneIn").addClass("faded").remove();
    var po = document.createElement('script');
    po.type = 'text/javascript';
    po.async = true;
    po.src = 'https://www.youtube.com/iframe_api';
    var s = document.getElementsByTagName('script')[0]; s.parentNode.insertBefore(po, s);
},500 * cells);


function static(id) {
  $("#"+id)
    // .addClass('toob')
    .css('background-position', Math.random() * 100 + "% " + Math.random() * 100 + "%");
}

function shuffle(o){
    for(var j, x, i = o.length; i; j = Math.floor(Math.random() * i), x = o[--i], o[i] = o[j], o[j] = x);
    return o;
};

function onYouTubeIframeAPIReady() {
  $('#loading').addClass('done');
  setTimeout(()=>$('#loading').hide(), 2000);
  soundCell = t.idLinear(Math.floor(Math.random() * cells));
  for(let i = 0; i < cells; i++) {
    let id = t.idLinear(i);
    play(id);
  }
}

var playing = 0;
function onPlayerReady(event) {
  if($(event.target.a).parent().attr("id") != soundCell) {
    mute($(event.target.a).parent().attr("id"));
    setTimeout(() => {event.target.playVideo()}, Math.random() * cells * 2000);
  } else {
    event.target.playVideo();
  }
  // jQuery(event.target.a).show();
  // jQuery(event.target.a).parent().removeClass('toob');
  let id = $(event.target.a).parent().attr("id");
  setInterval((id) => {
    // Check in occasionally to ensure the frame isn't hung
    // console.log("Checking in on vid",id, players[id].getPlayerState());
    if(players[id].getPlayerState() < 1) {
      console.log("Unsticking",id);
      playNext(null, id);
    }
  },10000, id);
}

var done = false;
function onPlayerStateChange(event) {
/*
  -1 UNSTARTED
  0 ENDED
  1 PLAYING
  2 PAUSED
  3 BUFFERING
  5 CUED
*/
  let id = $(event.target.a).parent().attr("id");
  // console.log("EVENT",id,event.data);
  if (event.data == YT.PlayerState.PLAYING) {
    $("#" + id + "_toob").addClass('faded');
    $("#" + id + "_vid").children().height($("#" + id).height());
    if(!$("#"+soundCell).hasClass("glow")) {
      $("#"+soundCell).addClass("glow");
    }
    ga('send', 'event', 'video', 'play', event.target.getVideoData().video_id, {nonInteraction: true});
  }
  if (event.data == YT.PlayerState.ENDED) {
    playNext(event);
  }
}

function vidError(event) {
  console.log("Vid Error", event);
  let id = $(event.target.a).parent().attr("id");
  ga('send', 'event', 'video', 'error', event.target.getVideoData().video_id, {nonInteraction: true});
  playNext(event);
}

function play(id) {
console.log("Playing " + id);
  delete players[id];
  $("#"+id).html('<div id="' + id +'_toob" class="toob"></div><div id="' + id +'_vid" class="vid" style="width:100%;height:100%"></div>');
  $("#" + id + "_toob").removeClass('faded');
  let video = randVid();
  let player = new YT.Player( id + '_vid', {
    videoId: video,
    playerVars: {
      autoplay: 0,
      controls: 0,
      suggestedQuality: 'small'
    },
    events: {
      'onReady': onPlayerReady,
      'onStateChange': onPlayerStateChange,
      'onError': vidError
    }
  });
  players[id] = player;
}

function playNext(event, id) {
  id = id === undefined ? $(event.target.a).parent().attr("id") : id;
  play(id);
}

function stopVideo() {
  for(let i of Object.keys(players)) {
    players[i].stopVideo();
  }
}

function randVid() {
  return shuffle(allVids)[0];
}

function mute(id) {
  fadeOut(id);
  $("#"+id+"_toob").removeClass("clickThru");
  $("#"+id).removeClass("glow");
}

function unMute(id) {
  fadeIn(id);
  $("#"+id+"_toob").addClass("clickThru");
  $("#"+id).addClass("glow");
}

function fadeOut(id) {
  if(typeof players[id].getVolume != 'function') {
    return;
  }
  let vol = players[id].getVolume();
  if(vol > 33) {
    players[id].setVolume(vol - 33);
    setTimeout(fadeOut,200,id);
  } else {
    players[id].setVolume(0);
  }
}

function fadeIn(id) {
  let vol = players[id].getVolume();
  if(vol < 66) {
    players[id].setVolume(vol + 33);
    setTimeout(fadeIn,100,id);
  } else {
    players[id].setVolume(200);
  }
}
