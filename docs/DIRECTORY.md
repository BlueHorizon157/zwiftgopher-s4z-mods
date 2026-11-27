# Listing the mod in the Sauce mod store

Everything the store listing needs, ready to send. Not sent yet (2026-11-26). Until the
listing is live, riders install by unzipping a GitHub release into `Documents/SauceMods`, as
now. Background and the reviewer's habits: the research doc "Sauce for Zwift mod store:
submitting and maintaining ZwiftGopher" (2026-11-26).

## How the store works

The store is one file, `directory.json`, in
[SauceLLC/sauce4zwift-mod-store](https://github.com/SauceLLC/sauce4zwift-mod-store), served
as https://mods.sauce.llc. Anyone can ask to be listed:

1. Build the zip (`scripts/release.sh vX.Y.Z`): one top folder with `manifest.json` in it.
2. Pick it in the [release tool](https://mods.sauce.llc/release-tool.html). The tool runs
   Sauce's manifest check and, only if there is no warning at all, uploads the zip to
   `mod-api.sauce.llc` and drafts the entry (sha256, size, version).
3. Fork the store repo, add or update our entry in `directory.json` (4-space indents like the
   others), open a pull request. Justin Mayfield reviews it: a new listing takes days (he
   installs it, runs it and reads the code), an update is usually merged the same day.

Sauce reads `directory.json` at every start. A store install is kept zipped in Sauce's
AppData and read in place. While enabled it updates itself at start: Sauce takes the newest
release whose `minVersion` it meets and checks the zip's sha256 against the entry. There is
no prompt, no staged rollout and no rollback: a bad release stays until the next merge.

Rules for every release: bump the version whenever the zip changes (a new zip under an old
version makes installs look corrupt); the entry's version must equal `manifest.json`'s; never
rename the manifest `name` (the tool finds our entry by it); never add `aspect_ratio` to a
window's `default_bounds` (the tool's copy of the check wants true/false, Sauce wants a number).

## The mod's id

Sauce keys a mod's windows and their settings by the mod's id. An unpacked copy takes
`manifest.json`'s `id` (`zwiftgopher-tt`); a store install takes the entry's `id` and ignores
the manifest's. The release tool makes up a random UUID for a new entry.

Plan (decided 2026-11-26: no breaking change for riders before the listing):

- The manifest keeps `zwiftgopher-tt`.
- Ask Justin to let the entry use `zwiftgopher-tt` as its id (Sauce does not check the form of
  an entry id). Then moving from the folder to the store loses nothing: delete the folder,
  install from the store, the windows come back as they were.
- If he wants a UUID: a rider moving to the store re-adds their windows (a store install
  enables itself, so no restart beyond the one Sauce asks for). Before that release, the store
  copy can offer to move the old windows across itself: `getWidgetWindowSpecs` lists them and
  `updateWidgetWindowSpec` can point each at the new mod, keeping its place and settings.
  Build and test that with a local directory (below) before submitting.

Plans, the link to the planner and the active plan live in the browser storage every Sauce
window shares (`~zg-tt/*`), so they carry over either way.

## The entry

| Field | Value |
|---|---|
| `id` | `zwiftgopher-tt` if Justin agrees (above), else the tool's UUID |
| `name` | ZwiftGopher TT |
| `description` | The markdown under "Store description" below, pasted into the release tool as it is |
| `tags` | `time trial`, `tt`, `pacing`, `planner`, `racing`, `hud` (labels only: the store does not filter or search by them) |
| `homeURL` | https://zwiftgopher.com/TT/sauce4zwift-mod.html |
| `logoURL` | https://raw.githubusercontent.com/BlueHorizon157/zwiftgopher-s4z-mods/9963d78224455e7529b5787aeaed56e6a5d6ba3e/docs/brand/logo.png (512 × 512, pinned to a commit as Justin asks; source `docs/brand/logo.svg`) |
| `authorName` | ZwiftGopher |
| `authorAvatarURL` | https://raw.githubusercontent.com/BlueHorizon157/zwiftgopher-s4z-mods/d64667ef2a5c093628d739c08d43ea015c1441a6/docs/brand/author-avatar.webp (the ZwiftGopher bot's Discord avatar, 266 × 266, kept in the repo and pinned to a commit like the logo, since a Discord avatar link stops working when the avatar changes). Shown round, about 48 px, next to the author name. |
| `authorURL` | https://zwiftgopher.com/TT/ |

Each release:

| Field | Value |
|---|---|
| `version` | `manifest.json` version |
| `minVersion` | 2.0.0. The page check passes on Sauce 2.0.0-beta.10 and 2.4.0-alpha.5; run it on 2.3.0 (newest stable) before submitting. |
| `url`, `size`, `hash` | From the release tool, after it uploads the zip `scripts/release.sh` built. |
| `notes` | The card's release notes: the format under "Release notes on the card" below. |

## How the card shows it

The store page renders `description` and the newest release's `notes` as markdown with every
line break kept as a break, so neither may be hard-wrapped: one line per paragraph and per
bullet. Headings, bold, bullets and links render. Around them the card shows the logo, the
version, size, last update, created date, install count, hearts (votes), tags, the author
(avatar, name, link) and a "Website" link to `homeURL`. The list is sorted by install count,
which rises on every download, automatic updates included. The release tool shows a live
preview of the card: check it there before opening the PR.

## Store description

Paste as it is (Justin prefers "Features" to "Mods" as a heading):

```markdown
Ride a pacing plan from the ZwiftGopher TT planner, live in Zwift: the power to hold now, the next change and when it comes, the W′ you have left, and the finish time you are on for.

### Features
- **HUD** in three shapes (strip, dial or stack), each a window you place over the game
- **Interval list**: every interval's target, time, gradient and W′, and how each one went
- **Field**: the riders of your event, the gap at the same distance, your place and the time you gain or lose on each
- **Rivals strip**: the riders nearest you on the clock, ahead and behind, and how the gaps move
- **Plans arrive by themselves**: link once to the planner at [zwiftgopher.com/TT](https://zwiftgopher.com/TT/), or type a six-character plan code
- **Plan it**: signed up but no plan? Once linked, the planner builds one for that event in a few seconds
- **Plan from here**: dropped or on your own? Once linked, a new plan for the rest of the race from the W′ you have left

Free to use. The guide, with pictures and a video, is on the website linked below.
```

## Release notes on the card

Each release's `notes` are the card's "RELEASE NOTES" until the next release replaces them.
The full notes stay in `docs/releases/<version>.md` and on the GitHub release.

- 1 to 6 bullets, one line each, no wrapping; what the rider notices first, in plain words.
- Bold the first few words when a bullet names a feature.
- Nothing about tests, audits or internals; fixes say what was wrong in the ride, not why.
- Last line: a link to the full notes on GitHub.

Template:

```markdown
- **<What is new>**: <what the rider can do now>
- <What was wrong in a ride> no longer happens: <what happens instead>
- <A smaller change>

[All changes in <version>](https://github.com/BlueHorizon157/zwiftgopher-s4z-mods/releases/tag/v<version>)
```

Example, from 0.9.9:

```markdown
- **Joining a race already under way** works: the HUD picks up the race 30 seconds after you join
- A few seconds' gap in Zwift's data at an interval change no longer makes you look slow
- One stray "0 m to go" reading no longer ends the race early
- The finish shows its own time and ahead/behind, not the last reading before the line
- A power dropout no longer drags an interval's average down

[All changes in 0.9.9](https://github.com/BlueHorizon157/zwiftgopher-s4z-mods/releases/tag/v0.9.9)
```

## The pull request

Title: `Add ZwiftGopher TT <version>`. Body, ready to paste (Justin reads payloads and storage
closely; Race Report's similar note got it merged in a day):

> Adds **ZwiftGopher TT**: race-day windows for a time-trial pacing plan made at
> zwiftgopher.com/TT (target power now, the next change and when, W′ left, predicted finish,
> the field and rivals). Home: https://zwiftgopher.com/TT/sauce4zwift-mod.html, source:
> https://github.com/BlueHorizon157/zwiftgopher-s4z-mods (public GitHub releases since
> October, used in real races).
>
> **Network.** Only zwiftgopher.com, and only for what the rider asks for:
> - A plan loads by its six-character code (`share-plan.php`; nothing about the rider is sent).
> - Linking is optional, started by the rider in settings: `link.php` receives the Zwift ID and
>   display name Sauce reports and a device label, and returns a device token (the server keeps
>   only its SHA-256). With a link, `shelf.php` is polled about once a minute for new plans,
>   receives the rider's signed-up event subgroups that Sauce can see (event id, subgroup id,
>   start, name), and builds plans on request (Plan it, Plan from here; the latter sends the
>   ride's power so far, used to work out the plan and not kept). The link can be removed from
>   the settings page or the planner. Privacy policy: https://zwiftgopher.com/TTT/privacy.php (one page for the
>   whole site)
> - A folder install checks api.github.com once a day for a newer release. A store install
>   does not (it asks `getAvailableModsV1` whether it is packed and leaves updating to Sauce).
>
> **Storage.** localStorage under `~zg-tt/*`: at most 10 plans, the link, the active plan and
> controls, plus Sauce's own per-window settings. IndexedDB `zg-tt-recorder`: a telemetry
> recorder and kept races for bug reports, both **off by default**; when on, the recorder keeps
> the last 2 hours (the store capped near 800 MB) and kept races 14 days (300 MB).
>
> **Sauce data.** Subscribes to `athlete/watching` and `nearby`; RPC `getEvent`,
> `getCachedEvents`, `getEventSubgroup`, `getAthlete`, `getAthleteStreams`,
> `getAvailableModsV1`. One window at a time writes a small `zgtt` object (target, next change,
> plan position, a few hundred bytes) into the rider's own athlete data with
> `updateAthleteData('self', …)` once a tick, so other windows and local tools can show it.
> No `content_js` or `content_css`.

## Updates

Each update: bump and release as usual (`docs/releases/`, `scripts/release.sh`), then the
release tool with the existing entry picked ("Replace existing entry" ticked), then a PR
titled `ZwiftGopher TT <version>` changing only our `releases` block. Bundle changes into
releases about a week apart; keep same-day releases for race-day breakage. To raise
`minVersion` without stranding riders on an older Sauce, untick "Replace existing entry" so
the previous release stays listed.

## Before sending

Done:
- 0.9.10: a store install leaves updating to Sauce (no GitHub check, settings say "kept up to
  date by Sauce").
- Real races recorded with the field and rivals open (2026-11-10, 2026-11-18).
- The manifest passes Sauce's check with no warnings; windows' `file`, `id` and `name` are all
  unique; the zip is one top folder, about 200 KB.

Still to do:
1. Deploy the privacy page section for the mod (zwiftgopher.com, `inc/privacy-content.php`).
2. Ask Justin on the Sauce Discord: `zwiftgopher-tt` as the entry id; whether he wants a
   Discord test round first; whether the recorder caps are acceptable for a store mod.
3. Test a store install: serve a `directory.json` with our entry (`url` pointing at a local
   copy of the zip) and start Sauce with `MOD_DIRECTORY_URL=http://127.0.0.1:<port>/directory.json`;
   install it from the Mods page, open every window, check plans and the link carry over and
   the settings say "kept up to date by Sauce". Do not keep the store copy and the folder copy
   on one machine if they share an id.
4. Page check on Sauce 2.3.0.
5. Once listed: the planner's mod page and the README point to the store (the zip stays for
   manual installs).
