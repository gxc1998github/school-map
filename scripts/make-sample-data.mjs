/* Regenerates data/schools.sample.csv.
 *
 * The rows are SYNTHETIC — placeholder records so the app has something to
 * draw before you supply the real export. Municipality and administrative
 * post names are the real ones; the coordinates are scattered around each
 * post's approximate centre and the school names are made up.
 *
 *   node scripts/make-sample-data.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// [municipality, [post, lat, lon], …]
const AREAS = [
  ['Aileu', [['Aileu Vila', -8.73, 125.57], ['Laulara', -8.65, 125.55], ['Lequidoe', -8.75, 125.68], ['Remexio', -8.66, 125.62]]],
  ['Ainaro', [['Ainaro', -9.00, 125.51], ['Hato-Udo', -9.10, 125.60], ['Hatu-Builico', -8.90, 125.53], ['Maubisse', -8.84, 125.60]]],
  ['Atauro', [['Atauro', -8.23, 125.60]]],
  ['Baucau', [['Baguia', -8.62, 126.65], ['Baucau', -8.47, 126.46], ['Laga', -8.51, 126.60], ['Quelicai', -8.60, 126.53], ['Vemasse', -8.52, 126.23], ['Venilale', -8.61, 126.40]]],
  ['Bobonaro', [['Atabae', -8.85, 125.13], ['Balibo', -8.97, 125.05], ['Bobonaro', -8.97, 125.34], ['Cailaco', -8.90, 125.28], ['Lolotoe', -9.06, 125.32], ['Maliana', -8.99, 125.22]]],
  ['Covalima', [['Fatululic', -9.24, 125.42], ['Fatumean', -9.28, 125.02], ['Fohorem', -9.27, 125.10], ['Maucatar', -9.24, 125.24], ['Suai', -9.31, 125.26], ['Tilomar', -9.35, 125.15], ['Zumalai', -9.19, 125.42]]],
  ['Dili', [['Cristo Rei', -8.55, 125.62], ['Dom Aleixo', -8.56, 125.53], ['Metinaro', -8.51, 125.78], ['Nain Feto', -8.55, 125.58], ['Vera Cruz', -8.57, 125.56]]],
  ['Ermera', [['Atsabe', -8.80, 125.30], ['Ermera', -8.75, 125.40], ['Hatolia', -8.77, 125.33], ['Letefoho', -8.83, 125.42], ['Railaco', -8.68, 125.44]]],
  ['Lautem', [['Iliomar', -8.66, 126.90], ['Lautem', -8.36, 126.90], ['Lospalos', -8.51, 126.99], ['Luro', -8.53, 126.80], ['Tutuala', -8.40, 127.22]]],
  ['Liquica', [['Bazartete', -8.63, 125.42], ['Liquica', -8.59, 125.32], ['Maubara', -8.61, 125.20]]],
  ['Manatuto', [['Barique', -8.86, 125.98], ['Laclo', -8.60, 125.90], ['Laclubar', -8.79, 125.90], ['Laleia', -8.52, 126.09], ['Manatuto', -8.51, 126.01], ['Soibada', -8.85, 125.88]]],
  ['Manufahi', [['Alas', -9.14, 125.79], ['Fatuberliu', -9.06, 125.88], ['Same', -9.00, 125.65], ['Turiscai', -8.88, 125.67]]],
  ['Viqueque', [['Lacluta', -8.83, 126.14], ['Ossu', -8.72, 126.38], ['Uatocarbau', -8.76, 126.68], ['Uatolari', -8.79, 126.56], ['Viqueque', -8.86, 126.36]]],
  ['RAEOA (Oe-Cusse Ambeno)', [['Nitibe', -9.28, 124.19], ['Oesilo', -9.29, 124.47], ['Pante Macassar', -9.20, 124.38], ['Passabe', -9.35, 124.35]]]
];

// Weighted so the mix roughly resembles a real school system: mostly basic
// education, fewer secondary schools, a handful of higher-education sites.
const LEVELS = [
  ['Pre-School', 'JI', 3],
  ['Basic Education 1st Cycle', 'EBF1', 7],
  ['Basic Education 2nd Cycle', 'EBF2', 5],
  ['Basic Education 3rd Cycle', 'EBF3', 3],
  ['Secondary General', 'ESG', 2],
  ['Secondary Technical-Vocational', 'ESTV', 1],
  ['Higher Education', 'IES', 1]
];

const LEVEL_POOL = LEVELS.flatMap(([name, code, w]) => Array(w).fill([name, code]));

// Deterministic PRNG so regenerating the file produces no spurious diff.
let seed = 20240727;
function rnd() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}

const rows = [];
let n = 0;
for (const [municipality, posts] of AREAS) {
  for (const [post, lat, lon] of posts) {
    const count = 3 + Math.floor(rnd() * 4); // 3–6 schools per post
    for (let i = 0; i < count; i++) {
      const [level, code] = LEVEL_POOL[Math.floor(rnd() * LEVEL_POOL.length)];
      n++;
      rows.push({
        school_id: 'TL-' + String(n).padStart(4, '0'),
        school_name: `${code} ${post} ${String(i + 1).padStart(2, '0')} (sample)`,
        education_level: level,
        municipality,
        administrative_post: post,
        latitude: (lat + (rnd() - 0.5) * 0.09).toFixed(5),
        longitude: (lon + (rnd() - 0.5) * 0.09).toFixed(5)
      });
    }
  }
}

const fields = ['school_id', 'school_name', 'education_level', 'municipality',
  'administrative_post', 'latitude', 'longitude'];
const csv = [fields.join(',')]
  .concat(rows.map(r => fields.map(f => {
    const v = String(r[f]);
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }).join(',')))
  .join('\n') + '\n';

mkdirSync(join(ROOT, 'data'), { recursive: true });
writeFileSync(join(ROOT, 'data', 'schools.sample.csv'), csv);
console.log(`wrote data/schools.sample.csv — ${rows.length} sample schools`);
