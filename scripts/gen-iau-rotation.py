"""Extract IAU WGCCRE rotation constants for the bodies the viewer draws from
NAIF's pck00011.tpc into src/app/data/iau-rotation.json (display-only data).

Usage: python3 -I scripts/gen-iau-rotation.py path/to/pck00011.tpc > src/app/data/iau-rotation.json
Source: https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/pck00011.tpc
Only \\begindata blocks are read; nothing in the kernel is executed.
"""
import json, re, sys

src = open(sys.argv[1]).read()
text = '\n'.join(p.split('\\begintext')[0] for p in src.split('\\begindata')[1:])
vals = {}
for m in re.finditer(r'(BODY\w+)\s*=\s*\(([^)]*)\)|(BODY\w+)\s*=\s*([^\s(][^\n]*)', text):
    if m.group(1):
        vals[m.group(1)] = [float(x.replace('D', 'E')) for x in m.group(2).split()]
    else:
        try:
            vals[m.group(3)] = [float(m.group(4).replace('D', 'E'))]
        except ValueError:
            pass
IDS = {'sun': 10, 'mercury': 199, 'venus': 299, 'earth': 399, 'moon': 301, 'mars': 499, 'jupiter': 599,
       'saturn': 699, 'uranus': 799, 'neptune': 899, 'pluto': 999, 'io': 501, 'europa': 502, 'ganymede': 503,
       'callisto': 504, 'tethys': 603, 'dione': 604, 'rhea': 605, 'titan': 606, 'iapetus': 608, 'ariel': 701,
       'umbriel': 702, 'titania': 703, 'oberon': 704, 'triton': 801, 'charon': 901}
bodies = {}
for name, n in IDS.items():
    k = f'BODY{n}'
    b = {'naifId': n, 'ra': vals[k + '_POLE_RA'], 'dec': vals[k + '_POLE_DEC'], 'pm': vals[k + '_PM']}
    if n >= 100:
        sysid = n // 100
        ang = vals.get(f'BODY{sysid}_NUT_PREC_ANGLES')
        if ang:
            st = int(vals.get(f'BODY{sysid}_MAX_PHASE_DEGREE', [1])[0]) + 1
            angles = [ang[i:i + st] for i in range(0, len(ang), st)]
            ra, de, pm = (vals.get(k + s, []) for s in ('_NUT_PREC_RA', '_NUT_PREC_DEC', '_NUT_PREC_PM'))
            terms = []
            for i, a in enumerate(angles):
                r, d, p = (x[i] if i < len(x) else 0.0 for x in (ra, de, pm))
                if r or d or p:
                    terms.append({'angle': a, 'ra': r, 'dec': d, 'pm': p})
            if terms:
                b['nut'] = terms
    bodies[name] = b
json.dump({
    'source': 'NAIF pck00011.tpc (IAU WGCCRE 2015, Archinal et al. 2018, Celest. Mech. Dyn. Astron. 130:22), '
              'https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/pck00011.tpc',
    'generatedBy': 'scripts/gen-iau-rotation.py',
    'model': 'alpha0 = ra[0] + ra[1] T + ra[2] T^2 + sum ra_k sin(A_k); delta0 = dec[0] + dec[1] T + dec[2] T^2 + sum dec_k cos(A_k); '
             'W = pm[0] + pm[1] d + pm[2] d^2 + sum pm_k sin(A_k); A_k = angle[0] + angle[1] T (+ angle[2] T^2); '
             'degrees; d days and T Julian centuries of TDB from J2000.',
    'longitudes': 'Body-fixed frame: x through the prime meridian (W), z along the IAU north (or, for Pluto/Charon, positive) pole; '
                  'longitude is planetocentric, east-positive (counter-clockwise about +z).',
    'bodies': bodies,
}, sys.stdout, indent=1)
sys.stdout.write('\n')
