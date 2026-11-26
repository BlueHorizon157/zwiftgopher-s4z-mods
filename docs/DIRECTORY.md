# Listing the mod in the Sauce mod directory

REVAMP_PLAN.md 5.4 and decision 6. Releases go out as GitHub releases (full releases since
0.8.2) until the listing is live. This is what the listing needs, ready to send. Not sent yet
(2026-11-26).

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
in the browser storage every Sauce window shares (`~zg-tt/*`; 0.9.5 and earlier used Sauce's
global `/zg-tt/*` keys, copied across on first use). Each window's look settings are per window, so they
start from the defaults.

## The entry

| Field | Value |
|---|---|
| `name` | ZwiftGopher TT |
| `description` | Ride a ZwiftGopher TT plan in Zwift. A HUD (strip, dial or stack) shows the target now, the next change and when, the W′ you have left and the finish time you are on for. There is also an interval list, a field window, and a rivals strip showing whether you are gaining or losing on the riders around you. Link the mod to the planner at zwiftgopher.com/TT once and your plans arrive by themselves; Plan it builds one for the event you are in; a six-character code works too. |
| `tags` | `tt`, `pacing`, `racing`, `hud` |
| `homeURL` | https://zwiftgopher.com/TT/sauce4zwift-mod.html |
| `logoURL` | https://raw.githubusercontent.com/BlueHorizon157/zwiftgopher-s4z-mods/master/docs/brand/logo.png (512 × 512, `docs/brand/logo.svg` is the source) |
| `authorName` | ZwiftGopher |
| `authorURL` | https://zwiftgopher.com/TT/ |

Each release:

| Field | Value |
|---|---|
| `version` | `manifest.json` version |
| `minVersion` | 2.0.0. The page check passes on Sauce 2.0.0-beta.10 and 2.4.0-alpha.5. |
| zip, `size`, `hash` | The zip `scripts/release.sh` builds from the tag (`dist/zwiftgopher-s4z-mods-v<version>.zip`, one top folder with `manifest.json` in it, no tests, docs or fixtures). The script prints its size and sha256. |
| `notes` | One line from the release notes. |

## Before sending it

Done: the planner the mod needs is live (0.7.0 shipped with it); real races have been
recorded with the field and rivals open (California Dreamin' 2026-11-10, Fan Flats
2026-11-18, both in `test/fixtures/recordings`); the logo URL resolves.

Still to do:

1. Run the page check (`scripts/page-check.mjs`) on the Sauce version riders have now, and set
   `minVersion` from it.
2. Once the listing is live, the settings page's update hint (a GitHub release check once a
   day) can go, since Sauce updates directory installs itself. The planner's mod page
   should then point to the directory, and keep the zip for manual installs.
