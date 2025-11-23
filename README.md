# TT Interval Dashboard

The TT Interval Dashboard is a Sauce for Zwift overlay that mirrors your TT Power Planner inside the desktop app. It loads a race plan, keeps the current and next intervals in view, and gives broadcasters or racers a clear pacing gauge with distance, offset, and power bias controls.

## Highlights

- **Multiple windows** – pick the view that fits your stream or second monitor: the main dashboard, a compact rider leaderboard, or a scrollable interval list.
- **Plan-first pacing** – fetch the plan from the online TT Planner (zwiftgopher.com/TT) and the overlay follows it automatically.
- **Quick bias controls** – nudge distance offset and power bias from the dashboard without touching the browser-based overlay.
- **Lightweight** – every window runs as a standard Sauce mod, so you can pin or chroma-key them like any other overlay.

## Available windows

- **TT Planner Dashboard** (`tt-dashboard.html`): the primary pacing gauge with offset and bias controls plus a mini summary of the remaining plan.
- **TT Field Dashboard** (`tt-field-dashboard.html`): a leaderboard sorted by average speed that shows live distance progress, average w/kg, IF%, and W′ balance for the riders Sauce is tracking in your event.
- **TT Interval List** (`tt-interval-list.html`): a panel that keeps the active interval centered and mirrors the TT planner columns (start/end km, target watts, duration, grade, and projected W′ bal) with a sticky header summarizing plan stats.

### Field dashboard columns

| Column | Description |
| --- | --- |
| Rider | Display name plus team, ellipsized to keep the column tidy. |
| Av Speed | Average speed in km/h, sorted descending. |
| Dist Progress | Percent of the event completed (and km when available). |
| Avg w/kg | Average watts per kilo, rounded to two decimals. |
| IF% | Intensity Factor (normalized power vs FTP) expressed as a percent. |
| W′ bal | Remaining anaerobic work (kJ) and percent of W′. |


## Using your TT plan

Open the TT Planner Dashboard window and copy the code from the TT Planner (zwiftgopher.com/TT):

1. Paste the plan code into the input box.
2. Click **Load plan**.

Your last selection saves to Sauce’s window storage, so the overlay remembers the chosen plan between sessions. The module expects the same field names the public TT planner emits (`intervals[*].start_km`, `end_km`, `power_w`, `duration_text`, and so on).

## Telemetry and overrides

The overlay blends your plan data with the live telemetry Sauce receives from Zwift:

1. Plan-provided values (FTP, weight, W′) always override telemetry so you can lock in race-day targets.
2. Missing values fall back to Sauce data (`athlete.*` and `stats.*`).
3. When Sauce reports W′ balance, the UI also shows the percentage relative to the active plan’s W′ so you can confirm the reserve matches your expectations.