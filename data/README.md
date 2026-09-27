# Data folder

## Your school list

The dataset lives here as **`data/schools.csv`**. It is the only file the app
loads; if it is absent the map comes up empty.

## The header to ask for

`schools.template.csv` in this folder is an empty file carrying exactly the
header the app understands. Hand it to whoever produces the export:

```csv
school_id,school_name,education_level,municipality,administrative_post,suco,latitude,longitude,ownership,students,teachers
```

A filled row looks like this:

```csv
1689,EB 1.2.3 Cafe Aileu,Basic,Aileu,Aileu Vila,Seloi Kraik,-8.730585,125.567018,Public,412,18
```

Column by column:

| Column | Required | Notes |
| --- | --- | --- |
| `latitude` | **yes** | Decimal degrees, or `8° 33' 12" S` style — both parse. Rows without usable coordinates are skipped. |
| `longitude` | **yes** | Negative is west. Timor-Leste is all positive (≈ 124–127). |
| `school_name` | **yes** | Quote it if the name contains a comma. |
| `school_id` | no | Falls back to the row number if absent. |
| `education_level` | no | Drives the level filter, marker colour and legend. Free text — `Basic`, `Pre-School`, `Ensino Secundário` all work. |
| `municipality` | no | Drives the municipality filter. One of the 13 municipalities or RAEOA. |
| `administrative_post` | no | Drives the administrative post filter. |
| `suco` | no | Searchable, shown in the popup. |
| `ownership` | no | Shown in the popup, e.g. `Public` / `Private` / `Catholic`. |
| `students` | no | Shown in the popup. Whole number. |
| `teachers` | no | Shown in the popup. Whole number. |
| `ict_donor` | no | e.g. `UNICEF`, `LiteHaus`. Own filter. Can also come from `ict.csv`, see below. |
| `internet` | no | e.g. `Modem Router`, `Starlink`, `Starlink-Vorakai`, `NCP`. Own filter. |

Only the first three are required. Everything else degrades gracefully — a
missing column just means the matching filter or popup line is absent.

### Formatting rules

- **UTF-8**, with or without a BOM — both are handled.
- **Comma or semicolon** delimited. Comma decimals (`-8,9912`) parse too.
- **Quote any field containing a comma**: `132,"EB 1º,2º Ciclo Belulic",Basic,…`
- Blank rows are ignored, so trailing empty lines are harmless.
- `NA`, `N/A`, `null`, `none`, `-` and `.` are all read as empty.

Header names are matched loosely — case, spaces, underscores, hyphens and
accents are ignored, and Portuguese/Tetum names are recognised too
(`nome_escola`, `municipio`, `posto_administrativo`, `nivel_ensino`, …), so
you do not have to rename columns to match the template exactly. See
`COLUMN_ALIASES` in `assets/config.js` to add your own.

### What the current export is missing

The dataset in `schools.csv` today carries only `school_id`, `school_name`,
`education_level`, `latitude` and `longitude`. Adding **`municipality`** and
**`administrative_post`** is the single highest-value change — it switches the
two area filters from the approximate nearest-centre estimate to exact values.

## ICT donor and internet list

Each school can also carry which **ICT donor** supplied it (e.g. `UNICEF`,
`LiteHaus`) and what **internet** it has (e.g. `Modem Router`, `Starlink`,
`Starlink-Vorakai`, `NCP`). Both get their own filter in the sidebar, show in
the popup, are searchable and go out in **Export CSV**.

Two ways to supply them, and they can be mixed:

1. **A separate list, `data/ict.csv`** (easiest). Use the empty template
   `ict.template.csv` in this folder:

   ```csv
   school_id,school_name,ict_donor,internet
   1689,EB 1.2.3 Cafe Aileu,UNICEF,Starlink
   473,EB Catolica 1.2 No 02 Seloi Kraik,"UNICEF; LiteHaus",Modem Router
   ```

   Rows are matched to `schools.csv` by `school_id`; if the ID is blank, by
   exact school name. The file is optional. Rows that match no school are
   counted in the header line (hover it to see which).

2. **Extra columns in `schools.csv`**: add `ict_donor` and `internet` columns
   there instead.

Notes:

- A school with more than one donor or connection lists them separated by
  `;` (or `/`, `|`, `+`, `,`, quoted). A hyphen is part of the name, so
  `Starlink-Vorakai` stays one value.
- Spelling is matched loosely against the known names, so `unicef`,
  `Lite Haus` and `starlink vorakai` all land on the right option. New donors
  or connection types just appear as new options; add them to `FACETS` in
  `assets/config.js` to fix their spelling and order.
- Schools with nothing recorded are grouped as *No ICT donor recorded* /
  *No internet recorded*, so you can filter for the gaps too.
- Other header names work too: `ICT School`, `Donor`, `Internet Type`,
  `Connectivity`, …

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

2. **Estimate from coordinates (approximate).** Built in and automatic: if
   neither the CSV nor a boundary file supplies a municipality, each school is
   assigned to the nearest municipality centre. It is a stopgap — assignments
   near municipal borders can be wrong — so a note in the sidebar says so and
   every estimated value is labelled in the popup.
