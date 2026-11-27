//! Mission and objective types (src/mission/objectives.ts, campaign.ts),
//! filled from core/data/mission-data.json by mdata.rs. Evaluation of the
//! objectives is layer two, step five (not yet ported).

use crate::mission::plan::Stage;

#[derive(Clone, Debug, PartialEq)]
pub enum Objective {
    Flyby { body: String, min_altitude: Option<f64>, max_altitude: Option<f64>, max_speed: Option<f64> },
    Visit { body: String, within: f64 },
    Orbit { body: String, periapsis: [f64; 2], apoapsis: [f64; 2], inclination: Option<[f64; 2]>, reference_frame: bool, revolutions: f64 },
    Reentry { body: String, max_speed: Option<f64> },
    Return { body: String, max_altitude: f64 },
    Escape { body: String, min_speed: f64 },
    Sequence(Vec<Objective>),
    MaxDeltaV(f64),
    MaxTime(f64),
}

#[derive(Clone, Debug, PartialEq)]
pub struct ScoreWeights {
    pub delta_v_ref: f64,
    pub delta_v_weight: f64,
    pub time_ref: f64,
    pub time_weight: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FixedLaunchRule {
    pub altitude_m: f64,
    pub ascent_time_s: f64,
    pub downrange_deg: f64,
    pub two_body: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct VehicleRule {
    pub lower_stages: Vec<Stage>,
    pub altitude: [f64; 2],
    pub ascent_time_s: f64,
    pub downrange_deg: f64,
    pub two_body: bool,
    pub direct_injection_altitude: Option<[f64; 2]>,
    pub direct_c3: Option<[f64; 2]>,
}

#[derive(Clone, Debug, PartialEq, Default)]
pub struct StartRules {
    pub sites: Option<Vec<String>>,
    pub window: Option<[f64; 2]>,
    pub altitude: Option<[f64; 2]>,
    pub launch_only: bool,
    pub launch: Option<FixedLaunchRule>,
    pub vehicle: Option<VehicleRule>,
    pub launch_modes: Option<Vec<String>>,
    pub non_restartable_vehicle: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub enum MissionStart {
    Launch { site: String, azimuth_deg: f64, altitude_m: f64 },
    State { center: String, state: Vec<f64> },
}

#[derive(Clone, Debug, PartialEq)]
pub enum SiteOption {
    Offered { site: String, max_delta_v: f64, max_time: f64 },
    NotOffered { site: String, reason: String },
}

#[derive(Clone, Debug, PartialEq)]
pub struct Mission {
    pub id: String,
    pub version: Option<f64>,
    pub objectives: Vec<Objective>,
    pub scoring: ScoreWeights,
    pub spheres: Option<Vec<(String, f64)>>,
    pub epoch: Option<f64>,
    pub start: Option<MissionStart>,
    pub rules: Option<StartRules>,
    pub spacecraft: Option<Stage>,
    pub max_duration: Option<f64>,
    pub atmosphere_is_failure: Option<bool>,
    pub launch_sites: Option<Vec<SiteOption>>,
}
