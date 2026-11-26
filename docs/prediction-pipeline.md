# How the mod follows a race

Every window runs its own engine (`pages/src/engine/`) on Sauce's data for the rider
(`athlete/watching`, about three ticks a second) and, for the field and rivals windows, the riders
nearby. The engine is pure: it reads no clock or storage of its own, so it runs in Node under
`npm test` and replays recorded races exactly (`test/fixtures/recordings/`, anonymised). The windows
are views over it, so they always agree.

The plan is the planner's plan file (`zg-tt-plan/1`, documented with the planner): intervals with
their start and end metres, target power, plan time, gradient, the W′ the plan leaves, and from
November 2026 time marks inside each interval, the course itself and where its timing line and
finish are.

## Where you are on the plan

The mod places the rider on the plan's metres (`pages/src/engine/align.mjs`, `course.mjs`,
`engine.mjs`). Two things had to be found: where the timing line is on the plan's route data,
and how the game's `eventDistance` (zero at the line) maps onto that data.

- **The course match (the course tracker, `course.mjs`).** When the plan file carries
  `route.course` (format `zg-course/1`, written by the planner: the planner's own course on the
  plan's metres, simplified to 1 m, no gap over 100 m), the rider's lat/lng is matched onto the
  course. A fix counts when it lies within 10 m of the road; the course's segments are indexed on a
  50 m grid, so a fix costs a few cells, and the course's own crossings and laps are candidates
  together. Once four fixes agree on a line over 30 m of `eventDistance`, the tracker locks, and the
  plan metre is the locked metre plus the odometer (`eventDistance` x `route_m_per_game_m`). Each
  later fix that lies within 40 m of the odometer's metre pulls the metre 15 % of the way to it. The
  metre never goes backwards. Without a fix for 600 m of odometer the lock is lost, but the line is
  kept: the metre runs on from it by the odometer (carried) until a fix relocks, and a relock never
  moves the metre back. Only before the first lock does the old rule place the rider. A zero reading
  once racing is a dropped reading (missing), and an odometer step no rider could ride in the tick
  (45 m or more over two seconds) is held back one tick; if it persists it is taken as a real jump.
  A course may mark stretches the planner drew where its route data has no road (`gaps`: the end of
  a lap that does not join up in the data). No fix is taken there, and a locked rider is carried
  through on the odometer with the lock kept, however long the stretch.
- **A plan out of step with its race.** The road is believed for a timing line up to 1500 m into
  the plan (300 m until 2026-11-12, see the Hilly Route race below). When the line the road gives is
  100 m or more from where the plan has it, the targets still follow the road and the HUD says
  "plan off by 429 m" (the figure first found, kept all race; the tip says which end of the race
  is not in the plan). A plan with a course that is 500 m into its event with no match says "course
  not matched: targets by distance".
- **The old rule (the fallback until the lock, and for plans without a course).** The line is the
  plan length minus the event length when that is a stretch of 0 to 500 m, else the file's
  `start_line_m` (0 on most files), and the plan metre is `eventDistance` plus that line.
  Free rides and plans from here never use the course.
- **The finish.** On a plan whose finish the planner measured from races (`route.finish_source`
  `measured`, plans from 2026-11-23), the race ends at `route.finish_m` on the course, timed between
  ticks, unless Sauce's event length is more than 500 m away from it (another race on the course).
  Otherwise, with the event's length known, the race ends when Sauce's distance to go is spent, not
  at the plan's last metre: with the course locked the finish metre is the rider's metre plus the
  distance to go, so it can lie past the plan's end; the last interval stays the target until then,
  and the finished time is the clock's at that tick. The plan's pace carries on past the end.
  Sauce's length comes from its route data and can be wrong (84 m long on Crit Cross), which is
  why a measured finish wins.
- **The clock.** Zwift's clock, or the event distance, starts it at the line. Once the course locks,
  the plan time at the start is re-anchored to the matched line.
- **A mass start.** The game's distance and timer start at a timing line there too, so the plan's
  clock starts at the line exactly as in a TT. The result counts from the gun, so the engine keeps
  the seconds from the gun to the line (`race.gunToLineS`: the event's start from Sauce, Unix
  time, against the crossing on Zwift's world clock, which counts from 2014-10-22; `clock.mjs`
  `gunToLineS`) and gives the race time and the predicted finish on the result's clock as well
  (`race.officialElapsedS`, `race.officialTotalS`). The finish cell, the plan's time beside it and
  the field's clocks use those; the time to go and ahead or behind are the same on either clock.
  A window opened mid-race takes the crossing from Zwift's timer (to the second); with no start
  time from Sauce nothing is added and every time runs from the line.

Measured on a recorded California Dreamin' TT (route 966890401, 2026-11-10, plan NYC92U, the
recording in `test/fixtures/recordings/`): the line is at route-data metre 160.2 (+/- 2) and the
game's metres are 0.998656 x `eventDistance` + 160.17 (residual sd 1.65 m, max 5 m). The course
locks at `eventDistance` 37.6 m (the implied line 159.5 m), 3 s after the line. Against the
formula, over 3,976 locked race ticks: 100 % within 6 m (median error +0.3 m, worst 5.6 m). The
switches come within 0.6 s of the true crossing on 16 of the 17 boundaries (the tick spacing is 0.4
to 1.1 s); the one at 10059 m is 1.4 s: the rider's road projection and the tracker agree there, and the formula is 5 m ahead of
the road at that bend (the rider rides 3.7 m off the planner's line there). The finish comes at
the Sauce finish (`eventDistance` 21157.7, plan metre 21290 against the true 21287), with the clock
at 2095.6 s (Zwift: 2095 s). Without the course the same ride is late by 15 s median (34 s worst
at the bend): the old rule put the line at the pen.

Measured on a recorded Watopia Hilly Route race (route 2737483381, a 6.1 km custom distance, mass
start, no draft, 2026-11-11, ZwiftPower event 5780317, plan KM96SD; the recording and both plans
are in `test/fixtures/recordings/`, `test/recording-mass-start.test.mjs`):

- The gun went at 18:40:00 UTC. The game's distance and timer stayed at zero for 102 m out of the
  pen and started together 18.8 s after the gun. Line to finish was 686.1 s; ZwiftPower's time is
  704.888 s, from the gun. The engine's time from the gun is 704.92 s.
- The plan as raced was 429 m out of step: the planner had drawn 393 m of flat road before the
  start (the lap in its route data does not join up, and it put the missing metres at the wrong
  end), and the timing line is 36 m into the data. On that plan the rider is at
  0.99856 x `eventDistance` + 429.1.
- Mod 0.9.2 refused a line that far in (its window was 300 m), placed the rider by distance alone
  and changed every target 425 m late: 31 to 123 s, with the countdowns 21 s out on average. That
  is what "intervals off, countdowns erratic" was; the mass start added only the 19 s between the
  two clocks.
- Now: on the plan as raced the course locks with the line at 429 m, every target changes within
  1.5 s of the rider reaching it on the road, and the HUD says the plan is off by 429 m. On the
  same race planned by the fixed planner (metre 0 at the timing line, the lap's end drawn where
  the game has it and marked as a gap) the line locks at 0.3 m (within 7 m all race), never out of
  step, and the countdowns are 3.8 s out on average.

Constants (`course.mjs`): 50 m grid, 15 m search, 10 m accept, 40 m gate, 15 % blend, 4 fixes over
30 m to lock, 8 m agreement, 300 m of fixes kept, a plausible line between -150 and 1500 m (the
planner padded up to 1400 m before a start; the shortest lap is 1.9 km), 600 m to unlock. The blend strength makes no difference to the switch timing on this ride (0.05 to 0.5
gave the same). A fix counts on a segment only where it projects inside that segment: a fix just
past a vertex projects onto the vertex with its along-road distance as the offset, which would
pass for a fix on the road for the first metres past every vertex (on a straight in the unit tests
that locked the line 6 m wrong).

## The countdown to the next change

`countdown.mjs`. The seconds to the next change count down a second a second and settle on when
the rider will reach the change, so a hill inside an interval does not make them jump. The estimate
is the plan's time for the metres left in the interval (from the interval's time marks: a flat
interval that ends on a climb spends most of its time at the end), answered by the rider's power in
this interval against its target (the interval's average so far, leaning on the target for its
first half minute) and by the rider's speed against the plan's at that power over the last five
minutes (a draft, a planner a little off). The shown figure eases onto the estimate over a few
seconds and reaches zero at the change. The target switches exactly at the plan's boundary: the
planner put it where the change pays, so the mod never moves it, and the amber warning (10 s by
default) is the rider's to use.

Back-test on four recorded TTs, every tick against when the interval really ended: mean error
12.7 s for the old distance-over-speed figure, 6.1 s with the clock, 3.4 s with time marks.

## Ahead, behind and the time to go

`tracking.mjs` `predict`. The time to go is the plan's time for the rest of the race to the finish
(see above), answered the same two ways as the countdown: the rider's power against the targets
over the last ten minutes (leaning on the plan for the first five), through the physics of what is
left, and their speed against the plan's for the power they rode (leaning on the plan for the first
minute). The race's first 30 s after the line count for neither: the launch and the speed carried
over the line say nothing about the rest. Ahead or behind is that prediction against the plan's own
time, on the same clock. Both ratios are clamped (power 0.5 to 1.5, speed 0.6 to 1.6), and the
finish can never come before the time already ridden.

## W′

`wbal.mjs` is the planner's own W′ balance kernel, run on the rider's live power with the CP and
W′ the plan was made with (`rider.cp_used`, `rider.wprime_used_j`): above CP the balance falls by
(P − CP)·dt; below CP it refills on Bartram's (2018) time constant, calibrated, and never faster
than the power held back. So the live bar spends and refills exactly as the plan's W′ figures were
computed, and "below plan" means the rider has spent more than the plan had by that point. (Sauce's
own W′ gives every rider 20 kJ.) A plan from here starts the balance where the ride so far left it.
