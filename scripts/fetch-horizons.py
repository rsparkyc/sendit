#!/usr/bin/env python3
"""
Fetch solar-system initial conditions and validation states from JPL Horizons.

Writes:
  src/physics/data/solar-system-j2000.json   initial conditions + GM + radii (checked in)
  test/fixtures/horizons-reference.json      reference states at other dates (planetary
                                             set with system barycenters, as before)
  test/fixtures/horizons-moons.json          reference states of the full set (planets
                                             and major moons) at J2000 +-1, 10, 25 yr

Body sets:
  * "bodies": Sun, Mercury, Venus, Earth, Moon, Mars system barycenter, the
    planets Jupiter..Pluto themselves (NAIF 599..999), then the major moons
    (MOONS below). Indices 0..10 keep the ids of the older barycentric set.
  * "systemBarycenters": the Jupiter..Pluto system barycenters (NAIF 5..9) with
    the system GM. Replacing bodies[6..10] by these and dropping the moons gives
    the older 11-body planetary set, still used by the baseline tests.

Usage:  python3 scripts/fetch-horizons.py

Sources:
  * State vectors: JPL Horizons API (https://ssd.jpl.nasa.gov/api/horizons.api),
    EPHEM_TYPE=VECTORS, CENTER=500@0 (solar-system barycenter), REF_SYSTEM=ICRF,
    TDB time scale, km and km/s (converted here to m and m/s).
  * GM: DE440 header constants (GMS, GM1..GM9, GMB, EMRAT), downloaded from
    https://ssd.jpl.nasa.gov/ftp/eph/planets/ascii/de440/header.440
    (Park et al. 2021, AJ 161:105). Earth and Moon GM are split from GMB with EMRAT.
    Moon GMs: the "Bodies on the File" table of the JPL satellite ephemeris
    headers (jup365, sat441, ura111xl-799, nep097, plu060 .cmt, NAIF, URL below).
    A planet's GM is the DE440 system GM minus the GMs of the moons modelled
    here, so the moons left out (Amalthea, Mimas, Enceladus, Hyperion, Phoebe,
    Miranda, Nix, Hydra, ...) stay lumped into the planet and the system's
    total GM, which drives its heliocentric motion, is unchanged.
  * Oblateness J2 and its reference radius (unnormalized zonal harmonic):
      Sun, Earth, Moon: DE440 header (J2SUN/ASUN, J2E/RE, J2M/AM).
      Mars, Jupiter, Saturn, Uranus, Neptune: headers of the JPL satellite
      ephemerides distributed by NAIF (mar099, jup365, sat441, ura111xl-799,
      nep097 .cmt files, keys J402..J802 and RADIUS), under
      https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/satellites/
      Mercury, Venus, Pluto: omitted (no J2 in these sources; effects negligible here).
  * Spin-pole direction: IAU WGCCRE 2015 (Archinal et al. 2018, Celest. Mech.
    Dyn. Astr. 130:22) as given in NAIF pck00011.tpc, value at J2000 (the
    secular rate and nutation terms are ignored), converted to an ICRF unit
    vector here so the game code needs no trigonometry.
  * Mean radii: JPL Solar System Dynamics "Planetary Physical Parameters"
    (https://ssd.jpl.nasa.gov/planets/phys_par.html) and Horizons body data pages;
    moons: JPL SSD "Planetary Satellite Physical Parameters"
    (https://ssd.jpl.nasa.gov/sats/phys_par/), parsed here.
  * J4 (Jupiter..Neptune): same satellite-ephemeris headers (J504, J604, J704, J804).
    Radii are only used for rendering / collision, never for the dynamics.

Only a generic User-Agent is sent; no personal information.
"""
import json
import math
import pathlib
import re
import sys
import urllib.parse
import urllib.request

UA = {"User-Agent": "sendit-ephemeris-fetch/1.0"}
API = "https://ssd.jpl.nasa.gov/api/horizons.api"
HEADER_URL = "https://ssd.jpl.nasa.gov/ftp/eph/planets/ascii/de440/header.440"
PCK_URL = "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/pck00011.tpc"
SAT_URL = "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/satellites/"
SAT_PHYS_URL = "https://ssd.jpl.nasa.gov/sats/phys_par/"

# body id -> (source, J2 key, radius key, J4 key). Source "de440" or a satellite .cmt file.
J2_SOURCES = {
    "sun": ("de440", "J2SUN", "ASUN", None),
    "earth": ("de440", "J2E", "RE", None),
    "moon": ("de440", "J2M", "AM", None),
    "mars": ("mar099.cmt", "J402", "RADIUS", None),
    "jupiter": ("jup365.cmt", "J502", "RADIUS", "J504"),
    "saturn": ("sat441.cmt", "J602", "RADIUS", "J604"),
    "uranus": ("ura111xl-799.cmt", "J702", "RADIUS", "J704"),
    "neptune": ("nep097.cmt", "J802", "RADIUS", "J804"),
}
# body id -> NAIF id whose IAU pole is used (planet itself, not the barycenter)
POLE_IDS = {"sun": 10, "mercury": 199, "venus": 299, "earth": 399, "moon": 301, "mars": 499,
            "jupiter": 599, "saturn": 699, "uranus": 799, "neptune": 899, "pluto": 999}
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
BARYCENTER_IDS = ["jupiter", "saturn", "uranus", "neptune", "pluto"]

# Satellite systems modelled with the planet and its major moons as separate
# bodies. Planet: NAIF id of the planet itself. Moons: (id, name, NAIF id).
# The selection and its reasons are in the header of src/physics/solar-system.ts.
# cmt: the satellite ephemeris Horizons itself uses for these bodies (its
# "Target body name ... {source: ...}" line): GMs, J2, J4, RADIUS and the
# planet pole (ZACPL/ZDEPL at POLTIM = J2000) come from its header, so the
# moons' orbits are integrated with the constants they were fitted with.
#
# States of system members: Horizons gives a planet or moon relative to its
# system barycenter from the satellite ephemeris, and the barycenter relative
# to the solar-system barycenter from DE441. For Uranus and Neptune the two
# chains disagree (Horizons' SSB-centred Uranus 799 is 352 km from DE441's
# Uranus barycenter 7, while ura184 puts it 32 km away), so a member's SSB
# state is built here as DE441 barycenter + (member relative to barycenter):
# the system then moves on DE441's heliocentric orbit and is internally
# consistent with the satellite ephemeris. The planet's state is the center of
# mass of the planet and its unmodelled moons (planet_state).
SYSTEMS = [
    dict(id="jupiter", name="Jupiter", planet="599", cmt="jup365.cmt",
         moons=[("io", "Io", "501"), ("europa", "Europa", "502"), ("ganymede", "Ganymede", "503"), ("callisto", "Callisto", "504")]),
    dict(id="saturn", name="Saturn", planet="699", cmt="sat441.cmt",
         moons=[("tethys", "Tethys", "603"), ("dione", "Dione", "604"), ("rhea", "Rhea", "605"), ("titan", "Titan", "606"), ("iapetus", "Iapetus", "608")]),
    dict(id="uranus", name="Uranus", planet="799", cmt="ura184_part-1.cmt",
         moons=[("ariel", "Ariel", "701"), ("umbriel", "Umbriel", "702"), ("titania", "Titania", "703"), ("oberon", "Oberon", "704")]),
    dict(id="neptune", name="Neptune", planet="899", cmt="nep098_part-1.cmt", moons=[("triton", "Triton", "801")]),
    dict(id="pluto", name="Pluto", planet="999", cmt="plu060.cmt", moons=[("charon", "Charon", "901")]),
]
MOON_YEAR_OFFSETS = [-25, -10, -1, 1, 10, 25]

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


def cmt_constants(name: str) -> dict:
    """First occurrence of each 'KEY value' pair in a satellite-ephemeris header."""
    text = get(SAT_URL + name)
    out = {}
    for m in re.finditer(r"(?m)^\s*(\w+)\s+(-?\d\.\d+E[+-]\d+)\s+(\w+)\s+(-?\d\.\d+E[+-]\d+)\s*$", text):
        out.setdefault(m.group(1), float(m.group(2)))
        out.setdefault(m.group(3), float(m.group(4)))
    return out


def with_bary(bary_state: list, rel_state: list) -> list:
    return [b + r for b, r in zip(bary_state, rel_state)]


def planet_state(bary_state: list, moon_rel: dict, gms: dict, sysd: dict, planet_gm: float) -> list:
    """
    State of the planet body that carries the planet's GM plus every moon left
    out: the center of mass of the planet and those moons, placed so that the
    modelled system's barycenter is exactly DE441's. (Using the planet center
    instead puts the left-out moons' momentum in the wrong place: the system
    barycenter then drifts by 107 km/yr for Saturn (Enceladus, Mimas), 150 for
    Uranus (Miranda, Puck), 90 for Neptune (Proteus), and the moons' orbits
    around the planet get a mean-motion error, e.g. Titan 2e-6, Charon 7e-6
    from Nix and Hydra.) Differs from the planet center (NAIF x99) by those
    moons' reflex: < 0.3 km and a few mm/s.
    """
    rel = [0.0] * 6
    for _, _, naif in sysd["moons"]:
        for k in range(6):
            rel[k] -= gms[naif] * moon_rel[naif][k] / planet_gm
    return with_bary(bary_state, rel)


def cmt_body_gms(name: str) -> dict:
    """NAIF id -> GM (km^3/s^2) from the 'Bodies on the File' table, plus 'System'."""
    text = get(SAT_URL + name)
    block = text.split("Bodies on the File:")[1].split("Additional Constants")[0]
    out = {}
    for line in block.splitlines():
        m = re.match(r"^\s*([A-Za-z]+)\s+(\d{3})\s+(-?\d\.\d+E[+-]\d+)", line)
        if m:
            out[m.group(2)] = float(m.group(3))
        m = re.match(r"^\s*System\s+(-?\d\.\d+E[+-]\d+)", line)
        if m:
            out["System"] = float(m.group(1))
    return out


def satellite_radii() -> dict:
    """NAIF id -> mean radius (km) from the JPL SSD satellite physical-parameter table."""
    text = get(SAT_PHYS_URL)
    out = {}
    for row in re.findall(r"<tr.*?</tr>", text, re.S):
        cells = [re.sub(r"\s+", " ", re.sub(r"<.*?>", "", c)).strip() for c in re.findall(r"<td.*?</td>", row, re.S)]
        if len(cells) >= 5 and re.fullmatch(r"\d{3}", cells[2]):
            out[cells[2]] = float(cells[4].split()[0])
    return out


def pck_poles() -> dict:
    text = get(PCK_URL)
    poles = {}
    for body, naif in POLE_IDS.items():
        ra = re.search(rf"BODY{naif}_POLE_RA\s*=\s*\(\s*([-\d.]+)", text)
        dec = re.search(rf"BODY{naif}_POLE_DEC\s*=\s*\(\s*([-\d.]+)", text)
        a, d = math.radians(float(ra.group(1))), math.radians(float(dec.group(1)))
        poles[body] = dict(raDeg=float(ra.group(1)), decDeg=float(dec.group(1)),
                           vector=[math.cos(d) * math.cos(a), math.cos(d) * math.sin(a), math.sin(d)])
    return poles


def vectors(command: str, jds: list, center: str = "500@0") -> list:
    params = {
        "format": "json",
        "COMMAND": f"'{command}'",
        "OBJ_DATA": "NO",
        "MAKE_EPHEM": "YES",
        "EPHEM_TYPE": "VECTORS",
        "CENTER": f"'{center}'",
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

    poles = pck_poles()
    cmt_cache = {}

    def cmt(src):
        if src not in cmt_cache:
            cmt_cache[src] = cmt_constants(src)
        return cmt_cache[src]

    zonal = {}
    for body, (src, jk, rk, j4k) in J2_SOURCES.items():
        if src == "de440":
            zonal[body] = dict(j2=c[jk], radius=c[rk] * 1000.0, source=f"DE440 header {jk}, {rk}")
        else:
            k = cmt(src)
            zonal[body] = dict(j2=k[jk], radius=k[rk] * 1000.0, source=f"NAIF {src} {jk}, {rk}")
            if j4k is not None:
                zonal[body]["j4"] = k[j4k]
                zonal[body]["source4"] = f"NAIF {src} {jk}, {j4k}, {rk}"

    ref_jds = sorted(JD_J2000 + y * JULIAN_YEAR_DAYS for y in YEAR_OFFSETS)
    moon_jds = sorted(set(ref_jds) | {JD_J2000 + d for d in MOON_DAY_OFFSETS})
    sat_jds = sorted(JD_J2000 + y * JULIAN_YEAR_DAYS for y in MOON_YEAR_OFFSETS)

    def zonal_fields(bid):
        if bid not in zonal:
            return {}
        z = zonal[bid]
        out = {"j2": z["j2"], "j2Radius": z["radius"]}
        out["j2Source"] = z["source"]
        if "j4" in z:
            out["j4"] = z["j4"]
            out["j2Source"] = z["source4"]
        return out

    # Older planetary set (system barycenters) and its reference fixture.
    planetary, refs, barycenters = [], [], []
    for b in BODIES:
        print(f"fetching {b['name']}", file=sys.stderr)
        (s0,) = vectors(b["horizons"], [JD_J2000])
        jds = moon_jds if b["id"] in ("moon", "earth") else ref_jds
        later = vectors(b["horizons"], jds)
        row = dict(
            id=b["id"],
            name=b["name"],
            horizonsId=b["horizons"],
            gm=c[b["gmKey"]] * 1e9,  # km^3/s^2 -> m^3/s^2
            gmSource=b["gmKey"],
            radius=b["radiusKm"] * 1000.0,
            pole=poles[b["id"]]["vector"],
            poleRaDecDeg=[poles[b["id"]]["raDeg"], poles[b["id"]]["decDeg"]],
            **{k: v for k, v in zonal_fields(b["id"]).items() if k not in ("j4", "j2Source")},
            **({"j2Source": zonal[b["id"]]["source"]} if b["id"] in zonal else {}),
            state=s0["state"],
        )
        planetary.append(row)
        if b["id"] in BARYCENTER_IDS:
            barycenters.append(row)
        refs.append(dict(id=b["id"], samples=[dict(t=(s["jd"] - JD_J2000) * 86400.0, jd=s["jd"], state=s["state"]) for s in later]))

    # Full set: planets themselves plus major moons.
    sat_radii = satellite_radii()
    bodies = [dict(r) for r in planetary if r["id"] not in BARYCENTER_IDS]
    moons = []
    by_id = {b["id"]: b for b in BODIES}
    for sysd in SYSTEMS:
        gms = cmt_body_gms(sysd["cmt"])
        k = cmt(sysd["cmt"])
        bary = by_id[sysd["id"]]
        sys_gm = gms["System"]  # km^3/s^2
        moon_gm = sum(gms[n] for _, _, n in sysd["moons"])
        b0 = vectors(bary["horizons"], [JD_J2000])[0]["state"]
        rels = {naif: vectors(naif, [JD_J2000], f"500@{bary['horizons']}")[0]["state"] for _, _, naif in sysd["moons"]}
        ps = planet_state(b0, rels, gms, sysd, sys_gm - moon_gm)
        naif_body = sysd["planet"][0]
        ra, dec = k["ZACPL" + naif_body], k["ZDEPL" + naif_body]
        a, d = math.radians(ra), math.radians(dec)
        j2 = k.get("J" + naif_body + "02", 0.0)
        zon = {} if j2 == 0.0 else dict(
            j2=j2, j2Radius=k["RADIUS"] * 1000.0, j4=k["J" + naif_body + "04"],
            j2Source=f"NAIF {sysd['cmt']} J{naif_body}02, J{naif_body}04, RADIUS")
        bodies.append(dict(
            id=sysd["id"],
            name=sysd["name"],
            horizonsId=sysd["planet"],
            gm=(sys_gm - moon_gm) * 1e9,
            gmSource=f"{sysd['cmt']}: system GM minus the modelled moons (unmodelled moons stay lumped in the planet); "
                     f"DE440 {bary['gmKey']} = {c[bary['gmKey']]!r} km^3/s^2",
            radius=bary["radiusKm"] * 1000.0,
            pole=[math.cos(d) * math.cos(a), math.cos(d) * math.sin(a), math.sin(d)],
            poleRaDecDeg=[ra, dec],
            poleSource=f"NAIF {sysd['cmt']} ZACPL{naif_body}, ZDEPL{naif_body} (at POLTIM = J2000)",
            **zon,
            state=ps,
        ))
        for mid, mname, naif in sysd["moons"]:
            print(f"fetching {mname}", file=sys.stderr)
            ms = with_bary(b0, rels[naif])
            moons.append(dict(
                id=mid, name=mname, horizonsId=naif, parent=sysd["id"],
                gm=gms[naif] * 1e9, gmSource=f"{sysd['cmt']} body table",
                radius=sat_radii[naif] * 1000.0,
                state=ms,
            ))
    bodies.sort(key=lambda r: [p["id"] for p in planetary].index(r["id"]))
    bodies += moons

    sat_refs = []
    bary_of = {}
    for sysd in SYSTEMS:
        bh = by_id[sysd["id"]]["horizons"]
        bary_of[sysd["id"]] = (bh, vectors(bh, sat_jds))
        for _, _, naif in sysd["moons"]:
            bary_of[naif] = bary_of[sysd["id"]]
    for b in bodies:
        print(f"fetching reference states for {b['name']}", file=sys.stderr)
        if b.get("parent") is not None or b["id"] in [sd["id"] for sd in SYSTEMS]:
            bh, bstates = bary_of[b["id"] if b.get("parent") is None else b["parent"]]
            rel = vectors(b["horizonsId"], sat_jds, f"500@{bh}")
            later = [dict(jd=r["jd"], state=with_bary(bs["state"], r["state"])) for bs, r in zip(bstates, rel)]
        if b.get("parent") is None and b["id"] in [sd["id"] for sd in SYSTEMS]:
            # Also the planet's own center (NAIF x99), for comparison with the
            # lumped body (see planet_state).
            centre = [dict(t=(x["jd"] - JD_J2000) * 86400.0, jd=x["jd"], state=x["state"]) for x in later]
            sysd = [sd for sd in SYSTEMS if sd["id"] == b["id"]][0]
            gms = cmt_body_gms(sysd["cmt"])
            moon_rels = {naif: vectors(naif, sat_jds, f"500@{bh}") for _, _, naif in sysd["moons"]}
            gp = b["gm"] / 1e9
            later = [dict(jd=bs["jd"], state=planet_state(bs["state"], {n: moon_rels[n][j]["state"] for n in moon_rels}, gms, sysd, gp))
                     for j, bs in enumerate(bstates)]
        else:
            later = vectors(b["horizonsId"], sat_jds)
        entry = dict(id=b["id"], horizonsId=b["horizonsId"],
                     samples=[dict(t=(s["jd"] - JD_J2000) * 86400.0, jd=s["jd"], state=s["state"]) for s in later])
        if b.get("parent") is None and b["id"] in [sd["id"] for sd in SYSTEMS]:
            entry["planetCenterSamples"] = centre
        sat_refs.append(entry)
    sys_refs = [dict(id=sd["id"], horizonsId=bary_of[sd["id"]][0],
                     samples=[dict(t=(s["jd"] - JD_J2000) * 86400.0, jd=s["jd"], state=s["state"]) for s in bary_of[sd["id"]][1]])
                for sd in SYSTEMS]

    # Display name (for labels) separate from the technical name; ids stay stable.
    for row in bodies + barycenters:
        row["displayName"] = row["name"].replace(" system barycenter", "")
    data = dict(
        description="Solar-system initial conditions, barycentric ICRF, SI units (m, m/s, m^3/s^2).",
        epoch=dict(jd=JD_J2000, scale="TDB", iso="2000-01-01T12:00:00 TDB"),
        frame="ICRF, origin at solar-system barycenter (Horizons CENTER=500@0)",
        stateSource="JPL Horizons API, EPHEM_TYPE=VECTORS (planetary ephemeris DE441)",
        gmSource="DE440 header constants, " + HEADER_URL + " (Park et al. 2021, AJ 161:105); "
        "Earth/Moon split from GMB with EMRAT=" + repr(emrat),
        j2Source="Unnormalized J2 with reference radius j2Radius (m). Sun/Earth/Moon: DE440 header. "
        "Mars..Neptune: JPL satellite ephemeris headers (NAIF " + SAT_URL + " mar099/jup365/sat441/ura111xl-799/nep097 .cmt). "
        "J4 (j4, same radius) for Jupiter..Neptune from the same headers. In systemBarycenters the planet's J2 is "
        "applied about the system barycenter (offset <~200 km for Jupiter).",
        poleSource="IAU WGCCRE 2015 (Archinal et al. 2018) via NAIF " + PCK_URL + ", J2000 value, ICRF unit vector; "
        "secular pole motion and nutation terms ignored.",
        radiusSource="JPL SSD Planetary Physical Parameters (mean radius), https://ssd.jpl.nasa.gov/planets/phys_par.html",
        moonSource="Planets Jupiter..Pluto (NAIF x99) and moons: state = DE441 system barycenter + Horizons state "
        "relative to it (see scripts/fetch-horizons.py: Horizons' SSB-centred Uranus/Neptune are inconsistent with "
        "DE441's barycenters by 364/60 km); GM, J2, J4, RADIUS and pole from the satellite ephemeris Horizons uses "
        "(" + SAT_URL + " jup365, sat441, ura184_part-1, nep098_part-1, plu060 .cmt); planet GM = that file's "
        "system GM minus the modelled moons; radius from " + SAT_PHYS_URL + ".",
        generatedBy="scripts/fetch-horizons.py",
        bodies=bodies,
        systemBarycenters=barycenters,
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
    sat_ref = dict(
        description="Horizons barycentric ICRF states (m, m/s) of every body of the full set (planets and major "
        "moons, same order as solar-system-j2000.json 'bodies') at J2000 +-1, 10, 25 Julian years. "
        "t is seconds TDB from J2000.",
        source="JPL Horizons API (DE441 + JPL satellite ephemerides)",
        construction="Planets Jupiter..Pluto and their moons: DE441 system barycenter + Horizons state relative to "
        "that barycenter (as in solar-system-j2000.json); other bodies: Horizons SSB-centred states.",
        bodies=sat_refs,
        systemBarycenters=sys_refs,
    )
    (ROOT / "test/fixtures/horizons-moons.json").write_text(json.dumps(sat_ref, indent=1) + "\n")
    print("done", file=sys.stderr)


if __name__ == "__main__":
    main()
