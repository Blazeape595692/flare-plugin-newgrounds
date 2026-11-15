// Newgrounds adapter for Flare Social Plugin API v1.
//
// Newgrounds has no public API for its portals, so this reads the same pages the
// website loads: listing and search endpoints return JSON (wrapping HTML) when sent
// "X-Requested-With: XMLHttpRequest", and content pages carry Open Graph/schema.org
// metadata. Everything is public, read-only browsing on https://www.newgrounds.com.
//
// Sign-in: "Sign in on Newgrounds" opens Newgrounds' own login page in Flare's
// browser; Flare hands the session cookies to this plugin, which confirms the
// signed-in user from the page's PHP.set('activeuser', ...) data. Signed-in accounts
// can favourite/unfavourite (POST/DELETE to the item's favourite URL with the page's
// CSRF token, as the website does). The older "Browse Newgrounds" option stays for
// read-only use without signing in.
//
// Limit: Flare only lets an account call the address it was added with, and user
// pages live on <name>.newgrounds.com subdomains, so per-user post lists aren't
// available.

// Each request gets its own limit, shorter than Flare's 30 seconds for a whole call, so a
// slow server fails that request (a normal error) instead of the call (a plugin crash).
var REQUEST_TIMEOUT_MS = 12000;

var ORIGIN = "https://www.newgrounds.com";

var NG_CAPABILITIES = {
  "flare.datasource.timeline/v1": ["page"],
  "flare.datasource.post/v1": ["detail", "mutate"],
  "flare.datasource.profile/v1": ["byId", "byHandle"],
  "flare.datasource.search/v1": ["posts", "profiles", "discoverPosts", "discoverProfiles", "discoverHashtags"],
};

// The manifest's cookie probe lists every session cookie name Newgrounds has used
// (Flare only passes cookies named there); check() verifies the session with the server.
var PROBE_URL = ORIGIN + "/";

// Timeline id -> listing path (paged with ?offset=N&inner=1).
var LISTINGS = {
  movies: "/movies/featured",
  "movies-latest": "/movies/browse?interval=all&sort=date",
  games: "/games/featured",
  art: "/art/featured",
  audio: "/audio/featured",
};

// Timeline id -> signed-in feed page. "feed" is the combined /social page; the others
// are Newgrounds' own per-type "Favorite Artists" feeds (News = blog posts).
var FEEDS = {
  feed: "/social",
  "feed-movies": "/social/feeds/show/favorite-artists-movies",
  "feed-art": "/social/feeds/show/favorite-artists-art",
  "feed-games": "/social/feeds/show/favorite-artists-games",
  "feed-blogs": "/social/feeds/show/favorite-artists-news",
  "feed-audio": "/social/feeds/show/favorite-artists-audio",
};

defineFlareSocialPlugin(guardPlugin("Newgrounds", {
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
    browser: {
      async begin(request, context) {
        requireNgOrigin(context.origin);
        return { type: "webCookie", startUrl: ORIGIN + "/passport" };
      },
      async check(request, context) {
        requireNgOrigin(context.origin);
        var cookies = asArray(request.cookies && request.cookies.cookies)
          .filter(function (c) { return c && c.sourceUrl === PROBE_URL && c.name && c.value; })
          .map(function (c) { return { name: String(c.name), value: String(c.value) }; });
        if (!cookies.length) return { type: "pending" };
        var page = String((await send(context, "/social", false, cookies)).body || "");
        var user = activeUser(page);
        if (!user) return { type: "pending" }; // not signed in yet
        var profile = userProfile(user.name, user.avatar, context);
        return {
          type: "success",
          value: {
            accountId: profile.key.id,
            origin: context.origin,
            credential: { username: user.name, userId: user.id, cookies: cookies },
            profile: profile,
            capabilities: NG_CAPABILITIES,
          },
        };
      },
    },
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
        if (FEEDS[request.timelineId]) return feedPage(context, FEEDS[request.timelineId], request.page);
        var path = LISTINGS[request.timelineId];
        if (!path) unsupported("Unknown Newgrounds timeline");
        return listingPage(context, path, request.page, request.timelineId === "games");
      },
    },

    post: {
      async detail(request, context) {
        return { post: await fetchDetail(context, request.key) };
      },
      async mutate(request, context) {
        if (request.action !== "Favourite" && request.action !== "Unfavourite") unsupported("Newgrounds doesn't support this action here");
        var cookies = await sessionCookies();
        if (!cookies) unsupported("Sign in with \"Sign in on Newgrounds\" to favourite");
        var path = itemPath(request.key);
        var page = await getText(context, "/" + path);
        requireSignedIn(page);
        var fave = favouriteInfo(page);
        if (!fave) unsupported("This item can't be favourited");
        var want = request.action === "Favourite";
        if (fave.active !== want) {
          var token = textOf(page, /<meta name="csrf-token" content="([^"]+)"/);
          if (!token) invalidResponse("Newgrounds didn't provide a security token");
          await send(context, null, true, cookies, {
            url: want ? fave.store : fave.destroy,
            method: want ? "POST" : "DELETE",
            token: token,
          });
        }
        return { type: "updatedPost", post: await fetchDetail(context, request.key) };
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
}));

// Flare treats any error that isn't made with flare.error() as a plugin crash, and pauses
// the plugin after three in a minute. Every entry point therefore turns a stray error
// (a failed request, unexpected data) into an ordinary error Flare shows as a message.
function guardPlugin(name, definition) {
  function wrap(value) {
    if (typeof value === "function") {
      return async function () {
        try {
          return await value.apply(this, arguments);
        } catch (error) {
          if (error && error.__flarePluginErrorV1 !== undefined) throw error;
          var network = !!(error && typeof error.code === "string" && /^host\./.test(error.code));
          throw flare.error({
            code: network ? "Network" : "InvalidResponse",
            message: { value: network ? "Could not reach " + name : name + " sent something this plugin couldn't read" },
          });
        }
      };
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      var out = {};
      Object.keys(value).forEach(function (key) { out[key] = wrap(value[key]); });
      return out;
    }
    return value;
  }
  return wrap(definition);
}

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

// ------------------------------------------------------------------- feed
//
// "Your Feed" is the signed-in /social page: one .pod per event from people you
// follow. Older events come from the page's own "View More" link.

async function feedPage(context, start, page) {
  if (!(await sessionCookies())) unsupported("Sign in with \"Sign in on Newgrounds\" to see your feed");
  var cursor = page.direction !== "refresh" && page.cursor ? page.cursor : null;
  if (cursor && !/^\/social\/feeds\/[A-Za-z0-9\/_-]{1,300}$/.test(cursor)) cursor = null;
  var html = await getText(context, cursor || start);
  requireSignedIn(html);
  var items = parseFeed(html, context).map(function (post) { return { type: "post", post: post }; });
  var more = textOf(html, /<a href="(?:https:\/\/www\.newgrounds\.com)?(\/social\/feeds\/[A-Za-z0-9\/_-]{1,300})"[^>]*>\s*View More\s*<\/a>/);
  return more ? { items: items, olderCursor: more, endReached: false } : { items: items, endReached: true };
}

function parseFeed(html, context) {
  var out = [];
  var seen = {};
  html.split('<div class="pod">').slice(1).forEach(function (pod) {
    var head = textOf(pod, /<div class="pod-head">([\s\S]*?)<\/h2>/);
    var authorName = decode(textOf(head, /<a href="https:\/\/[a-z0-9_-]+\.newgrounds\.com\/?" class="inline">([^<]+)<\/a>/)).trim();
    var avatar = httpsUrl(textOf(head, /<image href="([^"]+)"/));
    var when = feedDate(textOf(pod, /id="published_submission_\d+">([^<]+)</));
    var post = null;
    if (/<div class="ql-body/.test(pod)) {
      post = feedBlogPost(pod, context);
      if (post) {
        authorName = post.author ? post.author.displayName : authorName;
        delete post.author;
      }
      when = when || post && post.createdAt;
    }
    var title = post ? null : pod.match(/<a class="portal-feed-large-title" href="https:\/\/www\.newgrounds\.com\/(art\/view\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (post) {
      // blog post, built above
    } else if (title) {
      post = feedArtPost(title[1], decode(title[2].replace(/<[^>]+>/g, "")), pod, context);
    } else {
      post = parseItems(pod, context)[0] || null;
      if (post && /\bGame by\b/.test(head.replace(/<[^>]+>/g, " "))) post.detailType = "link";
    }
    if (!post || seen[post.key.id]) return;
    seen[post.key.id] = true;
    if (when) post.createdAt = when;
    if (/^[A-Za-z0-9_-]{1,64}$/.test(authorName)) post.author = userProfile(authorName, avatar, context);
    out.push(post);
  });
  return out.slice(0, 200);
}

function feedArtPost(path, title, pod, context) {
  var blocked = /artviewer-blocked-img/.test(pod);
  var post = {
    key: { id: path, host: originHost(context.origin) },
    createdAt: new Date(0).toISOString(),
    content: { format: "html", value: "<p><b>" + esc(title || "Untitled") + "</b></p>" +
      (blocked ? "<p><small>Adult art: verify your age on Newgrounds to see it.</small></p>" : "") },
    url: ORIGIN + "/" + path,
    media: [],
    sensitive: blocked,
  };
  artImages(pod).forEach(function (url, i) {
    post.media.push({ id: path + "#" + i, type: /\.gif(\?|$)/i.test(url) ? "gif" : "image", url: url, description: title });
  });
  return post;
}

// A blog ("news") post: title and link in the pod head, "Posted by NAME - Month Dth, YYYY",
// and the post body in .ql-body. Blogs live on <name>.newgrounds.com, which Flare won't
// let the account fetch, so the post opens in the browser for comments.
function feedBlogPost(pod, context) {
  var link = pod.match(/<a href="(https:\/\/([a-z0-9_-]{1,64})\.newgrounds\.com\/news\/post\/(\d{1,12}))"[^>]*>([\s\S]*?)<\/a>/i);
  if (!link || link[2].toLowerCase() === "www") return null;
  var by = pod.match(/<p>\s*Posted by\s*<a [^>]*>([^<]{1,64})<\/a>\s*-\s*([A-Za-z]+) (\d{1,2})(?:st|nd|rd|th)?, (\d{4})\s*<\/p>/);
  var start = pod.search(/<div class="ql-body[^"]*"[^>]*>/);
  var body = "";
  if (start >= 0) {
    body = pod.slice(pod.indexOf(">", start) + 1);
    var end = body.search(/<\/div>\s*<script>\s*ngutils\.dom\.parse_text/);
    if (end < 0) end = body.search(/<hr\b/);
    if (end >= 0) body = body.slice(0, end);
  }
  var title = decode(link[4].replace(/<[^>]+>/g, "")).trim() || "Untitled";
  var path = "news/" + link[2].toLowerCase() + "/" + link[3];
  var clean = blogHtml(body);
  var post = {
    key: { id: path, host: originHost(context.origin) },
    createdAt: new Date(0).toISOString(),
    content: { format: "html", value: "<p><b>" + esc(title) + "</b></p>" + clean.html },
    url: link[1],
    detailType: "link",
    media: clean.images.map(function (url, i) {
      return { id: path + "#" + i, type: /\.gif(\?|$)/i.test(url) ? "gif" : "image", url: url };
    }),
    sensitive: false,
  };
  if (by) {
    var month = ["january", "february", "march", "april", "may", "june", "july", "august",
      "september", "october", "november", "december"].indexOf(by[2].toLowerCase()) + 1;
    if (month > 0) {
      var pad = function (n) { return (n < 10 ? "0" : "") + n; };
      post.createdAt = feedDate(by[4] + "-" + pad(month) + "-" + pad(+by[3]) + " 00:00:00");
    }
    var name = decode(by[1]).trim();
    if (/^[A-Za-z0-9_-]{1,64}$/.test(name)) post.author = { displayName: name };
  }
  return post;
}

var BLOG_TAGS = { p: 1, br: 1, b: 1, strong: 1, i: 1, em: 1, u: 1, s: 1, ul: 1, ol: 1, li: 1, blockquote: 1, h1: 1, h2: 1, h3: 1, h4: 1 };

/** Keeps simple formatting and https links; images become media, embeds become links. */
function blogHtml(html) {
  var out = "";
  var images = [];
  var parts = String(html || "").replace(/<script[\s\S]*?<\/script>/gi, "").split(/(<[^>]*>)/);
  parts.forEach(function (part) {
    if (part.charAt(0) !== "<") { out += part.replace(/</g, "&lt;").replace(/>/g, "&gt;"); return; }
    var m = /^<(\/?)([a-z0-9]+)([^>]*)>$/i.exec(part);
    if (!m) return;
    var close = m[1], tag = m[2].toLowerCase(), attrs = m[3];
    if (BLOG_TAGS[tag]) { out += tag === "br" ? (close ? "" : "<br>") : "<" + close + tag + ">"; return; }
    if (tag === "a") {
      if (close) { out += "</a>"; return; }
      var href = httpsUrl(decode(attr(attrs, "href")));
      out += href ? '<a href="' + esc(href) + '">' : "<a>";
      return;
    }
    if (close) return;
    if (tag === "img") {
      var src = httpsUrl(decode(attr(attrs, "src") || attr(attrs, "data-smartload-src")));
      if (src && images.length < 20) images.push(src);
    } else if (tag === "iframe") {
      var embed = httpsUrl(decode(attr(attrs, "src")));
      if (embed) out += '<p><a href="' + esc(embed) + '">' + (/youtube/i.test(embed) ? "YouTube video" : "Embedded media") + "</a></p>";
    }
  });
  out = out.replace(/<p>(\s|<br>)*<\/p>/g, "").trim();
  return { html: out.length > 20000 ? out.slice(0, 20000) : out, images: images };
}

/** Feed times are "YYYY-MM-DD HH:MM:SS" in Newgrounds' US Eastern time. */
function feedDate(text) {
  var m = /^\s*(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\s*$/.exec(String(text || ""));
  if (!m) return isoDate(text);
  var y = +m[1], mo = +m[2], d = +m[3], h = +m[4];
  var utc = Date.UTC(y, mo - 1, d, h, +m[5], +m[6]);
  // US daylight time: second Sunday of March 2:00 to first Sunday of November 2:00.
  var start = nthSunday(y, 2, 2), end = nthSunday(y, 10, 1);
  var local = Date.UTC(y, mo - 1, d, h);
  var daylight = local >= start + 2 * 3600000 && local < end + 2 * 3600000;
  return new Date(utc + (daylight ? 4 : 5) * 3600000).toISOString();
}

function nthSunday(year, month, n) {
  var first = new Date(Date.UTC(year, month, 1)).getUTCDay();
  return Date.UTC(year, month, 1 + ((7 - first) % 7) + (n - 1) * 7);
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

function itemPath(key) {
  var path = String(key.id);
  if (!/^(portal\/view\/\d+|art\/view\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+|audio\/listen\/\d+)$/.test(path)) notFound("Unknown Newgrounds item");
  return path;
}

async function fetchDetail(context, key) {
  var path = itemPath(key);
  var kind = path.split("/")[0];
  var page = await getText(context, "/" + path);
  var cookies = await sessionCookies();
  if (cookies) requireSignedIn(page);
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
  var fave = cookies ? favouriteInfo(page) : null;
  if (fave) post.actions = [{ action: fave.active ? "Unfavourite" : "Favourite", active: fave.active }];
  return post;
}

/** The item's own favourite button: its store/destroy URLs and whether it's active. */
function favouriteInfo(page) {
  var re = /initFavoriteButton\("#(ffr_ffr_[A-Za-z0-9_]+)",\s*"2-[^"]*",\s*(\{[^}]*\})\)/;
  var m = re.exec(page);
  if (!m) return null;
  var urls;
  try { urls = JSON.parse(m[2]); } catch (_) { return null; }
  var store = httpsUrl(urls.store), destroy = httpsUrl(urls.destroy);
  if (!store || !destroy || store.indexOf(ORIGIN + "/") !== 0 || destroy.indexOf(ORIGIN + "/") !== 0) return null;
  var cls = textOf(page, new RegExp('class="([^"]*)"\\s+id="' + m[1] + '"')) || textOf(page, new RegExp('id="' + m[1] + '"[^>]*class="([^"]*)"'));
  return { store: store, destroy: destroy, active: /(^|\s)active(\s|$)/.test(cls) };
}

/** Signed-in user from PHP.set('activeuser', {...}) on any page, or null. */
function activeUser(page) {
  if (!/PHP\.set\('user_logged_in', true\)/.test(page)) return null;
  var raw = textOf(page, /PHP\.set\('activeuser', (\{.*?\})\);/);
  var data;
  try { data = JSON.parse(raw); } catch (_) { return null; }
  var name = data && typeof data.name === "string" ? data.name : "";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) return null;
  var icons = data.icons && typeof data.icons === "object" ? data.icons : {};
  var avatar = httpsUrl(icons.large) || httpsUrl(icons.medium) || httpsUrl(icons.small) || null;
  return { name: name, id: data.id != null ? String(data.id) : "", avatar: avatar };
}

function requireSignedIn(page) {
  if (/PHP\.set\('user_logged_in', false\)/.test(page)) fail("AuthenticationRequired", "Your Newgrounds sign-in expired; sign in again");
}

async function sessionCookies() {
  var cred = await flare.credential.read();
  var list = cred && typeof cred === "object" ? asArray(cred.cookies) : [];
  list = list.filter(function (c) { return c && c.name && c.value; }).map(function (c) { return { name: String(c.name), value: String(c.value) }; });
  return list.length ? list : null;
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
  var response = await send(context, path, true, await accountCookies(context));
  var body = String(response.body || "").trim();
  try {
    return JSON.parse(body);
  } catch (_) {
    invalidResponse("Newgrounds did not return the expected data");
  }
}

async function getText(context, path) {
  return String((await send(context, path, false, await accountCookies(context))).body || "");
}

/** Signed-in accounts send their session with every request. */
async function accountCookies(context) {
  return context.scope === "account" ? await sessionCookies() : null;
}

async function send(context, path, xhr, cookies, write) {
  requireNgOrigin(context.origin);
  var headers = { Accept: xhr ? "application/json" : "text/html" };
  if (xhr) headers["X-Requested-With"] = "XMLHttpRequest";
  var request = { url: write ? write.url : ORIGIN + path, headers: headers };
  if (cookies && cookies.length) request.cookies = cookies;
  if (write) {
    request.method = write.method;
    headers["X-CSRF-TOKEN"] = write.token;
    if (write.method === "POST") request.body = { type: "form", values: {} };
  }
  var response;
  try {
    if (!request.timeoutMillis) request.timeoutMillis = REQUEST_TIMEOUT_MS;
    response = await flare.http.request(request);
  } catch (error) {
    if (!(error && error.__flarePluginErrorV1 !== undefined)) fail("Network", "Could not reach Newgrounds");
    throw error;
  }
  if (response.status === 401 || response.status === 419) fail("AuthenticationRequired", "Your Newgrounds sign-in expired; sign in again");
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
