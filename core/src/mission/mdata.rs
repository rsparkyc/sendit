//! Typed view of core/data/mission-data.json (generated from the TypeScript:
//! launch-sites.json, ASCENT_BODIES, WGS84, EARTH_ROTATION, the world
//! fingerprint, plan limits, the campaign definitions and the vehicles).

use crate::json::{parse, Value};
use crate::mission::objectives::*;
use crate::mission::plan::{Engine, Stage};

#[derive(Clone, Debug)]
pub struct LaunchSite {
    pub id: String,
    pub lat_deg: f64,
    pub lon_deg: f64,
    pub height_m: f64,
    pub azimuth_min_deg: f64,
    pub azimuth_max_deg: f64,
}

#[derive(Clone, Debug)]
pub struct AscentBody {
    pub id: String,
    /// (rho0, scaleHeightM), or None for no atmosphere.
    pub atmosphere: Option<(f64, f64)>,
    pub back_pressure_loss: f64,
    pub drag_area: f64,
    pub powered_insertion_altitude_m: f64,
    pub steps: usize,
}

#[derive(Clone, Debug)]
pub struct BodyInfo {
    pub id: String,
    pub gm: f64,
    pub radius: f64,
    pub reference_radius: f64,
    pub atmosphere: f64,
    pub pole: Option<[f64; 3]>,
    pub rotation: Option<String>,
    pub j2: Option<f64>,
    pub j2_radius: Option<f64>,
}

/// Earth's RotationModel (earth-rotation.ts EARTH_ROTATION): IAU pole, ERA prime meridian.
#[derive(Clone, Debug)]
pub struct EarthRotation {
    pub ra0: f64,
    pub ra1: f64,
    pub dec0: f64,
    pub dec1: f64,
    pub w0: f64,
    pub w_dot: f64,
    pub w1: f64,
}

#[derive(Clone, Debug)]
pub struct Limits {
    pub max_encoded_length: usize,
    pub max_burns: usize,
    pub max_engines: usize,
    pub max_stages: usize,
    pub max_separations: usize,
    pub max_launch_params: usize,
    pub max_duration: f64,
    pub max_epoch: f64,
    pub min_rtol: f64,
    pub max_rtol: f64,
    pub max_mass: f64,
    pub max_thrust: f64,
    pub max_isp: f64,
    pub max_position: f64,
    pub max_velocity: f64,
    pub max_id_length: usize,
    pub direct_c3_range: [f64; 2],
    pub direct_altitude_range: [f64; 2],
    pub direct_params: usize,
}

pub struct MissionData {
    pub physics_model: u32,
    pub fingerprint: String,
    pub checkpoint_version: String,
    pub bodies: Vec<BodyInfo>,
    pub earth_rotation: EarthRotation,
    pub wgs84_a: f64,
    pub wgs84_f: f64,
    pub default_ascent_time_s: f64,
    pub default_downrange_deg: f64,
    pub max_parking_altitude: f64,
    pub sites: Vec<LaunchSite>,
    pub ascent_earth: AscentBody,
    pub ascent_moon: AscentBody,
    pub limits: Limits,
    pub event_nodes: usize,
    pub bisect_max: usize,
    pub vehicles: Vec<(String, Vec<Stage>)>,
    pub campaign: Vec<Mission>,
    pub leaderboard: ServerRules,
}

/// The leaderboard's server rules (server/leaderboard/engine.ts SERVER_RULES) and step budget (config.ts default).
#[derive(Clone, Debug)]
pub struct ServerRules {
    pub launch_only_by_default: bool,
    pub earliest: f64,
    pub latest: f64,
    pub max_duration: f64,
    pub min_rtol: f64,
    pub max_rtol: f64,
    pub max_steps: u64,
}

fn opt_num(v: &Value, k: &str) -> Option<f64> {
    v.get(k).and_then(|x| x.as_f64())
}
fn band(v: &Value) -> [f64; 2] {
    let a = v.nums();
    [a[0], a[1]]
}
fn opt_band(v: &Value, k: &str) -> Option<[f64; 2]> {
    v.get(k).map(band)
}

pub fn stage_of(v: &Value) -> Stage {
    Stage {
        wet_mass: v.num("wetMass"),
        dry_mass: v.num("dryMass"),
        engines: v
            .arr("engines")
            .iter()
            .map(|e| Engine { thrust: e.num("thrust"), isp: e.num("isp"), restartable: e.get("restartable").and_then(|b| b.as_bool()), throttleable: e.get("throttleable").and_then(|b| b.as_bool()) })
            .collect(),
    }
}

fn ascent_body(v: &Value) -> AscentBody {
    AscentBody {
        id: v.str_of("id").into(),
        atmosphere: match v.get("atmosphere") {
            Some(a @ Value::Obj(_)) => Some((a.num("rho0"), a.num("scaleHeightM"))),
            _ => None,
        },
        back_pressure_loss: v.num("backPressureLoss"),
        drag_area: v.num("dragArea"),
        powered_insertion_altitude_m: v.num("poweredInsertionAltitudeM"),
        steps: v.num("steps") as usize,
    }
}

pub fn objective_of(v: &Value) -> Objective {
    let body = || v.str_of("body").to_string();
    match v.str_of("kind") {
        "flyby" => Objective::Flyby { body: body(), min_altitude: opt_num(v, "minAltitude"), max_altitude: opt_num(v, "maxAltitude"), max_speed: opt_num(v, "maxSpeed") },
        "visit" => Objective::Visit { body: body(), within: v.num("within") },
        "orbit" => Objective::Orbit {
            body: body(),
            periapsis: band(v.get("periapsis").unwrap()),
            apoapsis: band(v.get("apoapsis").unwrap()),
            inclination: opt_band(v, "inclination"),
            reference_frame: v.get("reference").and_then(|r| r.as_str()) == Some("frame"),
            revolutions: v.num("revolutions"),
        },
        "reentry" => Objective::Reentry { body: body(), max_speed: opt_num(v, "maxSpeed") },
        "return" => Objective::Return { body: body(), max_altitude: v.num("maxAltitude") },
        "escape" => Objective::Escape { body: body(), min_speed: v.num("minSpeed") },
        "sequence" => Objective::Sequence(v.arr("steps").iter().map(objective_of).collect()),
        "max-delta-v" => Objective::MaxDeltaV(v.num("max")),
        "max-time" => Objective::MaxTime(v.num("max")),
        k => panic!("unknown objective kind {k}"),
    }
}

fn two_body(v: &Value) -> bool {
    v.str_of("circularization") == "two-body"
}

pub fn mission_of(v: &Value) -> Mission {
    let rules = v.get("rules").map(|r| StartRules {
        sites: r.get("sites").map(|s| s.as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect()),
        window: opt_band(r, "window"),
        altitude: opt_band(r, "altitude"),
        launch_only: r.get("launchOnly").and_then(|b| b.as_bool()) == Some(true),
        launch: r.get("launch").map(|l| FixedLaunchRule { altitude_m: l.num("altitudeM"), ascent_time_s: l.num("ascentTimeS"), downrange_deg: l.num("downrangeDeg"), two_body: two_body(l) }),
        vehicle: r.get("vehicle").map(|l| VehicleRule {
            lower_stages: l.arr("lowerStages").iter().map(stage_of).collect(),
            altitude: band(l.get("altitude").unwrap()),
            ascent_time_s: l.num("ascentTimeS"),
            downrange_deg: l.num("downrangeDeg"),
            two_body: two_body(l),
            direct_injection_altitude: l.get("direct").and_then(|d| opt_band(d, "injectionAltitude")),
            direct_c3: l.get("direct").and_then(|d| opt_band(d, "c3")),
        }),
        launch_modes: r.get("launchModes").map(|s| s.as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect()),
        non_restartable_vehicle: r.get("nonRestartableVehicle").and_then(|b| b.as_bool()) == Some(true),
    });
    let sc = v.get("scoring").unwrap();
    Mission {
        id: v.str_of("id").into(),
        title: v.get("title").and_then(|t| t.as_str()).unwrap_or("").to_string(),
        version: opt_num(v, "version"),
        objectives: v.arr("objectives").iter().map(objective_of).collect(),
        scoring: ScoreWeights { delta_v_ref: sc.num("deltaVRef"), delta_v_weight: sc.num("deltaVWeight"), time_ref: sc.num("timeRef"), time_weight: sc.num("timeWeight") },
        spheres: v.get("spheres").map(|s| s.as_array().unwrap().iter().map(|x| (x.str_of("body").to_string(), x.num("radius"))).collect()),
        epoch: opt_num(v, "epoch"),
        start: v.get("start").map(|s| match s.str_of("kind") {
            "launch" => MissionStart::Launch { site: s.str_of("site").into(), azimuth_deg: s.num("azimuthDeg"), altitude_m: s.num("altitudeM") },
            _ => MissionStart::State { center: s.str_of("center").into(), state: s.arr("state").iter().map(|x| x.as_f64().unwrap()).collect() },
        }),
        rules,
        spacecraft: v.get("spacecraft").map(stage_of),
        max_duration: opt_num(v, "maxDuration"),
        atmosphere_is_failure: v.get("atmosphereIsFailure").and_then(|b| b.as_bool()),
        launch_sites: v.get("launchSites").map(|a| {
            a.as_array()
                .unwrap()
                .iter()
                .map(|o| {
                    if o.get("offered").and_then(|b| b.as_bool()) == Some(true) {
                        SiteOption::Offered { site: o.str_of("site").into(), delta_v: opt_num(o, "deltaV"), ascent_delta_v: opt_num(o, "ascentDeltaV"), time: opt_num(o, "time"), max_delta_v: o.num("maxDeltaV"), max_time: o.num("maxTime") }
                    } else {
                        SiteOption::NotOffered { site: o.str_of("site").into(), reason: o.str_of("reason").into() }
                    }
                })
                .collect()
        }),
    }
}

impl MissionData {
    pub fn parse(text: &str) -> MissionData {
        let d = parse(text).expect("mission-data.json");
        let l = d.get("planLimits").unwrap();
        let launch = d.get("launch").unwrap();
        let er = d.get("earthRotation").unwrap();
        let w = d.get("wgs84").unwrap();
        let ab = d.get("ascentBodies").unwrap();
        let ev = d.get("events").unwrap();
        MissionData {
            physics_model: d.num("physicsModel") as u32,
            fingerprint: d.str_of("fingerprint").into(),
            checkpoint_version: d.str_of("checkpointVersion").into(),
            bodies: d
                .arr("bodies")
                .iter()
                .map(|b| BodyInfo {
                    id: b.str_of("id").into(),
                    gm: b.num("gm"),
                    radius: b.num("radius"),
                    reference_radius: b.num("referenceRadius"),
                    atmosphere: b.num("atmosphere"),
                    pole: b.get("pole").and_then(|p| p.as_array()).map(|p| [p[0].as_f64().unwrap(), p[1].as_f64().unwrap(), p[2].as_f64().unwrap()]),
                    rotation: b.get("rotation").and_then(|r| r.as_str()).map(|s| s.to_string()),
                    j2: opt_num(b, "j2"),
                    j2_radius: opt_num(b, "j2Radius"),
                })
                .collect(),
            earth_rotation: EarthRotation { ra0: er.num("ra0"), ra1: er.num("ra1"), dec0: er.num("dec0"), dec1: er.num("dec1"), w0: er.num("w0"), w_dot: er.num("wDot"), w1: er.num("w1") },
            wgs84_a: w.num("a"),
            wgs84_f: w.num("f"),
            default_ascent_time_s: launch.num("defaultAscentTimeS"),
            default_downrange_deg: launch.num("defaultDownrangeDeg"),
            max_parking_altitude: launch.num("maxParkingAltitude"),
            sites: d
                .arr("sites")
                .iter()
                .map(|s| LaunchSite { id: s.str_of("id").into(), lat_deg: s.num("latDeg"), lon_deg: s.num("lonDeg"), height_m: s.num("heightM"), azimuth_min_deg: s.num("azimuthMinDeg"), azimuth_max_deg: s.num("azimuthMaxDeg") })
                .collect(),
            ascent_earth: ascent_body(ab.get("earth").unwrap()),
            ascent_moon: ascent_body(ab.get("moon").unwrap()),
            limits: Limits {
                max_encoded_length: l.num("maxEncodedLength") as usize,
                max_burns: l.num("maxBurns") as usize,
                max_engines: l.num("maxEngines") as usize,
                max_stages: l.num("maxStages") as usize,
                max_separations: l.num("maxSeparations") as usize,
                max_launch_params: l.num("maxLaunchParams") as usize,
                max_duration: l.num("maxDuration"),
                max_epoch: l.num("maxEpoch"),
                min_rtol: l.num("minRtol"),
                max_rtol: l.num("maxRtol"),
                max_mass: l.num("maxMass"),
                max_thrust: l.num("maxThrust"),
                max_isp: l.num("maxIsp"),
                max_position: l.num("maxPosition"),
                max_velocity: l.num("maxVelocity"),
                max_id_length: l.num("maxIdLength") as usize,
                direct_c3_range: band(l.get("directC3Range").unwrap()),
                direct_altitude_range: band(l.get("directAltitudeRange").unwrap()),
                direct_params: l.num("directParams") as usize,
            },
            event_nodes: ev.num("nodes") as usize,
            bisect_max: ev.num("bisectMax") as usize,
            vehicles: d.arr("vehicles").iter().map(|v| (v.str_of("id").to_string(), v.arr("stages").iter().map(stage_of).collect())).collect(),
            campaign: d.arr("campaign").iter().map(mission_of).collect(),
            leaderboard: {
                let b = d.get("leaderboard").unwrap();
                ServerRules {
                    launch_only_by_default: b.get("launchOnlyByDefault").and_then(|x| x.as_bool()) == Some(true),
                    earliest: b.num("earliest"),
                    latest: b.num("latest"),
                    max_duration: b.num("maxDuration"),
                    min_rtol: b.num("minRtol"),
                    max_rtol: b.num("maxRtol"),
                    max_steps: b.num("maxSteps") as u64,
                }
            },
        }
    }

    pub fn site(&self, id: &str) -> Option<&LaunchSite> {
        self.sites.iter().find(|s| s.id == id)
    }
    pub fn mission(&self, id: &str) -> Option<&Mission> {
        self.campaign.iter().find(|m| m.id == id)
    }
}
