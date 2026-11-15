# Newgrounds for Flare

A [Flare](https://github.com/flaresocialapp/Flare) plugin for browsing [Newgrounds](https://www.newgrounds.com).

## Features

| Feature | Notes |
| --- | --- |
| Tabs | Featured Movies, My Feed, Feed: Movies, Feed: Art (grid), Feed: Games, Feed: Blogs, Feed: Audio, Latest Movies, Featured Games, Featured Art (grid), Featured Audio |
| My Feed | Everything from people you follow (movies, games, art, audio and blog posts), with exact dates (needs "Sign in on Newgrounds"). Adult art you haven't age-verified for shows as blocked, like on the website. |
| Feed: Movies / Art / Games / Blogs / Audio | The same feed split by type, using Newgrounds' own filtered feeds. Blog posts show their text and images; open one to read it and its comments in your browser. |
| Movies | Open a movie to play it in Flare (up to 720p, with a 1080p download where available) |
| Audio | Open a track to play it in Flare |
| Art | Open a piece to see the full-size images |
| Games | Open in your browser (they can't run inside Flare) |
| Search | Movies and people |
| Profiles | Name, avatar, level and aura |
| Favourites | Favourite and unfavourite movies, games, art and audio from a post's page (needs "Sign in on Newgrounds") |

## Limits

- Following, voting and commenting aren't supported yet.
- **No per-user post lists.** User pages live on `<name>.newgrounds.com`, and Flare only
  lets a plugin account use the one address it was added with.
- Dates in lists come from each thumbnail's upload time; opening a post shows the exact date.
- Newgrounds has no official API for this, so the plugin reads the same pages the website
  does and may need updates if Newgrounds changes its layout.

## Add the account

1. In Flare, add an account and type the full address **`www.newgrounds.com`**.
   Newgrounds won't appear in the suggested server boxes, and partial text won't find it.
2. Choose **Sign in on Newgrounds** and log in on Newgrounds' own sign-in page. Flare
   keeps the session (not your password) and the plugin confirms who you are with
   Newgrounds. If your session expires, Flare asks you to sign in again.

   Or choose **Browse without signing in** and just enter your username: read-only, no
   favouriting.

New accounts start with Featured Movies and My Feed. Add the Feed: Movies, Art, Games, Blogs and Audio tabs (and the
other portal tabs) from Flare's tab settings. Accounts added before v0.3.0 need My Feed added there too.

## Install

In Flare, open **Settings → Plugins → Add → Install from GitHub**, enter
`https://github.com/Blazeape595692/flare-plugin-newgrounds`, review the permissions and
confirm. Flare checks this repository for new tagged versions.
