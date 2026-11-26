#!/usr/bin/env python3
"""
Fetch the reference data for the Voyager 2 Jupiter flyby test
(test/voyager2-jupiter.test.ts) and write test/fixtures/voyager2-jupiter.json.

Usage:  python3 scripts/fetch-voyager2-jupiter.py

REFERENCE TRAJECTORY. NOT the Horizons trajectory of -32. Before 1989-08-29
Horizons serves, in its own words, "a patched conic mission-design type
trajectory in which the conics were constructed to approximately match
specific events ... providing a rough accuracy" (Horizons -32 header, 2022
revision). It differs from the navigation reconstruction below by ~300 km at
closest approach and ~2700 km three weeks earlier, and a patched conic is
exactly the approximation this project refuses. It is stored here, coarsely,
only to document that difference.

The reference is NAIF's vgr2_jup230.bsp
(https://naif.jpl.nasa.gov/pub/naif/VOYAGER/kernels/spk/vgr2_jup230.bsp):
Voyager 2 relative to the Jupiter system barycenter (NAIF 5), J2000 equatorial
axes, 1979-06-04 17:00 to 1979-07-21 00:00 ET, SPK type 1 (modified
difference arrays) converted by NIO2SPK from the Voyager navigation team's
integrated trajectory file vgr2.jup230.nio (the jup230 Jovian satellite
ephemeris solution). It is a numerically integrated, tracking-fitted
trajectory, so maneuvers and modelled non-gravitational forces are in it. The
type 1 evaluator below is a transcription of SPICE SPKE01. J2000 and ICRF axes
differ by < 0.02 arcsec (< 0.1 km at 1e6 km): ignored.

Barycentric (SSB) states of the spacecraft are built as Horizons' (DE441)
Jupiter system barycenter + the SPK state, the same construction
solar-system.ts uses for planets and moons. The 1979 navigation used an older
planetary ephemeris; its Jupiter-barycenter offset from DE441 cancels in
every Jupiter-relative quantity and enters heliocentric velocities only at the
mm/s level.

Also fetched from Horizons (EPHEM_TYPE=VECTORS, VEC_CORR=NONE i.e. geometric,
REF_SYSTEM=ICRF with REF_PLANE=FRAME (without it Horizons returns ecliptic
axes), TIME_TYPE=TDB, km and km/s converted to m and m/s):
  * Sun (10) and Jupiter system barycenter (5) about the SSB at every sample.
  * Io..Callisto (501..504) and Jupiter (599) about the Jupiter barycenter,
    within +-3 days of closest approach (moon flybys).
  * The state of every body of J2000_BODIES at EPOCH_B, constructed exactly as
    scripts/fetch-horizons.py constructs the J2000 initial conditions
    (system barycenter from DE441 + satellite-relative states; the planet as
    the centre of mass of planet + unmodelled moons). Used to start a
    test-only ephemeris close to the encounter (variant b).

Times: t = seconds TDB from J2000 (SPK ET is TDB seconds from J2000).
Only a generic User-Agent is sent; no personal information.
"""
import bisect
import importlib.util
import json
import pathlib
import struct
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
_spec = importlib.util.spec_from_file_location("fetch_horizons", ROOT / "scripts/fetch-horizons.py")
fh = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fh)

SPK_URL = "https://naif.jpl.nasa.gov/pub/naif/VOYAGER/kernels/spk/vgr2_jup230.bsp"
JD_J2000 = fh.JD_J2000
EPOCH_B_JD = 2444029.5  # 1979-06-05 00:00 TDB, just after the SPK starts
HOURLY = (2444029.5, 2444075.5)  # 1979-06-05 00:00 .. 1979-07-21 00:00 TDB
DENSE = (2444063.5 + 10 / 24, 2444064.5 + 11 / 24)  # 1979-07-09 10:00 .. 07-10 11:00, closest approach ~22:30
DENSE_STEP_MIN = 5
MOON_WINDOW = (2444061.5, 2444067.5)  # 07-07 .. 07-13
COARSE_STEP_H = 6


def get_bytes(url: str) -> bytes:
    import urllib.request
    req = urllib.request.Request(url, headers=fh.UA)
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


class Spk1:
    """Single-segment SPK type 1 reader (DAF little or big endian)."""

    def __init__(self, data: bytes):
        r1 = data[:1024]
        e = "<" if r1[88:96] == b"LTL-IEEE" else ">"
        nd, ni = struct.unpack(e + "ii", r1[8:16])
        fward = struct.unpack(e + "i", r1[76:80])[0]
        assert (nd, ni) == (2, 6)
        rec = data[(fward - 1) * 1024: fward * 1024]
        if int(struct.unpack(e + "d", rec[16:24])[0]) != 1:
            sys.exit("expected one segment")
        self.start, self.stop = struct.unpack(e + "2d", rec[24:40])
        self.target, self.center, self.frame, typ, a, b = struct.unpack(e + "6i", rec[40:64])
        if typ != 1 or self.frame != 1 or self.target != -32 or self.center != 5:
            sys.exit(f"unexpected segment {self.target} {self.center} {self.frame} {typ}")
        arr = struct.unpack(e + "%dd" % (b - a + 1), data[(a - 1) * 8: b * 8])
        n = int(arr[-1])
        self.recs = [arr[71 * k: 71 * k + 71] for k in range(n)]
        self.ends = arr[71 * n: 72 * n]
        comment = b"".join(data[i * 1024: i * 1024 + 1000] for i in range(1, fward - 1))
        self.comment = comment.replace(b"\x00", b"\n").decode("latin1").strip()

    def state(self, et: float) -> list:
        """SPICE SPKE01: km, km/s."""
        if not (self.start <= et <= self.stop):
            sys.exit(f"et {et} outside SPK coverage")
        i = min(bisect.bisect_left(self.ends, et), len(self.recs) - 1)
        R = self.recs[i]
        tl, g = R[0], R[1:16]
        refpos, refvel = [R[16], R[18], R[20]], [R[17], R[19], R[21]]
        dt = [R[22 + 15 * k: 37 + 15 * k] for k in range(3)]
        kqmax1 = int(R[67])
        kq = [int(x) for x in R[68:71]]
        delta = et - tl
        tp = delta
        ks = kqmax1 - 1
        fc, wc, w = [0.0] * 20, [0.0] * 20, [0.0] * 20
        fc[1] = 1.0
        for j in range(1, kqmax1 - 1):
            fc[j + 1] = tp / g[j - 1]
            wc[j] = delta / g[j - 1]
            tp = delta + g[j - 1]
        for j in range(1, kqmax1 + 1):
            w[j] = 1.0 / j
        jx, ks1 = 0, ks - 1
        while ks >= 2:
            jx += 1
            for j in range(1, jx + 1):
                w[j + ks] = fc[j + 1] * w[j + ks - 1] - wc[j] * w[j + ks]
            ks, ks1 = ks1, ks1 - 1
        out = [0.0] * 6
        for c in range(3):
            s = sum(dt[c][j - 1] * w[j + ks] for j in range(kq[c], 0, -1))
            out[c] = refpos[c] + delta * (refvel[c] + delta * s)
        for j in range(1, jx + 1):
            w[j + ks] = fc[j + 1] * w[j + ks - 1] - wc[j] * w[j + ks]
        ks -= 1
        for c in range(3):
            s = sum(dt[c][j - 1] * w[j + ks] for j in range(kq[c], 0, -1))
            out[3 + c] = refvel[c] + delta * s
        return out


def secs(jd: float) -> int:
    """Whole seconds TDB from J2000 (all grid points are whole minutes)."""
    return round((jd - JD_J2000) * 86400.0)


def grid(a: float, b: float, step_days: float) -> list:
    """Times in integer seconds from J2000, so samples land exactly on them."""
    t0, t1, st = secs(a), secs(b), round(step_days * 86400)
    return list(range(t0, t1 + 1, st))


def jd_of(t: int) -> float:
    return JD_J2000 + t / 86400.0


def vectors9(command: str, ts: list, center: str) -> list:
    """As fetch-horizons.vectors, but with 9-decimal JDs: its 6-decimal TLIST
    rounds times by up to 43 ms, i.e. ~0.7 km of spacecraft motion at 15 km/s."""
    import urllib.parse
    params = {
        "format": "json", "COMMAND": f"'{command}'", "OBJ_DATA": "NO", "MAKE_EPHEM": "YES",
        "EPHEM_TYPE": "VECTORS", "CENTER": f"'{center}'", "REF_SYSTEM": "ICRF", "REF_PLANE": "FRAME",
        "VEC_TABLE": "2", "VEC_CORR": "NONE", "OUT_UNITS": "KM-S", "TIME_TYPE": "TDB",
        "CSV_FORMAT": "YES", "VEC_LABELS": "NO", "TLIST_TYPE": "JD",
        "TLIST": " ".join(f"'{jd_of(t):.9f}'" for t in ts),
    }
    res = json.loads(fh.get(fh.API + "?" + urllib.parse.urlencode(params)))["result"]
    if "$$SOE" not in res:
        sys.exit(f"Horizons error for {command}:\n{res}")
    rows = res.split("$$SOE")[1].split("$$EOE")[0].strip().splitlines()
    out = []
    for row, t in zip(rows, ts):
        f = [c.strip() for c in row.split(",")]
        if abs((float(f[0]) - JD_J2000) * 86400.0 - t) > 1e-3:
            sys.exit(f"time mismatch {f[0]} {t}")
        out.append([float(x) * 1000.0 for x in f[2:8]])
    if len(out) != len(ts):
        sys.exit(f"{command}: expected {len(ts)} rows, got {len(out)}")
    return out


def many(command: str, ts: list, center: str) -> list:
    out = []
    for k in range(0, len(ts), 40):
        out += vectors9(command, ts[k: k + 40], center)
    return out


def bodies_at(jd: float) -> list:
    """Every body of the J2000 set at jd, built as fetch-horizons.py builds J2000."""
    data = json.loads((ROOT / "src/physics/data/solar-system-j2000.json").read_text())
    by_id = {b["id"]: b for b in fh.BODIES}
    systems = {s["id"]: s for s in fh.SYSTEMS}
    out = {}
    for sysd in fh.SYSTEMS:
        if sysd["cmt"] is None:
            continue  # Earth-Moon: SSB-centred DE441 states, as in fetch-horizons.py
        gms = fh.cmt_body_gms(sysd["cmt"])
        out.update(fh.system_members_at(sysd, jd, gms, by_id[sysd["id"]]["horizons"]))
    for b in data["bodies"]:
        if b["id"] not in out:
            if b["id"] in systems and systems[b["id"]]["cmt"] is not None:
                sys.exit("unexpected")
            out[b["id"]] = fh.vectors(b["horizonsId"], [jd])[0]["state"]
    return [dict(id=b["id"], state=out[b["id"]]) for b in data["bodies"]]


def rnd(state: list) -> list:
    """Round to 1 mm and 1 um/s (far below every residual studied) to keep the fixture small."""
    return [round(x, 3) for x in state[:3]] + [round(v, 6) for v in state[3:]]


def main() -> None:
    print("fetching SPK", file=sys.stderr)
    spk = Spk1(get_bytes(SPK_URL))
    jds = sorted(set(grid(*HOURLY, 1 / 24)) | set(grid(*DENSE, DENSE_STEP_MIN / 1440)))  # seconds
    rel = [[x * 1000.0 for x in spk.state(float(t))] for t in jds]
    print("fetching Sun and Jupiter barycenter", file=sys.stderr)
    sun = many("10", jds, "500@0")
    jbar = many("5", jds, "500@0")
    moon_jds = [t for t in jds if secs(MOON_WINDOW[0]) <= t <= secs(MOON_WINDOW[1])]
    moons = {}
    for naif, mid in [("501", "io"), ("502", "europa"), ("503", "ganymede"), ("504", "callisto"), ("599", "jupiter")]:
        print(f"fetching {mid}", file=sys.stderr)
        moons[mid] = many(naif, moon_jds, "500@5")
    coarse = grid(HOURLY[0], HOURLY[1], COARSE_STEP_H / 24)
    print("fetching Horizons -32 (patched conic)", file=sys.stderr)
    hz32 = many("-32", coarse, "500@5")
    print("fetching bodies at epoch B", file=sys.stderr)
    bodies = bodies_at(EPOCH_B_JD)

    fx = dict(
        description="Voyager 2 Jupiter flyby reference (see scripts/fetch-voyager2-jupiter.py). "
        "SI units (m, m/s), ICRF (J2000) equatorial axes, t = seconds TDB from J2000.",
        generatedBy="scripts/fetch-voyager2-jupiter.py",
        spacecraftSource=SPK_URL + " (navigation reconstruction, SPK type 1, center 5, frame J2000)",
        spkComment=spk.comment,
        bodySource="JPL Horizons API, geometric (VEC_CORR=NONE), ICRF, REF_PLANE=FRAME, TDB",
        samples=[dict(t=t, scRelJupBary=rnd(r), jupBary=rnd(j), sun=rnd(s)) for t, r, j, s in zip(jds, rel, jbar, sun)],
        moons=dict(t=moon_jds, relJupBary={k: [rnd(x) for x in v] for k, v in moons.items()}),
        horizonsPatchedConic=dict(
            note="Horizons -32 relative to the Jupiter barycenter: pre-1989 patched-conic mission-design trajectory, documentation only.",
            t=coarse, relJupBary=[rnd(x) for x in hz32]),
        epochB=dict(t=secs(EPOCH_B_JD), jd=EPOCH_B_JD, bodies=bodies,
                    construction="as solar-system-j2000.json (scripts/fetch-horizons.py), at this epoch"),
    )
    path = ROOT / "test/fixtures/voyager2-jupiter.json"
    path.write_text(json.dumps(fx, separators=(",", ":")) + "\n")
    print(f"wrote {path} ({len(jds)} samples)", file=sys.stderr)


if __name__ == "__main__":
    main()
