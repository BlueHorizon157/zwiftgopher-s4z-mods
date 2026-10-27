# Listing the mod in the Sauce mod directory

REVAMP_PLAN.md 5.4 and decision 6: submit after Phase 5; alphas keep going out as GitHub
releases. This is what the listing needs, ready to send.

## How the directory works

Sauce reads `https://mods.sauce.llc/directory.json`, a list of entries. A listed mod installs
from Sauce's Mods page in one click. While enabled, it updates itself when Sauce starts: Sauce
picks the newest release whose `minVersion` it meets and checks the zip's sha256 against the
entry (`src/mods.mjs`: `getLatestPackedModRelease`, `fetchPackedModRelease`).

There is no public submission form. The entries carry Sauce-assigned ids (UUIDs), and the
zips are hosted on `mod-api.sauce.llc`. So a listing goes through the Sauce developer
(Justin Mayfield, the Sauce Discord), who adds the entry and uploads each release.

**The mod's id changes when it is installed from the directory.** Sauce ignores
`manifest.id` for a directory install and uses the entry's id. A rider who moves from the
unpacked folder (`zwiftgopher-tt`) to the directory version has to:

- add the windows again;
- remove the folder from `Documents/SauceMods`, or both copies run.

The plan library, the active plan and strategy, and the recorder are kept, because they live
in Sauce's global storage (`/zg-tt/*`). Each window's look settings are per window, so they
start from the defaults.

## The entry

| Field | Value |
|---|---|
| `name` | ZwiftGopher TT |
| `description` | Ride a ZwiftGopher TT plan in Zwift. A HUD (strip, dial or stack) shows the target now, the next change and when, the W′ you have left and the finish time you are on for. There is also an interval list, a field window, and a rivals strip showing whether you are gaining or losing on the riders around you. Plans come from the planner at zwiftgopher.com/TT by a six-character code. |
| `tags` | `tt`, `pacing`, `racing`, `hud` |
| `homeURL` | https://zwiftgopher.com/TT/sauce4zwift-mod.html |
| `logoURL` | https://raw.githubusercontent.com/BlueHorizon157/zwiftgopher-s4z-mods/master/docs/brand/logo.png (512 × 512, `docs/brand/logo.svg` is the source) |
| `authorName` | ZwiftGopher |
| `authorURL` | https://zwiftgopher.com/TT/ |

Each release:

| Field | Value |
|---|---|
| `version` | `manifest.json` version (0.7.0 first) |
| `minVersion` | 2.0.0. The page check passes on Sauce 2.0.0-beta.10 and 2.4.0-alpha.5. |
| zip, `size`, `hash` | The zip `scripts/release.sh` builds from the tag (`dist/zwiftgopher-s4z-mods-v<version>.zip`, one top folder with `manifest.json` in it, no tests, docs or fixtures). The script prints its size and sha256. |
| `notes` | One line from the release notes. |

## Before sending it

1. Release 0.7.0 with the planner deploy (the plan file's card plans and the share text
   ship with the planner), not before.
2. A real TT recorded with the field or rivals window open has confirmed the start line
   and the field's assumptions (REVAMP_PLAN.md, Phase 4 open points).
3. The logo URL resolves, so `docs/brand/logo.png` is pushed to master.
4. Once the listing is live, the settings page's update hint (a GitHub tag check once a
   day) can go, since Sauce updates directory installs itself. The planner's mod page
   should then point to the directory, and keep the zip for manual installs.
