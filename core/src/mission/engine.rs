//! The browser engine's replay call: src/app/mission-layer.ts
//! replayWithSamples (the scoring replay plus dense-output trajectory samples
//! taken from inside it) and src/app/replay-options.ts replayOptions (a
//! campaign mission's options, or the sandbox spheres). Same sampling times,
//! same de-duplication, same trimming at the end of the flight.

use crate::mission::events::StepEnv;
use crate::mission::mdata::MissionData;
use crate::mission::objectives::mission_replay_options;
use crate::mission::replay::{replay, MissionWorld, ReplayOptions, ReplayResult};
use crate::mission::sandbox::sandbox_spheres;
use crate::mission::plan::Plan;

/// Sample layout: t, x, y, z, vx, vy, vz, mass (REPLAY_SAMPLE_STRIDE).
pub const STRIDE: usize = 8;

/// replay-options.ts replayOptions: a campaign mission's (missionReplayOptions),
/// or the sandbox spheres for "sandbox" (and any id that is not a campaign mission,
/// as missionById(...)?.def ?? null does for the app's own list).
pub fn replay_options_for(d: &MissionData, mission_id: &str, state0: &[f64]) -> ReplayOptions {
    match d.mission(mission_id) {
        Some(m) => mission_replay_options(m),
        None => ReplayOptions { spheres: sandbox_spheres(d, state0), ..Default::default() },
    }
}

fn push(out: &mut Vec<f64>, last: &mut f64, t: f64, y: &[f64]) {
    if !(t > *last) {
        return;
    }
    *last = t;
    out.push(t);
    out.extend_from_slice(&y[..7]);
}

/// mission-layer.ts replayWithSamples (without cancellation): the result and
/// STRIDE numbers per sample, strictly increasing t, ending at result.final_t.
pub fn replay_with_samples(plan: &Plan, world: &mut MissionWorld<'_>, opts: &ReplayOptions, per_step: u32) -> (ReplayResult, Vec<f64>) {
    let out = std::cell::RefCell::new(Vec::<f64>::new());
    let last = std::cell::Cell::new(f64::NEG_INFINITY);
    let result = {
        let mut on_start = |t: f64, y: &[f64]| {
            let mut l = last.get();
            push(&mut out.borrow_mut(), &mut l, t, y);
            last.set(l);
        };
        let mut tmp = [0.0f64; 7];
        let ps = per_step as f64;
        let mut on_step = |t: f64, t_prev: f64, env: &mut dyn StepEnv| {
            for i in 1..=per_step {
                let ti = if i == per_step { t } else { t_prev + ((t - t_prev) * i as f64) / ps };
                env.interp(ti, &mut tmp).expect("dense output inside the step");
                let mut l = last.get();
                push(&mut out.borrow_mut(), &mut l, ti, &tmp);
                last.set(l);
            }
        };
        replay(plan, world, opts, Some(&mut on_start), Some(&mut on_step))
    };
    let mut out = out.into_inner();
    let end = result.final_t;
    let mut n = out.len() / STRIDE;
    if end.is_finite() {
        while n > 0 && out[(n - 1) * STRIDE] > end {
            n -= 1;
        }
        if result.final_state.len() == 7 && (n == 0 || out[(n - 1) * STRIDE] < end) {
            out.truncate(n * STRIDE);
            out.push(end);
            out.extend_from_slice(&result.final_state);
            n += 1;
        }
    }
    out.truncate(n * STRIDE);
    (result, out)
}
