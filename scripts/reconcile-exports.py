"""Compare a retired school export against the current one.

Lists schools present in the older export that have no nearby counterpart in
data/schools.csv, so a data owner can tell real omissions from re-surveys.

    python3 scripts/reconcile-exports.py [old-revision]

The old export is read straight out of git history (default 76d6bc7, the
1,733-school export), so nothing outside the repository is needed.
"""
import csv, io, math, subprocess, sys

OLD_REV = sys.argv[1] if len(sys.argv) > 1 else '76d6bc7'
CUR = 'data/schools.csv'
OUT = 'data/reconciliation/unmatched-from-retired-export.csv'

def read_old():
    blob = subprocess.run(['git', 'show', f'{OLD_REV}:{CUR}'],
                          capture_output=True, check=True).stdout
    return io.StringIO(blob.decode('utf-8-sig'))

def rows(src):
    fh = open(src, encoding='utf-8-sig') if isinstance(src, str) else src
    with fh:
        for r in csv.DictReader(fh):
            try:
                r['_lat'] = float(r['latitude']); r['_lon'] = float(r['longitude'])
            except (TypeError, ValueError):
                continue
            yield r

def metres(a_lat, a_lon, b_lat, b_lon):
    R = 6371000.0
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dp = p2 - p1
    dl = math.radians(b_lon - a_lon)
    h = math.sin(dp/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return 2 * R * math.asin(math.sqrt(h))

cur = list(rows(CUR))
old = list(rows(read_old()))

def norm(s):
    return ''.join(ch for ch in (s or '').lower() if ch.isalnum())

cur_names = {norm(r['school_name']) for r in cur}

# Coarse 0.02-degree bucket index (~2.2 km) so each old point only measures
# against nearby candidates instead of all 1,409.
grid = {}
for r in cur:
    grid.setdefault((int(r['_lat']//0.02), int(r['_lon']//0.02)), []).append(r)

out = []
for r in old:
    gy, gx = int(r['_lat']//0.02), int(r['_lon']//0.02)
    near = [c for dy in (-1,0,1) for dx in (-1,0,1)
              for c in grid.get((gy+dy, gx+dx), [])]
    if not near:
        near = cur
    best, best_d = None, float('inf')
    for c in near:
        d = metres(r['_lat'], r['_lon'], c['_lat'], c['_lon'])
        if d < best_d:
            best, best_d = c, d
    if best_d <= 110:
        continue                      # same site, within GPS drift
    out.append({
        'old_school_id': r.get('school_id',''),
        'old_school_name': r['school_name'],
        'old_education_level': r['education_level'],
        'latitude': r['latitude'],
        'longitude': r['longitude'],
        'name_exists_in_current': 'yes' if norm(r['school_name']) in cur_names else 'no',
        'nearest_current_school': best['school_name'] if best else '',
        'nearest_current_level': best['education_level'] if best else '',
        'nearest_current_municipality': best.get('municipality','') if best else '',
        'distance_m': str(int(round(best_d))) if best else '',
        'assessment': ('possible re-survey' if best_d <= 500 else
                       'likely absent from current export'),
    })

out.sort(key=lambda r: -int(r['distance_m']))
with open(OUT, 'w', newline='', encoding='utf-8') as fh:
    w = csv.DictWriter(fh, fieldnames=list(out[0].keys()))
    w.writeheader(); w.writerows(out)

likely = sum(1 for r in out if r['assessment'].startswith('likely'))
print(f"old rows with coordinates : {len(old)}")
print(f"unmatched (>110 m)        : {len(out)}")
print(f"  110-500 m, possible re-survey : {len(out)-likely}")
print(f"  >500 m, likely absent         : {likely}")
print(f"  name also absent from current : {sum(1 for r in out if r['name_exists_in_current']=='no')}")
print(f"wrote {OUT}")
