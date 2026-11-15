# Newgrounds for Flare

A [Flare](https://github.com/flaresocialapp/Flare) plugin for browsing [Newgrounds](https://www.newgrounds.com).

## Features

| Feature | Notes |
| --- | --- |
| Tabs | Featured Movies (default), Latest Movies, Featured Games, Featured Art (grid), Featured Audio |
| Movies | Open a movie to play it in Flare (up to 720p, with a 1080p download where available) |
| Audio | Open a track to play it in Flare |
| Art | Open a piece to see the full-size images |
| Games | Open in your browser (they can't run inside Flare) |
| Search | Movies and people |
| Profiles | Name, avatar, level and aura |

## Limits

- **Read-only.** Newgrounds keeps its login cookies hidden from scripts, so there's no
  real sign-in: you enter your username to use as the account's profile, and you can't
  favourite, vote, follow or comment from Flare.
- **No per-user post lists.** User pages live on `<name>.newgrounds.com`, and Flare only
  lets a plugin account use the one address it was added with.
- Dates in lists come from each thumbnail's upload time; opening a post shows the exact date.
- Newgrounds has no official API for this, so the plugin reads the same pages the website
  does and may need updates if Newgrounds changes its layout.

## Add the account

1. In Flare, add an account and type the full address **`www.newgrounds.com`**.
   Newgrounds won't appear in the suggested server boxes, and partial text won't find it.
2. Choose **Browse Newgrounds** and enter your Newgrounds username.

## Install

In Flare, open **Settings → Plugins → Add → Install from GitHub**, enter
`https://github.com/Blazeape595692/flare-plugin-newgrounds`, review the permissions and
confirm. Flare checks this repository for new tagged versions.
