#!/usr/bin/env python3
"""
Regenerate the campaign's per-site reference solutions from solver logs.

Reads the SITE_SOLUTION lines that test/mission-campaign-sites-solve.test.ts
prints (SLOW=1), one log file per run, from LOGS_DIR/solve/*.log (default
LOGS_DIR: campaign-solve-logs/ at the repository root, not committed), and
writes:
  - test/fixtures/campaign-solutions.json (the reference plans; tests only);
  - the CAMPAIGN_SITES table in src/mission/campaign-sites.ts (reference
    delta-v, ascent, time and the per-site limits).
An optional LOGS_DIR/not-offered.json ({mission: {site: reason}}) marks sites
that are not offered. Later logs win (sorted by name); a failed solution never
replaces a good one. Prints a summary table. See README "Regenerating the
campaign references".

Usage: python3 scripts/gen-campaign-sites.py [LOGS_DIR]
"""
import glob, json, math, os, re, sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
S = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(REPO, 'campaign-solve-logs')
if not os.path.isdir(os.path.join(S, 'solve')):
    sys.exit(f'no solver logs: expected {os.path.join(S, "solve")}/*.log (see the docstring)')
DAY = 86400
ORDER = ['plane-change', 'geo-from-leo', 'earth-escape', 'lunar-flyby', 'lunar-free-return', 'lunar-orbit', 'venus-flyby', 'mars-flyby', 'mars-orbit', 'venus-to-mercury', 'solar-escape', 'jupiter-saturn']
SITES = ['cape-canaveral', 'vandenberg', 'kourou', 'baikonur', 'tanegashima', 'mahia', 'equator']
NEAR = {'plane-change', 'geo-from-leo', 'earth-escape', 'lunar-flyby', 'lunar-free-return', 'lunar-orbit'}
# Samples keep their original ratio of limit to par (Kourou, version 1), now applied to the flight's delta-v.
RATIO = {'geo-from-leo': 4500 / 3931.5, 'lunar-flyby': 3500 / 3167.2, 'lunar-free-return': 3300 / 3167.2}
SAMPLE_TIME = {'geo-from-leo': 6 * DAY, 'lunar-flyby': 7 * DAY, 'lunar-free-return': 12 * DAY}
MAXDUR = {'plane-change': DAY, 'geo-from-leo': 6 * DAY, 'earth-escape': 4 * DAY, 'lunar-flyby': 7 * DAY, 'lunar-free-return': 12 * DAY, 'lunar-orbit': 6 * DAY,
          'venus-flyby': 260 * DAY, 'mars-flyby': 400 * DAY, 'mars-orbit': 400 * DAY, 'venus-to-mercury': 450 * DAY, 'solar-escape': 4 * 365.25 * DAY, 'jupiter-saturn': 8 * 365.25 * DAY}
PLANE_REASON = 'its corridor reaches 64-66° directly, so there is no plane change to make; the mission is about the Cape corridor’s 60° limit'
NOT_OFFERED = json.load(open(os.path.join(S, 'not-offered.json'))) if os.path.exists(os.path.join(S, 'not-offered.json')) else {}

sol = {m: {} for m in ORDER}
for f in sorted(glob.glob(os.path.join(S, 'solve', '*.log')), key=lambda f: (f.count('.'), f)):
    for line in open(f):
        mm = re.match(r'SITE_SOLUTION (\S+) (.*)$', line.strip())
        if not mm:
            continue
        for site, v in json.loads(mm.group(2)).items():
            if 'failed' in v and site in sol[mm.group(1)] and 'failed' not in sol[mm.group(1)][site]:
                continue
            sol[mm.group(1)][site] = v

# Upper-stage propellant left in each reference (the last lower stage's report: "[k: dv .. left N kg sep T]").
LEFT = {}
for f in glob.glob(os.path.join(S, 'solve', '*.log')):
    for line in open(f):
        mm = re.match(r'([a-z-]+): ([a-z-]+): .*success=\w+ dv=([\d.]+)', line)
        if not mm:
            continue
        st = re.findall(r'\[(\d+): dv (\d+) left (-?[\d.]+) kg( sep [\d.]+)?\]', line)
        lower = [x for x in st if x[3]]
        LEFT.setdefault((mm.group(2), mm.group(1), mm.group(3)), (float(lower[-1][2]), int(lower[-1][1])))
ceil10 = lambda x: int(math.ceil(x / 10 - 1e-9) * 10)
fixture = {}
rows = {}
for m in ORDER:
    fixture[m] = {}
    rows[m] = []
    for site in SITES:
        v = sol[m].get(site)
        if m == 'plane-change' and site != 'cape-canaveral':
            rows[m].append({'site': site, 'offered': False, 'reason': PLANE_REASON})
            continue
        if site in NOT_OFFERED.get(m, {}):
            rows[m].append({'site': site, 'offered': False, 'reason': NOT_OFFERED[m][site]})
            continue
        if v is None or 'failed' in v:
            print(f'MISSING {m} {site}: {None if v is None else v["failed"][:300]}', file=sys.stderr)
            # Placeholder so the module loads while solving (limits wide open); never shipped.
            rows[m].append({'site': site, 'offered': True, 'deltaV': 99999, 'ascentDeltaV': 0, 'time': DAY, 'maxDeltaV': 99999, 'maxTime': MAXDUR[m], '_flight': 0})
            continue
        fixture[m][site] = {k: v[k] for k in ['params', 'duration', 'rtol', 'burns', 'separations']}
        r = RATIO.get(m, 1.08)
        maxdv = ceil10(v['ascent'] + v['flight'] * r)
        t = v['time']
        if m in SAMPLE_TIME:
            maxt = SAMPLE_TIME[m]
        elif m in NEAR:
            maxt = int(math.ceil(t * 1.25 / 600) * 600)
        else:
            maxt = int(math.ceil(t * 1.15 / DAY)) * DAY
        maxt = min(maxt, MAXDUR[m])
        rows[m].append({'site': site, 'offered': True, 'deltaV': round(v['dv'], 1), 'ascentDeltaV': round(v['ascent'], 1), 'time': round(t), 'maxDeltaV': maxdv, 'maxTime': maxt,
                        '_flight': v['flight'], '_upper_left': LEFT.get((m, site, f"{v['dv']:.1f}"))})

json.dump(fixture, open(os.path.join(REPO, 'test/fixtures/campaign-solutions.json'), 'w'), indent=1)

def fmt_time(x):
    return f'{x // DAY} * DAY' if x % DAY == 0 else str(x)

out = []
for m in ORDER:
    out.append(f"  '{m}': [")
    for r in rows[m]:
        if r['offered']:
            out.append(f"    {{ site: '{r['site']}', offered: true, deltaV: {r['deltaV']}, ascentDeltaV: {r['ascentDeltaV']}, time: {r['time']}, maxDeltaV: {r['maxDeltaV']}, maxTime: {fmt_time(r['maxTime'])} }},")
        else:
            out.append(f"    {{ site: '{r['site']}', offered: false, reason: {json.dumps(r['reason'], ensure_ascii=False).replace(chr(34), chr(39)) if chr(39) not in r['reason'] else json.dumps(r['reason'], ensure_ascii=False)} }},")
    out.append('  ],')
p = os.path.join(REPO, 'src/mission/campaign-sites.ts')
src = open(p).read()
a = src.index('export const CAMPAIGN_SITES')
b = src.index('};', a)
src = src[:a] + 'export const CAMPAIGN_SITES: Readonly<Record<string, readonly SiteOption[]>> = {\n' + '\n'.join(out) + '\n' + src[b:]
open(p, 'w').write(src)

# Report table
for m in ORDER:
    for r in rows[m]:
        if r['offered']:
            print(f"{m:18} {r['site']:15} total {r['deltaV']:8.1f} ascent {r['ascentDeltaV']:7.1f} flight {r['_flight']:7.1f} time {r['time']/DAY:9.3f} d  maxDv {r['maxDeltaV']} maxT {r['maxTime']/DAY:.3f} d  upper left {r['_upper_left']}")
        else:
            print(f"{m:18} {r['site']:15} not offered: {r['reason'][:80]}")
