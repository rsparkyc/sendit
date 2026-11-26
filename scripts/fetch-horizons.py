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

Usage:  python3 scripts/fetch-horizons.py [--out DIR]
        (needs src/physics/data/iau-rotation.json: run scripts/gen-iau-rotation.py first if the pck changes)

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
  * Spin-pole direction ("pole", J2000 value): the IAU WGCCRE 2015 model
    (Archinal et al. 2018, Celest. Mech. Dyn. Astr. 130:22) of NAIF
    pck00011.tpc, read from src/physics/data/iau-rotation.json (made from the
    kernel by scripts/gen-iau-rotation.py, the single source of orientation for
    physics and display), periodic terms included, as an ICRF unit vector
    toward the IAU north pole. The dynamics use the same model's
    time-dependent pole (src/physics/orientation.ts); this vector is the J2000
    value for the mission layer and display.
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
ROOT = pathlib.Path(__file__).resolve().parent.parent
IAU_JSON = ROOT / "src/physics/data/iau-rotation.json"
# Output root (default: the repository). `--out DIR` writes the same relative paths under DIR, e.g. to diff first.
OUT = pathlib.Path(sys.argv[sys.argv.index("--out") + 1]).resolve() if "--out" in sys.argv else ROOT

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
# The Earth-Moon system is one too (barycenter 3, GMs from the DE440 header, no
# satellite file): the Moon gets parent "earth" like every other moon, so the
# Chebyshev ephemeris stores the Earth-Moon barycenter and the Moon relative to
# it. Earth and Moon keep their places (indices 3 and 4) in the body list.
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
    dict(id="earth", name="Earth", planet="399", cmt=None, moons=[("moon", "Moon", "301")]),
    dict(id="jupiter", name="Jupiter", planet="599", cmt="jup365.cmt",
         moons=[("io", "Io", "501"), ("europa", "Europa", "502"), ("ganymede", "Ganymede", "503"), ("callisto", "Callisto", "504")]),
    dict(id="saturn", name="Saturn", planet="699", cmt="sat441.cmt",
         moons=[("tethys", "Tethys", "603"), ("dione", "Dione", "604"), ("rhea", "Rhea", "605"), ("titan", "Titan", "606"), ("iapetus", "Iapetus", "608")]),
    dict(id="uranus", name="Uranus", planet="799", cmt="ura184_part-1.cmt",
         moons=[("ariel", "Ariel", "701"), ("umbriel", "Umbriel", "702"), ("titania", "Titania", "703"), ("oberon", "Oberon", "704"),
                ("miranda", "Miranda", "705")]),
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


def planet_rel(moon_rel: dict, ext_rel: dict, gms: dict, planet_gm: float) -> list:
    """
    State, relative to the system barycenter, of the planet body: the center of
    mass of the planet and the unmodelled moons INSIDE the modelled moons'
    orbits (Amalthea, Mimas, Enceladus, Puck, Proteus, ...), which carries their
    GM. By the barycenter's definition (sum of GM r over every body of the
    satellite file is 0) that is -(sum over modelled moons + sum over the
    excluded outer moons of GM r) / planet_gm. Differs from the planet center
    (NAIF x99) by the inner moons' reflex: < 0.3 km and a few mm/s.

    Why only inner moons are lumped: a moon outside an orbit does not pull on
    it like a mass at the planet's center (its orbit-averaged pull is a weak
    outward tide), so lumping it adds a spurious central attraction. Lumping
    Nix, Hydra, Kerberos and Styx (GM 0.0036 km^3/s^2, 3.7e-6 of the Pluto
    system) into Pluto made Charon's mean motion 5.6e-6 too fast: 0.116 deg (40
    km) per year ahead of Horizons; with them left out, 0.005 deg (1.7 km) per
    year. Saturn's Hyperion and Phoebe (2.4e-8) and Helene are left out for the
    same reason. Their mass is then missing from the system's total GM (3.7e-6
    of Pluto's system, which changes Pluto's heliocentric mean motion by 1e-14).
    """
    rel = [0.0] * 6
    for src in (moon_rel, ext_rel):
        for naif, r in src.items():
            for k in range(6):
                rel[k] -= gms[naif] * r[k] / planet_gm
    return rel


def system_shift(ext_rel: dict, gms: dict, modelled_gm: float) -> list:
    """
    Offset added to every modelled member of a system so that their center of
    mass is exactly the system barycenter (which moves on DE441's heliocentric
    orbit) while their relative states stay exactly Horizons': + sum over the
    excluded outer moons of GM r / (GM of the modelled bodies). Zero when no
    moon is excluded; 82 m for Pluto-Charon.
    """
    s = [0.0] * 6
    for naif, r in ext_rel.items():
        for k in range(6):
            s[k] += gms[naif] * r[k] / modelled_gm
    return s


def system_members_at(sysd: dict, jd: float, gms: dict, bary: str) -> dict:
    """
    SSB states (m, m/s) at jd of a system's modelled members, built as main()
    builds them at J2000: DE441 barycenter + (member relative to it), the
    planet as planet_rel, everything shifted by system_shift. Which moons are
    left out is decided at J2000 (as in main), so the construction is the same
    at every epoch. For other epochs' fixtures (fetch-voyager2-jupiter.py).
    """
    modelled = [n for _, _, n in sysd["moons"]]
    others = {n: g for n, g in gms.items() if n not in ("System", sysd["planet"]) and n not in modelled and g > 0}
    r0 = {n: vectors(n, [JD_J2000], f"500@{bary}")[0]["state"] for n in list(others) + modelled}
    rmin = min(math.hypot(*r0[n][:3]) for n in modelled)
    ext = [n for n in others if math.hypot(*r0[n][:3]) > rmin]
    planet_gm = gms["System"] - sum(gms[n] for n in modelled) - sum(gms[n] for n in ext)
    b0 = vectors(bary, [jd])[0]["state"]
    rels = {n: vectors(n, [jd], f"500@{bary}")[0]["state"] for n in modelled}
    ext_rel = {n: vectors(n, [jd], f"500@{bary}")[0]["state"] for n in ext}
    shift = system_shift(ext_rel, gms, planet_gm + sum(gms[n] for n in modelled))
    out = {sysd["id"]: with_bary(with_bary(b0, planet_rel(rels, ext_rel, gms, planet_gm)), shift)}
    for mid, _, n in sysd["moons"]:
        out[mid] = with_bary(with_bary(b0, rels[n]), shift)
    return out


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


def iau_poles() -> dict:
    """J2000 IAU pole (RA, Dec in degrees, ICRF unit vector) of every body in
    src/physics/data/iau-rotation.json, periodic terms included (T = 0)."""
    bodies = json.loads(IAU_JSON.read_text())["bodies"]
    poles = {}
    for body, m in bodies.items():
        ra, dec = m["ra"][0], m["dec"][0]
        for n in m.get("nut", []):
            a = math.radians(n["angle"][0])
            ra += n["ra"] * math.sin(a)
            dec += n["dec"] * math.cos(a)
        a, d = math.radians(ra), math.radians(dec)
        poles[body] = dict(raDeg=ra, decDeg=dec, vector=[math.cos(d) * math.cos(a), math.cos(d) * math.sin(a), math.sin(d)])
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

    poles = iau_poles()
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
    in_place = {r["id"]: r for r in bodies}  # Earth and Moon: rows kept at their indices

    def system_gms(sysd):
        """NAIF id -> GM (km^3/s^2) of every body of the system, plus 'System'."""
        if sysd["cmt"] is None:  # Earth-Moon: DE440 header
            return {"399": c["GM_EARTH"], "301": c["GM_MOON"], "System": c["GMB"]}
        return cmt_body_gms(sysd["cmt"])

    def bary_id(sysd):
        return "3" if sysd["id"] == "earth" else by_id[sysd["id"]]["horizons"]

    # Per system: (barycenter Horizons id, modelled moon ids, excluded outer moons {naif: GM}, planet GM).
    split = {}
    for sysd in SYSTEMS:
        gms = system_gms(sysd)
        bh = bary_id(sysd)
        sys_gm = gms["System"]  # km^3/s^2
        modelled = [n for _, _, n in sysd["moons"]]
        moon_gm = sum(gms[n] for n in modelled)
        b0 = vectors(bh, [JD_J2000])[0]["state"]
        rels = {naif: vectors(naif, [JD_J2000], f"500@{bh}")[0]["state"] for naif in modelled}
        # Unmodelled moons with mass: lumped into the planet if inside every
        # modelled moon's orbit (distance at J2000), otherwise left out (planet_rel).
        others = {n: g for n, g in gms.items() if n not in ("System", sysd["planet"]) and n not in modelled and g > 0}
        orel = {n: vectors(n, [JD_J2000], f"500@{bh}")[0]["state"] for n in others}
        rmin = min(math.hypot(*rels[n][:3]) for n in modelled)
        ext = {n: others[n] for n in others if math.hypot(*orel[n][:3]) > rmin}
        lumped = sorted(n for n in others if n not in ext)
        ext_gm = sum(ext.values())
        # Earth: DE440's GM_EARTH itself (GMB - GM_MOON rounds 1 ulp differently).
        planet_gm = gms["399"] if sysd["id"] == "earth" else sys_gm - moon_gm - ext_gm
        split[sysd["id"]] = (bh, modelled, ext, planet_gm)
        ext_rel = {n: orel[n] for n in ext}
        shift = system_shift(ext_rel, gms, planet_gm + moon_gm)
        ps = with_bary(with_bary(b0, planet_rel(rels, ext_rel, gms, planet_gm)), shift)
        print(f"{sysd['name']}: lumped {lumped}, left out {sorted(ext)} (GM {ext_gm:.3e}), shift {math.hypot(*shift[:3]):.1f} m", file=sys.stderr)
        src = "DE440 header" if sysd["cmt"] is None else sysd["cmt"]
        gm_note = (f"{src}: system GM minus the modelled moons" + (f" and the outer unmodelled moons {sorted(ext)} (left out)" if ext else "")
                   + (f"; inner unmodelled moons {lumped} lumped in" if lumped else ""))
        if sysd["id"] == "earth":
            # Earth and Moon keep their SSB-centred DE441 states: unlike the
            # satellite ephemerides, DE441 is one integration, so its Earth,
            # Moon and Earth-Moon barycenter agree exactly (re-adding the
            # relative state only adds rounding, ~3e-5 m).
            in_place["moon"]["parent"] = "earth"
            continue
        else:
            naif_body = sysd["planet"][0]
            k = cmt(sysd["cmt"])
            j2 = k.get("J" + naif_body + "02", 0.0)
            zon = {} if j2 == 0.0 else dict(
                j2=j2, j2Radius=k["RADIUS"] * 1000.0, j4=k["J" + naif_body + "04"],
                j2Source=f"NAIF {sysd['cmt']} J{naif_body}02, J{naif_body}04, RADIUS")
            bary = by_id[sysd["id"]]
            bodies.append(dict(
                id=sysd["id"],
                name=sysd["name"],
                horizonsId=sysd["planet"],
                gm=planet_gm * 1e9,
                gmSource=f"{gm_note}; DE440 {bary['gmKey']} = {c[bary['gmKey']]!r} km^3/s^2",
                radius=bary["radiusKm"] * 1000.0,
                pole=poles[sysd["id"]]["vector"],
                poleRaDecDeg=[poles[sysd["id"]]["raDeg"], poles[sysd["id"]]["decDeg"]],
                **zon,
                state=ps,
            ))
        for mid, mname, naif in sysd["moons"]:
            print(f"fetching {mname}", file=sys.stderr)
            ms = with_bary(with_bary(b0, rels[naif]), shift)
            if mid in in_place:
                in_place[mid]["state"] = ms
                in_place[mid]["parent"] = sysd["id"]
                continue
            moons.append(dict(
                id=mid, name=mname, horizonsId=naif, parent=sysd["id"],
                gm=gms[naif] * 1e9, gmSource=f"{sysd['cmt']} body table",
                radius=sat_radii[naif] * 1000.0,
                state=ms,
            ))
    bodies.sort(key=lambda r: [p["id"] for p in planetary].index(r["id"]))
    bodies += moons

    # Reference states of the full set at sat_jds. A system member: the
    # barycenter (DE441) + its state relative to the barycenter (Horizons,
    # satellite ephemeris), the same construction as the initial states, with
    # no shift (the reference is the real motion). A planet: planet_rel, i.e.
    # the center of mass of the planet and its lumped inner moons. Other
    # bodies: Horizons SSB-centred states. (Moons used to take the SSB-centred
    # states too, which for Uranus is a different chain: Horizons' SSB-centred
    # Uranian moons are 340-1050 km from DE441's barycenter + the satellite
    # ephemeris, and that, not the dynamics, was the "Uranian moons' 400 km".)
    sat_refs = []
    bary_states = {}
    for sysd in SYSTEMS:
        bh = split[sysd["id"]][0]
        bary_states[sysd["id"]] = vectors(bh, sat_jds)
    system_of = {}
    for sysd in SYSTEMS:
        system_of[sysd["id"]] = sysd
        for mid, _, _ in sysd["moons"]:
            system_of[mid] = sysd
    rel_cache = {}

    def rel_series(naif, bh):
        if (naif, bh) not in rel_cache:
            rel_cache[(naif, bh)] = [r["state"] for r in vectors(naif, sat_jds, f"500@{bh}")]
        return rel_cache[(naif, bh)]

    for b in bodies:
        print(f"fetching reference states for {b['name']}", file=sys.stderr)
        sysd = system_of.get(b["id"])
        entry = dict(id=b["id"], horizonsId=b["horizonsId"])
        if sysd is None or sysd["id"] == "earth":  # Earth, Moon: SSB-centred DE441 (see above)
            later = vectors(b["horizonsId"], sat_jds)
        else:
            bh, modelled, ext, planet_gm = split[sysd["id"]]
            bstates = bary_states[sysd["id"]]
            if b.get("parent") is not None:
                rel = rel_series(b["horizonsId"], bh)
                later = [dict(jd=bs["jd"], state=with_bary(bs["state"], r)) for bs, r in zip(bstates, rel)]
            else:
                gms = system_gms(sysd)
                mrel = {n: rel_series(n, bh) for n in modelled}
                erel = {n: rel_series(n, bh) for n in ext}
                later = [dict(jd=bs["jd"], state=with_bary(bs["state"], planet_rel({n: mrel[n][j] for n in mrel}, {n: erel[n][j] for n in erel}, gms, planet_gm)))
                         for j, bs in enumerate(bstates)]
                # Also the planet's own center (NAIF x99), for comparison with the lumped body.
                prel = rel_series(sysd["planet"], bh)
                entry["planetCenterSamples"] = [dict(t=(bs["jd"] - JD_J2000) * 86400.0, jd=bs["jd"], state=with_bary(bs["state"], r))
                                                for bs, r in zip(bstates, prel)]
        entry["samples"] = [dict(t=(s["jd"] - JD_J2000) * 86400.0, jd=s["jd"], state=s["state"]) for s in later]
        if "planetCenterSamples" in entry:
            entry["planetCenterSamples"] = entry.pop("planetCenterSamples")
        sat_refs.append(entry)
    sys_refs = [dict(id=sd["id"], horizonsId=split[sd["id"]][0],
                     samples=[dict(t=(s["jd"] - JD_J2000) * 86400.0, jd=s["jd"], state=s["state"]) for s in bary_states[sd["id"]]])
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
        poleSource="IAU WGCCRE 2015 (Archinal et al. 2018) via NAIF " + PCK_URL + ", as generated into "
        "src/physics/data/iau-rotation.json by scripts/gen-iau-rotation.py: J2000 value including the periodic "
        "terms, ICRF unit vector toward the IAU north pole (poleRaDecDeg: RA, Dec). The dynamics orient each J2/J4 "
        "field by the same model's time-dependent pole (src/physics/orientation.ts).",
        radiusSource="JPL SSD Planetary Physical Parameters (mean radius), https://ssd.jpl.nasa.gov/planets/phys_par.html",
        moonSource="Satellite systems (Earth-Moon, Jupiter..Pluto; each moon has 'parent'): state = DE441 system "
        "barycenter + Horizons state relative to it (see scripts/fetch-horizons.py: Horizons' SSB-centred Uranus/Neptune "
        "are inconsistent with DE441's barycenters by 364/60 km), all members shifted together so the modelled bodies' "
        "center of mass is the barycenter; GM, J2, J4 and RADIUS from the satellite ephemeris Horizons uses "
        "(" + SAT_URL + " jup365, sat441, ura184_part-1, nep098_part-1, plu060 .cmt; Earth-Moon: DE440 header); "
        "planet GM = that file's system GM minus the modelled moons and minus the unmodelled moons outside the "
        "modelled moons' orbits (Hyperion, Phoebe, Helene; Nix, Hydra, Kerberos, Styx), which are left out; "
        "unmodelled inner moons stay lumped in the planet; radius from " + SAT_PHYS_URL + ".",
        generatedBy="scripts/fetch-horizons.py",
        bodies=bodies,
        systemBarycenters=barycenters,
    )
    ref = dict(
        description="Horizons barycentric ICRF states (m, m/s) for validation. t is seconds TDB from J2000.",
        source="JPL Horizons API (DE441)",
        bodies=refs,
    )
    (OUT / "src/physics/data").mkdir(parents=True, exist_ok=True)
    (OUT / "test/fixtures").mkdir(parents=True, exist_ok=True)
    (OUT / "src/physics/data/solar-system-j2000.json").write_text(json.dumps(data, indent=2) + "\n")
    (OUT / "test/fixtures/horizons-reference.json").write_text(json.dumps(ref, indent=1) + "\n")
    sat_ref = dict(
        description="Horizons barycentric ICRF states (m, m/s) of every body of the full set (planets and major "
        "moons, same order as solar-system-j2000.json 'bodies') at J2000 +-1, 10, 25 Julian years. "
        "t is seconds TDB from J2000.",
        source="JPL Horizons API (DE441 + JPL satellite ephemerides)",
        construction="Members of satellite systems (Earth-Moon, Jupiter..Pluto): DE441 system barycenter + Horizons "
        "state relative to that barycenter (as in solar-system-j2000.json, without the shift); the planet entry is the "
        "center of mass of the planet and its lumped inner moons (planetCenterSamples: the planet's center); other "
        "bodies: Horizons SSB-centred states.",
        bodies=sat_refs,
        systemBarycenters=sys_refs,
    )
    (OUT / "test/fixtures/horizons-moons.json").write_text(json.dumps(sat_ref, indent=1) + "\n")
    print("done", file=sys.stderr)


if __name__ == "__main__":
    main()
