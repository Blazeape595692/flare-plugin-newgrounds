// Newgrounds adapter for Flare Social Plugin API v1.
//
// Newgrounds has no public API for its portals, so this reads the same pages the
// website loads: listing and search endpoints return JSON (wrapping HTML) when sent
// "X-Requested-With: XMLHttpRequest", and content pages carry Open Graph/schema.org
// metadata. Everything is public, read-only browsing on https://www.newgrounds.com.
//
// Limits: Flare only lets an account call the address it was added with, and user
// pages live on <name>.newgrounds.com subdomains, so per-user post lists aren't
// available. Newgrounds hides its login cookies from scripts, so there is no real
// sign-in: you pick the username to browse as, and actions (favourite, follow,
// voting) aren't supported.

var ORIGIN = "https://www.newgrounds.com";

var NG_CAPABILITIES = {
  "flare.datasource.timeline/v1": ["page"],
  "flare.datasource.post/v1": ["detail"],
  "flare.datasource.profile/v1": ["byId", "byHandle"],
  "flare.datasource.search/v1": ["posts", "profiles", "discoverPosts", "discoverProfiles", "discoverHashtags"],
};

// Timeline id -> listing path (paged with ?offset=N&inner=1).
var LISTINGS = {
  movies: "/movies/featured",
  "movies-latest": "/movies/browse?interval=all&sort=date",
  games: "/games/featured",
  art: "/art/featured",
  audio: "/audio/featured",
};

defineFlareSocialPlugin({
  // Flare offers a plugin on its add-account screen only when this recognizes the typed address.
  detector: {
    async detect(request, context) {
      var origin = String(request.origin || context.origin);
      var host = origin.replace(/^https:\/\//i, "").replace(/\/+$/, "").toLowerCase();
      if (host !== "www.newgrounds.com") return { match: "none", canonicalOrigin: origin };
      return { match: "exact", canonicalOrigin: origin, software: "Newgrounds", instance: { domain: host, title: "Newgrounds" } };
    },
  },

  login: {
    browse: {
      async begin(request, context) {
        requireNgOrigin(context.origin);
        var name = cleanHandle((request.values || {}).username);
        if (!name) validationError("Enter your Newgrounds username");
        var profile = await findUser(context, name);
        if (!profile) validationError("No Newgrounds user is called \"" + name + "\"");
        return {
          type: "success",
          value: {
            accountId: profile.key.id,
            origin: context.origin,
            credential: { username: profile.displayName },
            profile: profile,
            capabilities: NG_CAPABILITIES,
          },
        };
      },
    },
  },

  capabilities: {
    timeline: {
      async page(request, context) {
        var path = LISTINGS[request.timelineId];
        if (!path) unsupported("Unknown Newgrounds timeline");
        return listingPage(context, path, request.page, request.timelineId === "games");
      },
    },

    post: {
      async detail(request, context) {
        return { post: await fetchDetail(context, request.key) };
      },
    },

    profile: {
      async byId(request, context) {
        var profile = await findUser(context, request.key.id);
        if (!profile) notFound("Newgrounds user not found");
        return profile;
      },
      async byHandle(request, context) {
        var profile = await findUser(context, cleanHandle(request.handle));
        if (!profile) notFound("Newgrounds user not found");
        return profile;
      },
    },

    search: {
      async posts(request, context) {
        var page = pageNumber(request.page);
        var data = await getJson(context, "/search/conduct/movies?terms=" + encodeURIComponent(request.query || "") + "&page=" + page + "&inner=1");
        var items = parseItems(htmlOf(data), context).map(toItem);
        return items.length ? { items: items, olderCursor: "page:" + (page + 1), endReached: false } : { items: items, endReached: true };
      },
      async profiles(request, context) {
        var page = pageNumber(request.page);
        var data = await getJson(context, "/search/conduct/users?terms=" + encodeURIComponent(request.query || "") + "&page=" + page + "&inner=1");
        var users = parseUsers(htmlOf(data), context);
        return users.length ? { items: users, olderCursor: "page:" + (page + 1), endReached: false } : { items: users, endReached: true };
      },
      async discoverPosts(request, context) {
        return listingPage(context, LISTINGS.movies, request.page);
      },
      async discoverProfiles() {
        return { items: [], endReached: true }; // Newgrounds has no public "popular users" list
      },
      async discoverHashtags() {
        return { items: [], endReached: true };
      },
    },
  },
});

// ---------------------------------------------------------------- listing

async function listingPage(context, path, page, games) {
  var offset = page.direction !== "refresh" && page.cursor && /^offset:\d+$/.test(page.cursor) ? Number(page.cursor.slice(7)) : 0;
  var data = await getJson(context, path + (path.indexOf("?") >= 0 ? "&" : "?") + "offset=" + offset + "&inner=1");
  var posts = parseItems(htmlOf(data), context);
  // Games can't run in Flare, so they open in the browser.
  if (games) posts.forEach(function (p) { p.detailType = "link"; });
  var total = Number(data && data.total);
  var next = offset + posts.length;
  if (!posts.length || (Number.isFinite(total) && next >= total)) return { items: posts.map(toItem), endReached: true };
  return { items: posts.map(toItem), olderCursor: "offset:" + next, endReached: false };
}

function toItem(post) {
  return { type: "post", post: post };
}

function pageNumber(page) {
  var c = page.direction !== "refresh" && page.cursor;
  return c && /^page:\d+$/.test(c) ? Math.max(1, Number(c.slice(5))) : 1;
}

var ITEM_LINK = /<a\s+href="https:\/\/www\.newgrounds\.com\/(portal\/view\/\d+|art\/view\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+|audio\/listen\/\d+)"\s+class="(inline-card-portalsubmission|item-portalsubmission|item-portalitem-art[a-z-]*|item-audiosubmission)[^"]*"([^>]*)>/g;

/** Parses movie/game/art/audio cards and search results into posts. */
function parseItems(html, context) {
  var matches = [];
  var m;
  ITEM_LINK.lastIndex = 0;
  while ((m = ITEM_LINK.exec(html))) matches.push({ index: m.index, path: m[1], attrs: m[3] });
  var seen = {};
  var out = [];
  matches.forEach(function (match, i) {
    if (seen[match.path]) return;
    seen[match.path] = true;
    var chunk = html.slice(match.index, i + 1 < matches.length ? matches[i + 1].index : html.length);
    var post = cardPost(match.path, match.attrs, chunk, context);
    if (post) out.push(post);
  });
  return out.slice(0, 200);
}

function cardPost(path, attrs, chunk, context) {
  var kind = path.split("/")[0];
  var title = decode(attr(attrs, "title") || textOf(chunk, /<h4>([\s\S]*?)<\/h4>/));
  var author = decode(textOf(chunk, /<span>\s*by\s*(?:<strong>)?\s*([^<\s][^<]*?)\s*(?:<\/strong>)?\s*<\/span>/i));
  var image = httpsUrl(decode(textOf(chunk, /<img[^>]*?\ssrc="([^"]+)"/)));
  var description = decode(textOf(chunk, /<div class="detail-description">([\s\S]*?)<\/div>/));
  var score = textOf(chunk, /title="Score: ([0-9.]+)\/5\.00"/);
  var meta = [];
  if (score) meta.push("★ " + score);
  (chunk.match(/<dd>([\s\S]*?)<\/dd>/g) || []).forEach(function (dd) {
    var t = decode(dd.replace(/<[^>]+>/g, "")).trim();
    if (t && meta.length < 5) meta.push(t);
  });
  var duration = Number(textOf(chunk, /data-audio-duration="(\d+)"/));
  var post = {
    key: { id: path, host: originHost(context.origin) },
    createdAt: timeFromUrl(image),
    content: { format: "html", value: "<p><b>" + esc(title || "Untitled") + "</b></p>" +
      (description ? "<p>" + esc(description) + "</p>" : "") +
      (meta.length ? "<p><small>" + esc(meta.join(" · ")) + "</small></p>" : "") },
    url: ORIGIN + "/" + path,
    media: [],
    sensitive: /rated-a\b|ngicon-small-rated-a\b/.test(chunk),
  };
  if (author) post.author = userProfile(author, null, context);
  if (image) {
    var media = { id: path + "#cover", type: "image", url: image };
    if (title) media.description = title;
    if (kind === "audio" && duration > 0) media.durationMillis = duration * 1000;
    post.media.push(media);
  }
  return post;
}

// ----------------------------------------------------------------- detail

async function fetchDetail(context, key) {
  var path = String(key.id);
  if (!/^(portal\/view\/\d+|art\/view\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+|audio\/listen\/\d+)$/.test(path)) notFound("Unknown Newgrounds item");
  var kind = path.split("/")[0];
  var page = await getText(context, "/" + path);
  var title = decode(meta(page, "og:title")) || "Untitled";
  var description = decode(meta(page, "og:description"));
  var date = itemprop(page, "datePublished") || itemprop(page, "uploadDate");
  var cover = httpsUrl(decode(meta(page, "og:image")));
  var post = {
    key: { id: path, host: originHost(context.origin) },
    createdAt: isoDate(date) || timeFromUrl(cover),
    content: { format: "html", value: "<p><b>" + esc(title) + "</b></p>" + (description ? "<p>" + esc(description).replace(/\n/g, "<br>") + "</p>" : "") },
    url: ORIGIN + "/" + path,
    media: [],
  };
  var author = pageAuthor(page, context);
  if (author) post.author = author;

  if (kind === "portal") {
    if (/og:type" content="video/.test(page)) {
      var video = await getJson(context, "/portal/video/" + path.split("/")[2]);
      var media = videoMedia(video, path, cover);
      if (media) post.media.push(media);
    } else {
      post.detailType = "link"; // games run only in the browser
      if (cover) post.media.push({ id: path + "#cover", type: "image", url: cover });
    }
  } else if (kind === "audio") {
    var audio = httpsUrl(decode(meta(page, "og:audio")));
    if (audio) {
      var a = { id: path + "#audio", type: "audio", url: audio, description: title };
      if (cover) a.previewUrl = cover;
      post.media.push(a);
    } else if (cover) {
      post.media.push({ id: path + "#cover", type: "image", url: cover });
    }
  } else {
    artImages(page).forEach(function (url, i) {
      post.media.push({ id: path + "#" + i, type: /\.gif(\?|$)/i.test(url) ? "gif" : "image", url: url, description: title });
    });
    if (!post.media.length && cover) post.media.push({ id: path + "#cover", type: "image", url: cover });
  }
  post.media = post.media.slice(0, 100);
  return post;
}

function videoMedia(video, path, cover) {
  var sources = (video && video.sources) || {};
  var ranked = Object.keys(sources)
    .map(function (label) {
      var src = asArray(sources[label]).filter(function (s) { return s && httpsUrl(s.src); })[0];
      return src ? { height: parseInt(label, 10) || 0, url: httpsUrl(src.src) } : null;
    })
    .filter(Boolean)
    .sort(function (a, b) { return a.height - b.height; });
  if (!ranked.length) return null;
  // Play up to 720p (smaller downloads); offer the best quality as the download.
  var play = ranked.filter(function (s) { return s.height <= 720; }).pop() || ranked[0];
  var best = ranked[ranked.length - 1];
  var media = { id: path + "#video", type: "video", url: play.url };
  if (best.url !== play.url) media.downloadUrl = best.url;
  if (cover) media.previewUrl = cover;
  if (play.height) {
    media.height = play.height;
    media.width = Math.round(play.height * 16 / 9);
  }
  return media;
}

function artImages(page) {
  var urls = [];
  var re = /href="(https:\/\/art\.ngfiles\.com\/images\/[^"]+)"[^>]*data-action="view-image"/g;
  var m;
  while ((m = re.exec(page))) {
    var url = httpsUrl(decode(m[1]));
    if (url && urls.indexOf(url) < 0) urls.push(url);
  }
  if (!urls.length) {
    var single = textOf(page, /"full_image_text":"<img src=\\"(https:\\\/\\\/art\.ngfiles\.com\\\/images\\\/[^"\\]+)\\"/);
    if (single) urls.push(single.replace(/\\\//g, "/"));
  }
  return urls.slice(0, 100);
}

function pageAuthor(page, context) {
  var block = textOf(page, /<div class="item-user">([\s\S]{0,1500}?)<div class="item-details-meta">/);
  if (!block) return null;
  var name = decode(textOf(block, /<h4>\s*<a[^>]*>([^<]+)<\/a>/));
  if (!name) return null;
  return userProfile(name.trim(), httpsUrl(textOf(block, /<image href="([^"]+)"/)), context);
}

// ------------------------------------------------------------------ users

async function findUser(context, name) {
  if (!name) return null;
  var data = await getJson(context, "/search/conduct/users?terms=" + encodeURIComponent(name) + "&page=1&inner=1");
  var users = parseUsers(htmlOf(data), context);
  return users.filter(function (u) { return u.key.id === name.toLowerCase(); })[0] || null;
}

function parseUsers(html, context) {
  var out = [];
  var parts = html.split('<div class="item-user">').slice(1);
  parts.forEach(function (part) {
    var name = decode(textOf(part, /<h4>\s*<a[^>]*>([^<]+)<\/a>/)).trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) return;
    var profile = userProfile(name, httpsUrl(textOf(part, /<image href="([^"]+)"/)), context);
    var level = decode(textOf(part, /<div class="user-level">([\s\S]*?)<\/div>/).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    var aura = decode(textOf(part, /<div class="aura-text[^"]*">([\s\S]*?)<\/div>/).replace(/<[^>]+>/g, "")).trim();
    var fields = [];
    if (level) fields.push({ name: "Level", value: { format: "plain", value: level.replace(/^Level\s*/i, "") } });
    if (aura) fields.push({ name: "Aura", value: { format: "plain", value: aura } });
    if (fields.length) profile.fields = fields;
    if (out.length < 200) out.push(profile);
  });
  return out;
}

function userProfile(name, avatar, context) {
  var profile = {
    key: { id: name.toLowerCase(), host: originHost(context.origin) },
    handle: "@" + name,
    displayName: name,
    url: "https://" + name.toLowerCase() + ".newgrounds.com/",
  };
  if (avatar) profile.avatarUrl = avatar;
  return profile;
}

function cleanHandle(value) {
  var name = String(value || "").trim().replace(/^@/, "").replace(/^https?:\/\//i, "").replace(/\.newgrounds\.com\/?.*$/i, "").split("@")[0];
  return /^[A-Za-z0-9_-]{1,64}$/.test(name) ? name : "";
}

// ------------------------------------------------------------------- HTTP

function requireNgOrigin(origin) {
  if (origin !== ORIGIN) validationError("Use www.newgrounds.com as the server address");
}

async function getJson(context, path) {
  var response = await send(context, path, true);
  var body = String(response.body || "").trim();
  try {
    return JSON.parse(body);
  } catch (_) {
    invalidResponse("Newgrounds did not return the expected data");
  }
}

async function getText(context, path) {
  return String((await send(context, path, false)).body || "");
}

async function send(context, path, xhr) {
  requireNgOrigin(context.origin);
  var headers = { Accept: xhr ? "application/json" : "text/html" };
  if (xhr) headers["X-Requested-With"] = "XMLHttpRequest";
  var response;
  try {
    response = await flare.http.request({ url: ORIGIN + path, headers: headers });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "host.unavailable") fail("Network", "Could not reach Newgrounds");
    throw error;
  }
  if (response.status === 404) notFound("Not found on Newgrounds");
  if (response.status === 429) {
    var e = { code: "RateLimited", message: { value: "Newgrounds is rate limiting requests" } };
    var wait = Number(header(response.headers, "retry-after"));
    if (Number.isFinite(wait) && wait >= 0) e.retryAfterSeconds = Math.min(604800, Math.ceil(wait));
    throw flare.error(e);
  }
  if (response.status < 200 || response.status >= 300) fail("Remote", "Newgrounds returned HTTP " + response.status);
  return response;
}

function header(headers, name) {
  var keys = Object.keys(headers || {});
  for (var i = 0; i < keys.length; i++) {
    if (keys[i].toLowerCase() === name) {
      var v = headers[keys[i]];
      return Array.isArray(v) ? v[0] : v;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------- helpers

function htmlOf(data) {
  var c = data && data.content;
  return typeof c === "string" ? c : "";
}

function meta(page, property) {
  var re = new RegExp('<meta[^>]+(?:property|name)="' + property.replace(/[.:]/g, "\\$&") + '"[^>]+content="([^"]*)"', "i");
  return textOf(page, re);
}

function itemprop(page, name) {
  return textOf(page, new RegExp('itemprop="' + name + '"[^>]*content="([^"]+)"'));
}

function textOf(text, re) {
  var m = re.exec(String(text || ""));
  return m ? m[1] : "";
}

function attr(attrs, name) {
  return textOf(attrs, new RegExp("\\s" + name + '="([^"]*)"'));
}

var ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };

function decode(value) {
  return String(value || "")
    .replace(/<mark[^>]*>|<\/mark>/g, "")
    .replace(/&#(\d+);/g, function (_, n) { return safeChar(Number(n)); })
    .replace(/&#x([0-9a-f]+);/gi, function (_, n) { return safeChar(parseInt(n, 16)); })
    .replace(/&([a-z]+);/gi, function (all, n) { return Object.prototype.hasOwnProperty.call(ENTITIES, n.toLowerCase()) ? ENTITIES[n.toLowerCase()] : all; })
    .trim();
}

function safeChar(code) {
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
}

function esc(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function httpsUrl(value) {
  if (typeof value !== "string") return null;
  var text = value.trim();
  return /^https:\/\/[^/?#@\s]+(?:[/?#][^\s]*)?$/i.test(text) ? text : null;
}

/** Newgrounds file URLs end in ?f<unix seconds>, the upload/update time of that file. */
function timeFromUrl(url) {
  var m = /[?&]f?(\d{9,10})(?:$|&)/.exec(String(url || ""));
  return new Date(m ? Number(m[1]) * 1000 : 0).toISOString();
}

function isoDate(value) {
  var t = Date.parse(String(value || ""));
  return isNaN(t) ? null : new Date(t).toISOString();
}

function originHost(origin) {
  return String(origin).slice("https://".length).toLowerCase();
}

function asArray(value) { return Array.isArray(value) ? value : []; }

function fail(code, message) { throw flare.error({ code: code, message: { value: message } }); }
function validationError(message) { fail("Validation", message); }
function invalidResponse(message) { fail("InvalidResponse", message); }
function unsupported(message) { fail("Unsupported", message); }
function notFound(message) { fail("NotFound", message); }
