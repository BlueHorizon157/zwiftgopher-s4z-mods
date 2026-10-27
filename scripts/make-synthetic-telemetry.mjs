#!/usr/bin/env node
// A synthetic TT recording from a plan file (docs/REVAMP_PLAN.md Phase 0.1): a rider who
// sits in the pen, rolls out and rides the plan exactly, one tick a second, in the
// recorder's JSONL format, so the engine can be developed and replayed before a real
// recording exists. Every guess about Zwift's start-line behaviour is listed in the meta
// row's `assumptions`; a real recording (settings → Telemetry recorder) replaces it.
//
//   node scripts/make-synthetic-telemetry.mjs test/fixtures/plans/flat.fit.optimise.json \
//        test/fixtures/telemetry/synthetic-flat-tt.jsonl [--pen=30] [--line=180] [--warmup=4000] [--rivals=1]
//
// With --rivals=1 (the default) six made-up riders share the event: released before and
// after the home rider (a staggered TT start) and riding the plan's speeds scaled by a
// factor each, so some gain and some lose. They appear in 'nearby' rows every 2 s, as the
// recorder writes them, with the home rider as the watching entry.
import {readFileSync, writeFileSync} from 'node:fs';

const [, , planPath, outPath, ...flags] = process.argv;
if (!planPath || !outPath) {
    console.error('usage: make-synthetic-telemetry.mjs <plan-file.json> <out.jsonl> [--pen=S] [--line=M] [--warmup=M]');
    process.exit(1);
}
const opt = Object.fromEntries(flags.map(f => f.replace(/^--/, '').split('=')).map(([k, v]) => [k, Number(v)]));
const WITH_RIVALS = opt.rivals == null ? true : opt.rivals !== 0;
const NEARBY_EVERY_S = 2;
// releaseS: seconds after the home rider's release (negative: started earlier, so ahead on
// the road); factor: their speed against the plan's (power scales with its cube).
const RIVALS = [
    {id: 900001, name: 'Lena Fischer', team: 'RCC', releaseS: -20, factor: 0.985, weight: 64},
    {id: 900002, name: 'Tom Okafor', team: 'ZG', releaseS: -10, factor: 1.012, weight: 78},
    {id: 900003, name: 'Ana Ribeiro', team: '', releaseS: -5, factor: 0.995, weight: 58},
    {id: 900004, name: 'Sam Patel', team: 'DIRT', releaseS: 5, factor: 1.02, weight: 71},
    {id: 900005, name: 'Mia Kowalski', team: '', releaseS: 10, factor: 0.97, weight: 60},
    {id: 900006, name: 'Joe Hart', team: 'ZG', releaseS: 25, factor: 1.0, weight: 82},
];
const PEN_SECONDS = opt.pen ?? 30;          // ticks sat in the pen before release
const LINE_M = opt.line ?? 180;             // timing line: 30 m pen-to-route + the planner's 150 m start delay
const WARMUP_M = opt.warmup ?? 4000;        // ride distance before the event (state.distance counts it)
const TAIL_SECONDS = 20;
const EPOCH = Date.UTC(2026, 0, 1, 12, 0, 0);
const SUBGROUP = 1234567;
const EVENT = 7654321;
const ATHLETE = 354912;

const file = JSON.parse(readFileSync(planPath, 'utf8'));
if (file.schema !== 'zg-tt-plan/1') {
    throw new Error('not a zg-tt-plan/1 file');
}
const intervals = file.intervals;
const planLengthM = intervals[intervals.length - 1].end_m;
const cp = file.rider.cp_used;
const wPrime = file.rider.wprime_used_j;
const weight = file.rider.weight ?? 75;

// Speed per interval from the plan's own figures, m/s.
const speedOf = iv => (Number(iv.speed_kmh) > 0 ? iv.speed_kmh / 3.6 : (iv.end_m - iv.start_m) / iv.duration_s);
const intervalAt = m => intervals.find(iv => m >= iv.start_m && m < iv.end_m) ?? intervals[intervals.length - 1];

const rows = [];
let t = 0;
let planM = 0;            // metres from the pen = plan metre
let raceTime = 0;         // the event clock, from the timing line (assumption A)
let crossed = false;
let powerSum = 0;
let powerN = 0;
let wbal = wPrime;
let lastPower = 0;
const push = (state, extra = {}) => {
    powerSum += state.power;
    powerN += 1;
    rows.push({
        t: t * 1000,
        ch: 'athlete/watching',
        d: {
            athleteId: ATHLETE,
            watching: true,
            self: true,
            age: 0,
            courseId: 6,
            eventSubgroupId: SUBGROUP,
            athlete: {id: ATHLETE, fullname: 'Synthetic Rider', sanitizedFullname: 'Synthetic Rider', weight, ftp: file.rider.ftp, cp: file.rider.cp_used, wPrime: file.rider.wprime_used_j, team: 'ZG'},
            state: {
                worldTime: EPOCH + t * 1000,
                distance: WARMUP_M + planM,
                eventDistance: planM,
                time: raceTime,
                speed: state.speed * 3.6,
                power: state.power,
                cadence: state.power > 0 ? 90 : 0,
                heartrate: Math.round(110 + 50 * Math.min(1, state.power / Math.max(1, cp))),
                grade: state.grade,
                eventSubgroupId: SUBGROUP,
                courseId: 6,
                routeId: Number(file.route.id),
                laps: 0,
                roadId: 1,
                roadTime: 0,
                progress: 0,
            },
            stats: {power: {avg: powerN ? powerSum / powerN : 0, np: powerN ? powerSum / powerN : 0, cur: state.power}, speed: {avg: state.speed * 3.6}},
            wBal: wbal,
            eventPosition: 12,
            eventParticipants: 40,
            remaining: Math.max(0, planLengthM - planM),
            remainingMetric: 'distance',
            remainingType: 'event',
            remainingEnd: planLengthM,
            ...extra,
        },
    });
};
const spendWbal = power => {
    // A plain Skiba step, only so the field is not empty; the engine brings its own kernel.
    if (power > cp) {
        wbal -= (power - cp);
    } else {
        wbal = wPrime - (wPrime - wbal) * Math.exp(-(cp - power) / wPrime);
    }
    wbal = Math.max(-wPrime, Math.min(wPrime, wbal));
};

// Pen: stationary, soft pedalling, no event distance, no race time.
for (; t < PEN_SECONDS; t++) {
    spendWbal(80);
    push({speed: 0, power: 80, grade: 0});
}
// Roll-out and the plan. The rider holds each interval's power and speed.
while (planM < planLengthM) {
    const iv = intervalAt(planM);
    const speed = speedOf(iv);
    const power = iv.power_w;
    spendWbal(power);
    lastPower = power;
    push({speed, power, grade: iv.avg_gradient});
    planM = Math.min(planLengthM, planM + speed);
    if (!crossed && planM >= LINE_M) {
        crossed = true;        // the clock starts at the line (assumption A)
    }
    if (crossed) {
        raceTime += 1;
    }
    t++;
}
push({speed: speedOf(intervals[intervals.length - 1]), power: lastPower, grade: 0}, {remaining: 0});
// After the line: freewheel, event distance frozen, clock frozen.
for (let i = 0; i < TAIL_SECONDS; i++) {
    t++;
    push({speed: 8, power: 0, grade: 0}, {remaining: 0});
}

// The rivals, a second at a time, and the nearby rows every NEARBY_EVERY_S.
function simulateRival(rv, lastT) {
    const track = [];
    const release = PEN_SECONDS + rv.releaseS;
    const rcp = cp * rv.factor ** 3;
    let m = 0;
    let race = 0;
    let crossed = false;
    let wb = wPrime;
    let pSum = 0;
    let sSum = 0;
    let n = 0;
    for (let tt = 0; tt <= lastT; tt++) {
        let speed = 0;
        let power = 80;
        let grade = 0;
        const riding = tt >= release && m < planLengthM;
        if (riding) {
            const iv = intervalAt(m);
            speed = speedOf(iv) * rv.factor;
            power = iv.power_w * rv.factor ** 3;
            grade = iv.avg_gradient;
        } else if (m >= planLengthM) {
            speed = 8;
            power = 0;
        }
        wb = power > rcp ? wb - (power - rcp) : wPrime - (wPrime - wb) * Math.exp(-(rcp - power) / wPrime);
        pSum += power;
        sSum += speed;
        n += 1;
        track.push({m, speed, power, grade, race, wb, avgP: pSum / n, avgS: sSum / n});
        if (riding) {
            m = Math.min(planLengthM, m + speed);
            if (!crossed && m >= LINE_M) {
                crossed = true;
            }
            if (crossed) {
                race += 1;
            }
        }
    }
    return track;
}

if (WITH_RIVALS) {
    const lastT = rows[rows.length - 1].t / 1000;
    const tracks = RIVALS.map(rv => simulateRival(rv, lastT));
    const withNearby = [];
    for (const row of rows) {
        withNearby.push(row);
        const tt = row.t / 1000;
        if (tt % NEARBY_EVERY_S !== 0) {
            continue;
        }
        const d = row.d;
        const home = {
            athleteId: d.athleteId, watching: true, self: true, age: 0,
            athlete: {id: d.athleteId, fullname: d.athlete.fullname, sanitizedFullname: d.athlete.sanitizedFullname, team: d.athlete.team, weight: d.athlete.weight, ftp: d.athlete.ftp, wPrime: d.athlete.wPrime},
            state: {worldTime: d.state.worldTime, distance: d.state.distance, eventDistance: d.state.eventDistance, time: d.state.time, speed: d.state.speed, power: d.state.power, grade: d.state.grade, eventSubgroupId: SUBGROUP, courseId: 6, routeId: d.state.routeId},
            stats: {power: {avg: d.stats.power.avg}, speed: {avg: d.stats.speed.avg}},
            wBal: d.wBal,
            race: d.state.time, m: d.state.eventDistance,
        };
        const others = RIVALS.map((rv, i) => {
            const x = tracks[i][tt];
            return {
                athleteId: rv.id, age: 0,
                athlete: {id: rv.id, fullname: rv.name, sanitizedFullname: rv.name, team: rv.team, weight: rv.weight, wPrime},
                state: {worldTime: EPOCH + tt * 1000, distance: WARMUP_M + x.m, eventDistance: x.m, time: x.race, speed: x.speed * 3.6, power: x.power, grade: x.grade, eventSubgroupId: SUBGROUP, courseId: 6, routeId: d.state.routeId},
                stats: {power: {avg: x.avgP}, speed: {avg: x.avgS * 3.6}},
                wBal: x.wb,
                race: x.race, m: x.m,
            };
        });
        // Standings by average race speed since the line; riders still in the pen last.
        const all = [home, ...others];
        const pace = e => (e.race > 0 ? (e.m - LINE_M) / e.race : -1);
        const ranked = [...all].sort((a, b) => pace(b) - pace(a));
        for (const e of all) {
            e.eventPosition = ranked.indexOf(e) + 1;
            e.eventParticipants = all.length;
            delete e.race;
            delete e.m;
        }
        withNearby.push({t: row.t, ch: 'nearby', d: all});
    }
    rows.length = 0;
    rows.push(...withNearby);
}

const meta = {
    t: 0,
    ch: 'meta',
    d: {
        recorder: 'synthetic',
        version: 'make-synthetic-telemetry.mjs',
        startedAt: EPOCH,
        plan: planPath.split('/').pop(),
        route: {id: file.route.id, name: file.route.name},
        synthetic: true,
        assumptions: {
            A_time: `state.time is 0 until the timing line at plan metre ${LINE_M} and counts race seconds from there`,
            B_eventDistance: 'state.eventDistance is the plan metre: 0 in the pen, counting from the pen release',
            C_rpc: 'getEvent/getEventSubgroup shapes are guesses at the Zwift API objects Sauce returns',
            D_physics: 'the rider holds each interval\'s plan power and speed exactly; no response lag',
            E_rivals: WITH_RIVALS ? `${RIVALS.length} made-up riders released ${RIVALS.map(r => r.releaseS).join('/')} s from the home rider at ${RIVALS.map(r => r.factor).join('/')} x the plan's speed; nearby every ${NEARBY_EVERY_S} s` : 'none',
        },
        rows: rows.length,
    },
};
const rpc = [
    {t: 0, ch: 'rpc', d: {method: 'getEventSubgroup', args: [SUBGROUP], result: {
        id: SUBGROUP, eventId: EVENT, name: 'Synthetic TT', subgroupLabel: 'A',
        eventSubgroupStart: new Date(EPOCH + PEN_SECONDS * 1000).toISOString(), ts: EPOCH + PEN_SECONDS * 1000,
        routeId: Number(file.route.id), laps: file.route.laps ?? 1, distanceInMeters: planLengthM, durationInSeconds: 0,
    }}},
    {t: 0, ch: 'rpc', d: {method: 'getEvent', args: [EVENT], result: {
        id: EVENT, name: 'Synthetic TT', eventType: 'TIME_TRIAL', sport: 'CYCLING',
        timeTrialOptions: {timeGapBetweenRowsMs: 5000, maxRidersPerRow: 1},
        routeId: Number(file.route.id), eventSubgroups: [{id: SUBGROUP}],
    }}},
];
writeFileSync(outPath, [meta, ...rpc, ...rows].map(r => JSON.stringify(r)).join('\n') + '\n');
console.error(`${outPath}: ${rows.length} rows, plan ${planLengthM.toFixed(0)} m, race ${raceTime} s (plan ${file.summary.time_seconds} s)`);
