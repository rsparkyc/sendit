#!/usr/bin/env python3
"""
Fetch ICRF positions of ground sites relative to Earth's center from JPL
Horizons, as a fixture for src/mission/earth-orientation.ts.

Horizons is asked for the vector of Earth (399) as seen from a topocentric
site (CENTER=coord@399, geodetic WGS84 coordinates); we store the negation,
i.e. the site relative to the geocenter, in ICRF, metres, at TDB epochs.
Horizons applies the full IERS Earth orientation (precession-nutation,
UT1 from EOP data, polar motion where available), so the residual against our
simplified model measures every approximation at once.

Only a generic User-Agent is sent; no personal information.

Usage: python3 scripts/fetch-horizons-sites.py > test/fixtures/mission/horizons-sites.json
"""
import json
import pathlib
import sys
import urllib.parse
import urllib.request

UA = {"User-Agent": "sendit-ephemeris-fetch/1.0"}
API = "https://ssd.jpl.nasa.gov/api/horizons.api"
ROOT = pathlib.Path(__file__).resolve().parent.parent
SITES = json.loads((ROOT / "src/mission/data/launch-sites.json").read_text())["sites"]

# J2000, +-25 y and +-50 y (avoid exact whole days so the rotation phase varies).
JD0 = 2451545.0
JDS = [JD0, JD0 + 0.3, JD0 + 9131.4, JD0 + 18262.7, JD0 - 9131.15, JD0 - 18262.55, JD0 + 9733.21]


def get(url: str) -> str:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read().decode()


def site_vectors(site: dict) -> list:
    params = {
        "format": "json",
        "COMMAND": "'399'",
        "OBJ_DATA": "NO",
        "MAKE_EPHEM": "YES",
        "EPHEM_TYPE": "VECTORS",
        "CENTER": "'coord@399'",
        "COORD_TYPE": "GEODETIC",
        "SITE_COORD": f"'{site['lonDeg']},{site['latDeg']},{site['heightM'] / 1000.0}'",
        "REF_SYSTEM": "ICRF",
        "REF_PLANE": "FRAME",
        "VEC_TABLE": "1",
        "VEC_CORR": "NONE",
        "OUT_UNITS": "KM-S",
        "TIME_TYPE": "TDB",
        "CSV_FORMAT": "YES",
        "VEC_LABELS": "NO",
        "TLIST_TYPE": "JD",
        "TLIST": " ".join(f"'{jd:.6f}'" for jd in JDS),
    }
    res = json.loads(get(API + "?" + urllib.parse.urlencode(params)))
    out = res["result"]
    if "$$SOE" not in out:
        sys.exit(f"Horizons error for {site['id']}:\n{out}")
    rows = out.split("$$SOE")[1].split("$$EOE")[0].strip().splitlines()
    pts = []
    for row in rows:
        f = [c.strip() for c in row.split(",")]
        jd = float(f[0])
        pos = [-float(x) * 1000.0 for x in f[2:5]]
        pts.append({"jdTdb": jd, "t": (jd - JD0) * 86400.0, "position": pos})
    if len(pts) != len(JDS):
        sys.exit(f"{site['id']}: expected {len(JDS)} rows, got {len(pts)}")
    return pts


def main() -> None:
    out = {
        "description": "Ground-site position relative to Earth's center, ICRF, metres; t = seconds TDB from J2000. Negated Horizons vector of Earth (399) from CENTER=coord@399 (geodetic WGS84 site).",
        "source": API,
        "generatedBy": "scripts/fetch-horizons-sites.py",
        "sites": [],
    }
    for s in SITES:
        out["sites"].append({"id": s["id"], "latDeg": s["latDeg"], "lonDeg": s["lonDeg"], "heightM": s["heightM"], "points": site_vectors(s)})
    json.dump(out, sys.stdout, indent=1)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
