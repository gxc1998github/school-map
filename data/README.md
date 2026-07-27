# Data folder

## Your school list

The dataset lives here as **`data/schools.csv`**. It is the only file the app
loads; if it is absent the map comes up empty.

Minimum columns:

| Column | Required | Notes |
| --- | --- | --- |
| `latitude` | yes | Decimal degrees, or `8° 33' 12" S` style — both parse. |
| `longitude` | yes | |
| `school_name` | yes | |
| `school_id` | no | Falls back to the row number. |
| `education_level` | no | Drives the level filter, the marker colour and the legend. |
| `municipality` | no | Drives the municipality filter. |
| `administrative_post` | no | Drives the administrative post filter. |
| `suco` | no | Searchable, shown in the popup. |
| `ownership`, `students`, `teachers` | no | Shown in the popup when present. |

Header names are matched loosely — case, spaces, underscores and hyphens are
ignored, and Portuguese/Tetum names are recognised too (`nome_escola`,
`municipio`, `posto_administrativo`, `nivel_ensino`, …). See
`COLUMN_ALIASES` in `assets/config.js` to add your own.

Rows without usable coordinates are skipped and counted in the header line.

## If your file has no municipality / administrative post column

Two options, in order of accuracy:

1. **Boundary files (exact).** Drop these in and every school is placed by
   point-in-polygon:

   - `data/boundaries/municipalities.geojson`
   - `data/boundaries/administrative-posts.geojson`

   Any WGS84 GeoJSON `FeatureCollection` of `Polygon`/`MultiPolygon` features
   works. The area name is read from the first matching property out of
   `shapeName`, `name`, `ADM1_EN`, `ADM2_EN`, `admin1Name`, `admin2Name` … —
   the list is `BOUNDARY_NAME_KEYS` in `assets/config.js`.

   Free sources for Timor-Leste (TLS): [geoBoundaries](https://www.geoboundaries.org/)
   ADM1 = municipality, ADM2 = administrative post; or the
   [UN OCHA Common Operational Datasets](https://data.humdata.org/) for
   Timor-Leste. Download the GeoJSON, rename it, commit it.

   Large boundary files slow the first load — simplify the geometry (e.g.
   `mapshaper -simplify 5%`) before committing if the file runs to megabytes.

2. **Estimate from coordinates (approximate).** A checkbox in the sidebar
   assigns each school to the nearest municipality centre. It is a stopgap —
   assignments near municipal borders will be wrong — so it is off by default
   and every estimated value is labelled in the popup.
