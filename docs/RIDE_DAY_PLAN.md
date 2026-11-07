# Ride-day plan (pointer)

The plan for taking the hand-off out of planning and riding (a rider link paired once, the
rider's plans on a server shelf, the planner publishing and the mod syncing and arming the
plan for the event in the pen, an event picker in the planner, *Plan it* from the mod) lives
with the planner, in the main repo: `ZwiftGopher/TT/RIDE_DAY_PLAN.md`.

The mod's part of it: §2.4 (sync, pick by event, Next TT), §2.5 (Plan it), and the mod rows
of Phases 1 to 4 (`views/shelf-sync.mjs`, `/zg-tt/link` in `store.mjs`, `eventId` from
`eventinfo.mjs`, the Link section of the settings page, the pick rules in `runtime.mjs`, the
page-check moments). It takes over `docs/REVAMP_PLAN.md` Phase 5's planner-coupling items.
