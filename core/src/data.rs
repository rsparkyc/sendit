//! The built-in data, generated from the TypeScript sources by
//! core/ts/gen-data.vec.ts (never edited by hand): the world description
//! (data/world.txt) and the mission-layer tables (data/mission-data.json).

use crate::cheb::ChebEphemeris;
use crate::chunk::{decode_checkpoint_asset, initial_checkpoint, ChunkBuilder};
use crate::fixture::World;
use crate::spacecraft::ForceModel;

pub const WORLD_TXT: &str = include_str!("../data/world.txt");
pub const MISSION_JSON: &str = include_str!("../data/mission-data.json");

pub fn world() -> World {
    World::parse(WORLD_TXT)
}

/// An ephemeris that builds its own chunks (from the epoch, or from the
/// checkpoint asset's checkpoints when `asset` is given), and the spacecraft
/// force model, of a world.
pub fn ephemeris(world: &World, asset: Option<&[u8]>, expected_version: Option<&str>) -> Result<(ChebEphemeris, ForceModel), String> {
    let mut eph = ChebEphemeris::new(world.layout.clone(), world.gm.clone(), world.t0);
    let mut b = ChunkBuilder::new(world.layout.clone(), world.gm.clone(), world.nbody.clone(), world.t0, initial_checkpoint(&world.initial));
    if let Some(bytes) = asset {
        let a = decode_checkpoint_asset(bytes)?;
        if let Some(v) = expected_version {
            if a.version != v {
                return Err(format!("checkpoint asset version {} does not match this ephemeris ({v})", a.version));
            }
        }
        if a.bodies != world.body_ids {
            return Err("checkpoint asset body list does not match".into());
        }
        for cp in a.checkpoints {
            b.add_checkpoint(cp);
        }
    }
    eph.builder = Some(b);
    let fm = ForceModel::new(&world.gm, &world.fields, world.relativity);
    Ok((eph, fm))
}
