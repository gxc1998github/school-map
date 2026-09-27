# Reconciliation: retired export vs. current export

`unmatched-from-retired-export.csv` lists schools that were in the **retired
1,733-school export** but have no nearby counterpart in the current
`data/schools.csv` (1,409 schools, from `GPS_Schools_Timor_Leste.xlsx`).

It exists to answer one question: **did the newer Excel drop real schools, or
are these the same sites re-surveyed?** Nobody can tell from the row counts
alone, so this file puts the candidates in front of whoever owns the data.

## How it was built

The retired export is recoverable from git history:

```sh
git show 76d6bc7:data/schools.csv
```

Every row in it was matched to its nearest school in the current export by
great-circle distance. Rows whose nearest neighbour is within **110 m** are
treated as the same site — ordinary GPS drift — and left out. The remaining
385 rows are here, furthest first.

| Distance to nearest current school | Rows | Reading |
| --- | --- | --- |
| 110–500 m | 135 | `possible re-survey` — likely the same school, re-measured |
| over 500 m | 250 | `likely absent from current export` — worth checking |

By level: Basic 245, Pre-School 139, Secondary 1.

The two exports also use different naming conventions (`EBF 1.2 Railuli` vs
`EB 1º,2º Ciclo …`), so names cannot be matched directly — every one of the
385 is absent from the current export by exact name, which is why the
`name_exists_in_current` column is uniformly `no` and distance is the only
usable signal. Judge each row on `distance_m`, not on the name.

## Columns

| Column | Meaning |
| --- | --- |
| `old_school_id` | ID from the retired export (the current export has no IDs) |
| `old_school_name`, `old_education_level` | as recorded in the retired export |
| `latitude`, `longitude` | the retired export's coordinates |
| `name_exists_in_current` | exact-name match against the current export |
| `nearest_current_school` | closest school in the current export |
| `nearest_current_level`, `nearest_current_municipality` | its level and municipality — a locality hint for finding the site |
| `distance_m` | great-circle metres to that nearest school |
| `assessment` | `possible re-survey` (≤500 m) or `likely absent from current export` |

## What this file is not

It is not an authoritative list of missing schools, and nothing here feeds the
map. It is a worksheet: confirmed omissions should be fixed in the upstream
export, then re-exported into `data/schools.csv`.

Regenerate after a new export with `scripts/reconcile-exports.py`.
