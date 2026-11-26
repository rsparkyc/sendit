#!/usr/bin/env python3
"""
Fetch solar-system initial conditions and validation states from JPL Horizons.

Writes:
  src/physics/data/solar-system-j2000.json   initial conditions + GM + radii (checked in)
  test/fixtures/horizons-reference.json      reference states at other dates

Usage:  python3 scripts/fetch-horizons.py

Sources:
  * State vectors: JPL Horizons API (https://ssd.jpl.nasa.gov/api/horizons.api),
    EPHEM_TYPE=VECTORS, CENTER=500@0 (solar-system barycenter), REF_SYSTEM=ICRF,
    TDB time scale, km and km/s (converted here to m and m/s).
  * GM: DE440 header constants (GMS, GM1..GM9, GMB, EMRAT), downloaded from
    https://ssd.jpl.nasa.gov/ftp/eph/planets/ascii/de440/header.440
    (Park et al. 2021, AJ 161:105). Earth and Moon GM are split from GMB with EMRAT.
  * Mean radii: JPL Solar System Dynamics "Planetary Physical Parameters"
    (https://ssd.jpl.nasa.gov/planets/phys_par.html) and Horizons body data pages.
    Radii are only used for rendering / collision, never for the dynamics.

Only a generic User-Agent is sent; no personal information.
"""
import json
import pathlib
import re
import sys
import urllib.parse
import urllib.request

UA = {"User-Agent": "sendit-ephemeris-fetch/1.0"}
API = "https://ssd.jpl.nasa.gov/api/horizons.api"
HEADER_URL = "https://ssd.jpl.nasa.gov/ftp/eph/planets/ascii/de440/header.440"
ROOT = pathlib.Path(__file__).resolve().parent.parent

JD_J2000 = 2451545.0
JULIAN_YEAR_DAYS = 365.25

# id: Horizons command; gmKey: DE440 constant name; radius: mean radius in km
BODIES = [
    dict(id="sun", name="Sun", horizons="10", gmKey="GMS", radiusKm=695700.0),
    dict(id="mercury", name="Mercury", horizons="199", gmKey="GM1", radiusKm=2439.4),
    dict(id="venus", name="Venus", horizons="299", gmKey="GM2", radiusKm=6051.8),
    dict(id="earth", name="Earth", horizons="399", gmKey="GM_EARTH", radiusKm=6371.0084),
    dict(id="moon", name="Moon", horizons="301", gmKey="GM_MOON", radiusKm=1737.4),
    dict(id="mars", name="Mars system barycenter", horizons="4", gmKey="GM4", radiusKm=3389.5),
    dict(id="jupiter", name="Jupiter system barycenter", horizons="5", gmKey="GM5", radiusKm=69911.0),
    dict(id="saturn", name="Saturn system barycenter", horizons="6", gmKey="GM6", radiusKm=58232.0),
    dict(id="uranus", name="Uranus system barycenter", horizons="7", gmKey="GM7", radiusKm=25362.0),
    dict(id="neptune", name="Neptune system barycenter", horizons="8", gmKey="GM8", radiusKm=24622.0),
    dict(id="pluto", name="Pluto system barycenter", horizons="9", gmKey="GM9", radiusKm=1188.3),
]

YEAR_OFFSETS = [-100, -50, -10, -1, 1, 10, 50, 100]
MOON_DAY_OFFSETS = [-180, -90, -30, -7, -1, 1, 7, 30, 90, 180, 365.25 * 5]


def get(url: str) -> str:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read().decode()


def de440_constants() -> dict:
    text = get(HEADER_URL)
    names_block = text.split("GROUP   1040")[1].split("GROUP   1041")[0]
    vals_block = text.split("GROUP   1041")[1].split("GROUP   1050")[0]
    names = names_block.split()[1:]
    vals = [float(v.replace("D", "E")) for v in vals_block.split()[1:]]
    consts = dict(zip(names, vals))
    for k in ["GMS", "GM1", "GM2", "GMB", "GM4", "GM5", "GM6", "GM7", "GM8", "GM9", "EMRAT", "AU"]:
        if k not in consts:
            sys.exit(f"missing {k} in DE440 header")
    return consts


def vectors(command: str, jds: list) -> list:
    params = {
        "format": "json",
        "COMMAND": f"'{command}'",
        "OBJ_DATA": "NO",
        "MAKE_EPHEM": "YES",
        "EPHEM_TYPE": "VECTORS",
        "CENTER": "'500@0'",
        "REF_SYSTEM": "ICRF",
        "REF_PLANE": "FRAME",
        "VEC_TABLE": "2",
        "VEC_CORR": "NONE",
        "OUT_UNITS": "KM-S",
        "TIME_TYPE": "TDB",
        "CSV_FORMAT": "YES",
        "VEC_LABELS": "NO",
        "TLIST_TYPE": "JD",
        "TLIST": " ".join(f"'{jd:.6f}'" for jd in jds),
    }
    url = API + "?" + urllib.parse.urlencode(params)
    res = json.loads(get(url))
    out = res["result"]
    if "$$SOE" not in out:
        sys.exit(f"Horizons error for {command}:\n{out}")
    rows = out.split("$$SOE")[1].split("$$EOE")[0].strip().splitlines()
    states = []
    for row in rows:
        f = [c.strip() for c in row.split(",")]
        jd = float(f[0])
        km = [float(x) for x in f[2:8]]
        states.append(dict(jd=jd, state=[v * 1000.0 for v in km]))
    if len(states) != len(jds):
        sys.exit(f"{command}: expected {len(jds)} rows, got {len(states)}")
    return states


def main() -> None:
    c = de440_constants()
    emrat = c["EMRAT"]
    # Header GMs are in au^3/day^2 (AU given in km). Convert to km^3/s^2.
    au = c["AU"]
    for k in ["GMS", "GM1", "GM2", "GMB", "GM4", "GM5", "GM6", "GM7", "GM8", "GM9"]:
        c[k] = c[k] * au * au * au / (86400.0 * 86400.0)
    c["GM_EARTH"] = c["GMB"] * emrat / (1.0 + emrat)
    c["GM_MOON"] = c["GMB"] / (1.0 + emrat)

    ref_jds = sorted(JD_J2000 + y * JULIAN_YEAR_DAYS for y in YEAR_OFFSETS)
    moon_jds = sorted(set(ref_jds) | {JD_J2000 + d for d in MOON_DAY_OFFSETS})

    bodies, refs = [], []
    for b in BODIES:
        print(f"fetching {b['name']}", file=sys.stderr)
        (s0,) = vectors(b["horizons"], [JD_J2000])
        jds = moon_jds if b["id"] in ("moon", "earth") else ref_jds
        later = vectors(b["horizons"], jds)
        bodies.append(
            dict(
                id=b["id"],
                name=b["name"],
                horizonsId=b["horizons"],
                gm=c[b["gmKey"]] * 1e9,  # km^3/s^2 -> m^3/s^2
                gmSource=b["gmKey"],
                radius=b["radiusKm"] * 1000.0,
                state=s0["state"],
            )
        )
        refs.append(
            dict(
                id=b["id"],
                samples=[
                    dict(t=(s["jd"] - JD_J2000) * 86400.0, jd=s["jd"], state=s["state"]) for s in later
                ],
            )
        )

    data = dict(
        description="Solar-system initial conditions, barycentric ICRF, SI units (m, m/s, m^3/s^2).",
        epoch=dict(jd=JD_J2000, scale="TDB", iso="2000-01-01T12:00:00 TDB"),
        frame="ICRF, origin at solar-system barycenter (Horizons CENTER=500@0)",
        stateSource="JPL Horizons API, EPHEM_TYPE=VECTORS (planetary ephemeris DE441)",
        gmSource="DE440 header constants, " + HEADER_URL + " (Park et al. 2021, AJ 161:105); "
        "Earth/Moon split from GMB with EMRAT=" + repr(emrat),
        radiusSource="JPL SSD Planetary Physical Parameters (mean radius), https://ssd.jpl.nasa.gov/planets/phys_par.html",
        generatedBy="scripts/fetch-horizons.py",
        bodies=bodies,
    )
    ref = dict(
        description="Horizons barycentric ICRF states (m, m/s) for validation. t is seconds TDB from J2000.",
        source="JPL Horizons API (DE441)",
        bodies=refs,
    )
    (ROOT / "src/physics/data").mkdir(parents=True, exist_ok=True)
    (ROOT / "test/fixtures").mkdir(parents=True, exist_ok=True)
    (ROOT / "src/physics/data/solar-system-j2000.json").write_text(json.dumps(data, indent=2) + "\n")
    (ROOT / "test/fixtures/horizons-reference.json").write_text(json.dumps(ref, indent=1) + "\n")
    print("done", file=sys.stderr)


if __name__ == "__main__":
    main()
