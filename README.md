# Timor-Leste School Map

An interactive map of schools, driven by a CSV. Filter by **municipality**,
**administrative post** and **education level**, and search by school name, ID
or suco. Built as plain static files so it can be hosted free on GitHub Pages.

https://gxc1998github.github.io/school-map/

## Why OpenStreetMap and not Google Maps

Leaflet + OpenStreetMap tiles need **no API key, no billing account and no
domain allow-listing**, which is what makes a GitHub Pages deploy a one-click
affair. Google's Maps JavaScript API needs a key tied to a billing account, and
a key shipped in a static page is public — you would have to restrict it by
HTTP referrer and watch the quota.

The basemap picker (top-right of the map) offers OpenStreetMap, Carto Light,
Carto Dark and Esri satellite imagery — all free and key-free. Each popup also
links out to Google Maps for directions, which covers the common reason for
wanting Google in the first place. If you do want Google tiles later, swap the
`BASEMAPS` list in `assets/config.js`.

## Deploying to GitHub Pages

1. Push this repository to GitHub.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
3. Push to `main`. `.github/workflows/deploy.yml` publishes the repository
   as-is — there is no build step.

The site lands at `https://<user>.github.io/<repo>/`.

Prefer no Actions at all? Set **Source: Deploy from a branch → main → / (root)**
instead; the repo is already static, and `.nojekyll` stops Jekyll from
swallowing files.

## The dataset

The map is driven by the single file **`data/schools.csv`**. To update it,
replace that file with a fresh export and push — there is no build step and no
fallback file, so if it is missing the map comes up empty.

The full header the app understands is kept as an empty template file at
[`data/schools.template.csv`](data/schools.template.csv) — hand it to whoever
produces the export:

```csv
school_id,school_name,education_level,municipality,administrative_post,suco,latitude,longitude,ownership,students,teachers
```

Only three columns are actually required:

```csv
school_name,latitude,longitude
```

Add `municipality` and `administrative_post` columns and the two area filters
light up. Header names are matched loosely: case, spaces, underscores, accents
and the Portuguese connecting particles are all ignored, so `Nome da Escola`,
`school_name` and `NOME_ESCOLA` all land on the same field. Semicolon-delimited
files and comma decimal separators (`-8,9912`) parse too.

See [`data/README.md`](data/README.md) for the full column list, and for how to
handle a file that has no municipality / administrative post column — either
drop in a boundary GeoJSON for exact point-in-polygon assignment, or use the
approximate nearest-centre estimate.

## Features

- Marker clustering, so a large point set stays responsive.
- Cascading filters — picking a municipality narrows the administrative posts,
  and every option shows its live count.
- Multi-term search across name, ID, level, municipality, post and suco.
- Shareable links: the filters and the search box are encoded in the URL hash.
- **Export CSV** writes out exactly the current selection.
- Light / dark / auto, and a keyboard-navigable sidebar.
- Popups link to Google Maps and OpenStreetMap for the exact coordinates.

## How education level is drawn

Education level is a ladder, not a set of unrelated categories, so markers use
an **ordered single-hue ramp** (pale blue → deep blue as the level rises)
rather than a rainbow. The ramp was checked with a palette validator in both
light and dark mode: lightness is monotone, every adjacent step is clearly
apart, and the palest step still clears contrast against its marker ring.

Because a colour ramp alone is a weak signal at 18px, every marker also carries
a **letter** — P, B, S, T, H — and the legend, the results list and the popup
all name the level in words. Colour never carries meaning on its own.

Your raw `education_level` values drive the filter list untouched; they are
mapped onto the five rungs (pre-school, basic, secondary general, secondary
technical/vocational, higher) only to pick a colour. Values that match nothing
land in a neutral grey "Other" and stay fully filterable. To adjust the
mapping, edit `LEVEL_GROUPS` in `assets/config.js`.

## Local development

No toolchain and nothing to install — the libraries are vendored in `vendor/`.
Serve the folder over HTTP (the CSV is fetched, so `file://` will not work):

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

## Layout

```
index.html                    markup and script order
assets/config.js              column aliases, level groups, palette, geography
assets/data.js                CSV parsing, normalisation, point-in-polygon
assets/app.js                 map, filters, search, results
assets/app.css                theme tokens and layout
data/schools.csv              the dataset
data/schools.template.csv     empty file with the header the app expects
data/boundaries/              optional municipality / post GeoJSON
vendor/                       Leaflet 1.9.4, MarkerCluster 1.5.3, PapaParse 5.4.1
```

## Licence and attribution

Map data © OpenStreetMap contributors (ODbL); tiles © CARTO or Esri depending
on the basemap chosen. Leaflet (BSD-2), Leaflet.markercluster (MIT) and
PapaParse (MIT) are vendored under `vendor/` with their own licence files.
