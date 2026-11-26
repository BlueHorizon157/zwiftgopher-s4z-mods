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
| `description` | Ride a ZwiftGopher TT plan in Zwift. A HUD (strip, dial or stack) shows the target now, the next change and when, the W′ you have left and the finish time you are on for. There is also an interval list, a field window, and a rivals strip showing whether you are gaining or losing on the riders around you. Link it to the planner at zwiftgopher.com/TT once and your plans arrive by themselves; Plan it builds one for the event you are in; a six-character code works too. |
| `tags` | `tt`, `pacing`, `racing`, `hud` |
| `homeURL` | https://zwiftgopher.com/TT/sauce4zwift-mod.html |
| `logoURL` | https://raw.githubusercontent.com/BlueHorizon157/zwiftgopher-s4z-mods/9963d78224455e7529b5787aeaed56e6a5d6ba3e/docs/brand/logo.png (512 × 512, pinned to a commit as Justin asks; source `docs/brand/logo.svg`) |
| `authorName` | ZwiftGopher |
| `authorURL` | https://zwiftgopher.com/TT/ |

Each release:

| Field | Value |
|---|---|
| `version` | `manifest.json` version |
| `minVersion` | 2.0.0. The page check passes on Sauce 2.0.0-beta.10 and 2.4.0-alpha.5; run it on 2.3.0 (newest stable) before submitting. |
| `url`, `size`, `hash` | From the release tool, after it uploads the zip `scripts/release.sh` built. |
| `notes` | One or two lines from `docs/releases/<version>.md`. |

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
