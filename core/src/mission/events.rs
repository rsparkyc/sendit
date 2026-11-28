//! Trajectory events (src/mission/events.ts): extrema of distance and
//! threshold crossings found from the integrator's dense output, with the
//! same nodes, bisection cap, bracket conventions and event order.

use crate::dop853::DopError;
use crate::mission::jsfmt::num;

pub const NODES: usize = 4;
pub const BISECT_MAX: usize = 80;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EventKind {
    Periapsis,
    Apoapsis,
    Impact,
    AtmosphereEntry,
    AtmosphereExit,
    Enter,
    Exit,
}
impl EventKind {
    pub fn name(self) -> &'static str {
        match self {
            EventKind::Periapsis => "periapsis",
            EventKind::Apoapsis => "apoapsis",
            EventKind::Impact => "impact",
            EventKind::AtmosphereEntry => "atmosphere-entry",
            EventKind::AtmosphereExit => "atmosphere-exit",
            EventKind::Enter => "enter",
            EventKind::Exit => "exit",
        }
    }
    fn order(self) -> i32 {
        match self {
            EventKind::Impact => 0,
            EventKind::AtmosphereEntry => 1,
            EventKind::AtmosphereExit => 2,
            EventKind::Enter => 3,
            EventKind::Exit => 4,
            EventKind::Periapsis => 5,
            EventKind::Apoapsis => 6,
        }
    }
}

#[derive(Clone, Debug)]
pub struct TrajectoryEvent {
    pub kind: EventKind,
    pub t: f64,
    pub body: String,
    pub distance: f64,
    pub altitude: f64,
    pub speed: f64,
    pub rel: [f64; 6],
    pub mass: f64,
    pub sphere: Option<f64>,
}

/// What the finder needs: the step's interpolant and the ephemeris.
pub trait StepEnv {
    fn interp(&mut self, t: f64, out: &mut [f64]) -> Result<(), DopError>;
    fn body_state(&mut self, body: usize, t: f64, out: &mut [f64]);
}

impl<E: crate::spacecraft::Ephemeris> StepEnv for crate::spacecraft::StepView<'_, '_, E> {
    fn interp(&mut self, t: f64, out: &mut [f64]) -> Result<(), DopError> {
        self.interpolate(t, out)
    }
    fn body_state(&mut self, body: usize, t: f64, out: &mut [f64]) {
        crate::spacecraft::StepView::body_state(self, body, t, out)
    }
}

/// An ephemeris outside a step (EventFinder.start: no interpolant).
pub struct NoStep<'a, E: crate::spacecraft::Ephemeris>(pub &'a mut E);
impl<E: crate::spacecraft::Ephemeris> StepEnv for NoStep<'_, E> {
    fn interp(&mut self, _t: f64, _out: &mut [f64]) -> Result<(), DopError> {
        panic!("no step");
    }
    fn body_state(&mut self, body: usize, t: f64, out: &mut [f64]) {
        self.0.body_state(body, t, out)
    }
}

#[derive(Clone, Copy)]
struct Threshold {
    radius: f64,
    inward: Option<EventKind>,
    outward: Option<EventKind>,
    sphere: bool,
}

/// A body of the mission world (id, reference radius, atmosphere top).
pub struct WorldBody<'a> {
    pub id: &'a str,
    pub radius: f64,
    pub atmosphere: f64,
}

#[derive(Clone, Copy, PartialEq)]
enum Holds {
    Lt0,
    Gt0,
    Le0,
}

pub struct EventFinder {
    pub events: Vec<TrajectoryEvent>,
    watch: Vec<usize>,
    ids: Vec<String>,
    radii: Vec<f64>,
    thresholds: Vec<Vec<Threshold>>,
    sc: [f64; 7],
    bs: [f64; 6],
    rel: [f64; 6],
    node_t: [f64; NODES + 1],
    node_y: [[f64; 7]; NODES + 1],
    in_step: bool,
}

impl EventFinder {
    /// `bodies`: the watch list (None: every body); `spheres`: (body id, radius).
    pub fn new(world: &[WorldBody<'_>], bodies: Option<&[String]>, spheres: &[(String, f64)], stop_on_atmosphere: bool) -> Result<EventFinder, String> {
        let ids: Vec<String> = match bodies {
            Some(b) => b.to_vec(),
            None => world.iter().map(|b| b.id.to_string()).collect(),
        };
        let mut f = EventFinder {
            events: Vec::new(),
            watch: Vec::new(),
            ids: Vec::new(),
            radii: Vec::new(),
            thresholds: Vec::new(),
            sc: [0.0; 7],
            bs: [0.0; 6],
            rel: [0.0; 6],
            node_t: [0.0; NODES + 1],
            node_y: [[0.0; 7]; NODES + 1],
            in_step: false,
        };
        for id in ids {
            let i = world.iter().position(|b| b.id == id).ok_or_else(|| format!("events: unknown body {id}"))?;
            let b = &world[i];
            let mut th = vec![Threshold { radius: b.radius, inward: Some(EventKind::Impact), outward: None, sphere: false }];
            if b.atmosphere > 0.0 {
                th.push(Threshold {
                    radius: b.radius + b.atmosphere,
                    inward: Some(EventKind::AtmosphereEntry),
                    outward: if stop_on_atmosphere { None } else { Some(EventKind::AtmosphereExit) },
                    sphere: false,
                });
            }
            f.watch.push(i);
            f.ids.push(id);
            f.radii.push(b.radius);
            f.thresholds.push(th);
        }
        for (body, radius) in spheres {
            let k = f.ids.iter().position(|x| x == body).ok_or_else(|| format!("events: sphere around unwatched or unknown body {body}"))?;
            if !(*radius > 0.0) || *radius == f64::INFINITY {
                return Err(format!("events: bad sphere radius {}", num(*radius)));
            }
            f.thresholds[k].push(Threshold { radius: *radius, inward: Some(EventKind::Enter), outward: Some(EventKind::Exit), sphere: true });
        }
        Ok(f)
    }

    pub fn start(&mut self, env: &mut dyn StepEnv, t: f64, y: &[f64]) -> Option<TrajectoryEvent> {
        for k in 0..self.watch.len() {
            self.sc.copy_from_slice(&y[..7]);
            self.relative(env, k, t);
            let d2 = self.d2();
            for j in 0..self.thresholds[k].len() {
                let th = self.thresholds[k][j];
                if let Some(kind) = th.inward {
                    if !th.sphere && th.outward.is_none() && d2 <= th.radius * th.radius {
                        let ev = self.make(env, kind, t, k, None).expect("no interpolation at start");
                        self.events.push(ev.clone());
                        return Some(ev);
                    }
                }
            }
        }
        None
    }

    pub fn step(&mut self, env: &mut dyn StepEnv, t: f64, t_prev: f64) -> Result<Option<TrajectoryEvent>, DopError> {
        self.in_step = true;
        let r = self.step_inner(env, t, t_prev);
        self.in_step = false;
        r
    }

    fn step_inner(&mut self, env: &mut dyn StepEnv, t: f64, t_prev: f64) -> Result<Option<TrajectoryEvent>, DopError> {
        let h = t - t_prev;
        for i in 0..=NODES {
            self.node_t[i] = if i == 0 {
                t_prev
            } else if i == NODES {
                t
            } else {
                t_prev + (h * i as f64) / NODES as f64
            };
            let nt = self.node_t[i];
            env.interp(nt, &mut self.node_y[i])?;
        }
        let mut found: Vec<TrajectoryEvent> = Vec::new();
        let mut g = [0.0f64; NODES + 1];
        for k in 0..self.watch.len() {
            for i in 0..=NODES {
                self.sc = self.node_y[i];
                let nt = self.node_t[i];
                self.relative(env, k, nt);
                g[i] = self.rv();
            }
            let mut bt: Vec<f64> = vec![t_prev];
            for i in 0..NODES {
                let a = g[i];
                let b = g[i + 1];
                let is_min = a < 0.0 && b >= 0.0;
                let is_max = a > 0.0 && b <= 0.0;
                if !is_min && !is_max {
                    continue;
                }
                let (na, nb) = (self.node_t[i], self.node_t[i + 1]);
                let tr = self.bisect(env, k, na, nb, if is_min { Holds::Lt0 } else { Holds::Gt0 }, None)?;
                found.push(self.make(env, if is_min { EventKind::Periapsis } else { EventKind::Apoapsis }, tr, k, None)?);
                if tr > bt[bt.len() - 1] && tr < t {
                    bt.push(tr);
                }
            }
            bt.push(t);
            let mut bd2 = Vec::with_capacity(bt.len());
            for &tb in &bt {
                bd2.push(self.d2_at(env, k, tb)?);
            }
            for j in 0..self.thresholds[k].len() {
                let th = self.thresholds[k][j];
                let r2 = th.radius * th.radius;
                let mut p = 0;
                while p + 1 < bt.len() {
                    let sa = bd2[p] - r2;
                    let sb = bd2[p + 1] - r2;
                    let sphere = if th.sphere { Some(th.radius) } else { None };
                    if sa > 0.0 && sb <= 0.0 && th.inward.is_some() {
                        let tr = self.bisect(env, k, bt[p], bt[p + 1], Holds::Gt0, Some(r2))?;
                        found.push(self.make(env, th.inward.unwrap(), tr, k, sphere)?);
                    } else if sa <= 0.0 && sb > 0.0 && th.outward.is_some() {
                        let tr = self.bisect(env, k, bt[p], bt[p + 1], Holds::Le0, Some(r2))?;
                        found.push(self.make(env, th.outward.unwrap(), tr, k, sphere)?);
                    }
                    p += 1;
                }
            }
        }
        found.sort_by(|x, y| {
            use std::cmp::Ordering::*;
            if x.t != y.t {
                return if x.t < y.t { Less } else { Greater };
            }
            let d = x.kind.order() - y.kind.order();
            if d != 0 {
                return if d < 0 { Less } else { Greater };
            }
            if x.body < y.body {
                Less
            } else if x.body > y.body {
                Greater
            } else {
                Equal
            }
        });
        for ev in found {
            let terminal = ev.kind == EventKind::Impact || (ev.kind == EventKind::AtmosphereEntry && self.is_terminal_atm(&ev.body));
            self.events.push(ev.clone());
            if terminal {
                return Ok(Some(ev));
            }
        }
        Ok(None)
    }

    fn is_terminal_atm(&self, id: &str) -> bool {
        let k = self.ids.iter().position(|x| x == id).unwrap();
        for x in &self.thresholds[k] {
            if x.inward == Some(EventKind::AtmosphereEntry) {
                return x.outward.is_none();
            }
        }
        false
    }

    fn bisect(&mut self, env: &mut dyn StepEnv, k: usize, a: f64, b: f64, holds: Holds, r2: Option<f64>) -> Result<f64, DopError> {
        let mut lo = a;
        let mut hi = b;
        for _ in 0..BISECT_MAX {
            let mid = lo + (hi - lo) * 0.5;
            if !(mid > lo && mid < hi) {
                break;
            }
            env.interp(mid, &mut self.sc)?;
            self.relative(env, k, mid);
            let f = match r2 {
                None => self.rv(),
                Some(r2) => self.d2() - r2,
            };
            let ok = match holds {
                Holds::Lt0 => f < 0.0,
                Holds::Gt0 => f > 0.0,
                Holds::Le0 => f <= 0.0,
            };
            if ok {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        Ok(hi)
    }

    fn d2_at(&mut self, env: &mut dyn StepEnv, k: usize, t: f64) -> Result<f64, DopError> {
        env.interp(t, &mut self.sc)?;
        self.relative(env, k, t);
        Ok(self.d2())
    }

    fn relative(&mut self, env: &mut dyn StepEnv, k: usize, t: f64) {
        env.body_state(self.watch[k], t, &mut self.bs);
        for j in 0..6 {
            self.rel[j] = self.sc[j] - self.bs[j];
        }
    }

    fn rv(&self) -> f64 {
        let r = &self.rel;
        r[0] * r[3] + r[1] * r[4] + r[2] * r[5]
    }

    fn d2(&self) -> f64 {
        let r = &self.rel;
        r[0] * r[0] + r[1] * r[1] + r[2] * r[2]
    }

    fn make(&mut self, env: &mut dyn StepEnv, kind: EventKind, t: f64, k: usize, sphere: Option<f64>) -> Result<TrajectoryEvent, DopError> {
        if self.in_step {
            env.interp(t, &mut self.sc)?;
        }
        self.relative(env, k, t);
        let r = self.rel;
        let distance = self.d2().sqrt();
        let speed = (r[3] * r[3] + r[4] * r[4] + r[5] * r[5]).sqrt();
        Ok(TrajectoryEvent { kind, t, body: self.ids[k].clone(), distance, altitude: distance - self.radii[k], speed, rel: r, mass: self.sc[6], sphere })
    }
}
