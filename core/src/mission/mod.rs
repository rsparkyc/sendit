//! Phase two, layer two: the mission layer replay needs (plan codec and
//! validation, mission data; launch, ascent, events, replay and scoring to
//! follow). Each sub-layer is proven against vectors exported from the
//! TypeScript before the next is ported (see core/README.md).

pub mod jsfmt;
pub mod mdata;
pub mod objectives;
pub mod plan;
