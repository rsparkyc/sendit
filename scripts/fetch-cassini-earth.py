#!/usr/bin/env python3
"""
Fetch the reference data for the Cassini Earth flyby test
(test/cassini-earth.test.ts) and write test/fixtures/cassini-earth.json.

Usage:  python3 scripts/fetch-cassini-earth.py

Cassini passed Earth on 1999-08-18 at ~03:29 TDB, 1171 km above the surface
(~7550 km from the center) at ~19 km/s. Horizons' Cassini (-82) is the
navigation team's reconstruction here: its header lists segment
000331R_SK_V2P12_EP15 (R = reconstructed) for 1999-07-06 16:01 to 1999-08-19
02:00 TDB, then 010420R_SCPSE_EP1_JP83. All samples are kept inside the
first segment (to 08-19 01:00) so no segment seam is crossed.

CASSINI'S SSB STATE IS BUILT AS EARTH (DE441, CENTER=500@0) + CASSINI
RELATIVE TO EARTH (CENTER=500@399), like the Voyager and moon fixtures.
Horizons' own SSB-centred -82 is NOT used: in this period it differs from that
construction by an almost constant 118 km (0.2 mm/s), i.e. its chain to the
SSB is inconsistent with its Earth, and a trajectory taken that way does not
conserve energy about Earth (it shows up as a spurious ~1/r^3 force: one-hour
arcs miss by up to 60 m/s at closest approach). The Earth-relative chain is
the one the tracking-based fit constrains. The size of the difference is
printed when this script runs.

Horizons settings are those of scripts/fetch-horizons.py (geometric states,
VEC_CORR=NONE; ICRF with REF_PLANE=FRAME; TDB; SSB-centred; m, m/s), via
fetch-voyager2-jupiter.py's 9-decimal JD query. Times t are whole seconds TDB
from J2000. Also stored: Sun, Earth and Moon at every sample, to check the
game ephemeris there (0.37 years before J2000, so its drift is negligible).

Only a generic User-Agent is sent; no personal information.
"""
import importlib.util
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
_spec = importlib.util.spec_from_file_location("fetch_v2", ROOT / "scripts/fetch-voyager2-jupiter.py")
v2 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(v2)

HOURLY = (2451395.5, 2451409.5 + 1 / 24)  # 1999-08-05 00:00 .. 08-19 01:00 TDB
TEN_MIN = (2451407.5 + 3 / 24, 2451408.5 + 23 / 24)  # 08-17 03:00 .. 08-18 23:00
ONE_MIN = (2451408.5 + 0.5 / 24, 2451408.5 + 6.5 / 24)  # 08-18 00:30 .. 06:30


def main() -> None:
    ts = sorted(set(v2.grid(*HOURLY, 1 / 24)) | set(v2.grid(*TEN_MIN, 10 / 1440)) | set(v2.grid(*ONE_MIN, 1 / 1440)))
    out = {}
    full = {}
    for name, cmd in [("sun", "10"), ("earth", "399"), ("moon", "301")]:
        print(f"fetching {name}", file=sys.stderr)
        full[name] = v2.many(cmd, ts, "500@0")
    print("fetching cassini", file=sys.stderr)
    geo = v2.many("-82", ts, "500@399")
    ssb = v2.many("-82", ts, "500@0")
    full["cassini"] = [v2.with_bary(e, g) if hasattr(v2, "with_bary") else [a + b for a, b in zip(e, g)] for e, g in zip(full["earth"], geo)]
    off = max(sum((a - b - c) ** 2 for a, b, c in zip(s_[:3], e[:3], g[:3])) ** 0.5 for s_, e, g in zip(ssb, full["earth"], geo))
    print(f"Horizons SSB-centred -82 vs Earth + Earth-centred -82: up to {off / 1e3:.1f} km", file=sys.stderr)
    out = {k: [v2.rnd(x) for x in v] for k, v in full.items()}
    fx = dict(
        description="Cassini Earth flyby reference (see scripts/fetch-cassini-earth.py). Barycentric ICRF, "
        "SI units (m, m/s), t = seconds TDB from J2000.",
        generatedBy="scripts/fetch-cassini-earth.py",
        source="JPL Horizons API: cassini = Earth (399 about 500@0) + -82 about 500@399 (navigation reconstruction segment 000331R_SK_V2P12_EP15); 10, 399, 301 about 500@0; "
        "geometric (VEC_CORR=NONE), ICRF, REF_PLANE=FRAME, TDB, CENTER=500@0",
        t=ts,
        **out,
    )
    path = ROOT / "test/fixtures/cassini-earth.json"
    path.write_text(json.dumps(fx, separators=(",", ":")) + "\n")
    print(f"wrote {path} ({len(ts)} samples)", file=sys.stderr)


if __name__ == "__main__":
    main()
