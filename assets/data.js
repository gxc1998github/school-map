/* CSV loading and normalisation. Turns whatever headers the file happens to
   use into a stable record shape, and works out municipality / administrative
   post when the file does not carry them. */
(function (global) {
  'use strict';

  var CONFIG = global.CONFIG;

  /* Accents are stripped so "Município" and "Municipio" are the same header,
     and so the level patterns can stay plain ASCII. */
  function deaccent(s) {
    return String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  function slug(s) {
    return deaccent(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  /* Same as slug() but with the connecting particles dropped, so headers like
     "Nome da Escola" and "Nível de Ensino" reduce to the same key as
     "nome_escola" and "nivel_ensino". */
  var PARTICLES = /^(de|da|do|das|dos|d|of|the|no|na|em|para)$/;
  function slugCore(s) {
    return deaccent(s).toLowerCase().split(/[^a-z0-9]+/)
      .filter(function (w) { return w && !PARTICLES.test(w); })
      .join('');
  }

  function clean(v) {
    if (v == null) return '';
    var s = String(v).trim();
    // Treat the usual placeholders for "no value" as empty.
    return /^(na|n\/a|null|none|-|--|\.)$/i.test(s) ? '' : s;
  }

  /* Match each field to a header, in three passes of decreasing confidence:
     exact slug, slug with particles dropped, then "header contains the alias".
     Returns { field: headerName }. */
  function detectColumns(headers) {
    var exact = {}, core = {};
    headers.forEach(function (h) {
      var k = slug(h);
      var c = slugCore(h);
      if (k && !(k in exact)) exact[k] = h;
      if (c && !(c in core)) core[c] = h;
    });

    var map = {};
    var taken = {};

    function claim(field, header) {
      if (!header || taken[header]) return false;
      map[field] = header;
      taken[header] = true;
      return true;
    }

    var fields = Object.keys(CONFIG.COLUMN_ALIASES);
    [exact, core].forEach(function (table) {
      fields.forEach(function (field) {
        if (map[field]) return;
        var aliases = CONFIG.COLUMN_ALIASES[field];
        for (var i = 0; i < aliases.length; i++) {
          if (claim(field, table[slug(aliases[i])])) return;
        }
      });
    });

    // Last resort: a header that merely contains the alias. Restricted to
    // aliases of four characters or more so "id" cannot swallow "district",
    // and the shortest candidate wins so "latitude" beats "latitude_source".
    fields.forEach(function (field) {
      if (map[field]) return;
      var aliases = CONFIG.COLUMN_ALIASES[field];
      var best = null;
      headers.forEach(function (h) {
        if (taken[h]) return;
        var k = slug(h);
        for (var i = 0; i < aliases.length; i++) {
          var a = slug(aliases[i]);
          if (a.length >= 4 && k.indexOf(a) !== -1) {
            if (!best || k.length < slug(best).length) best = h;
            return;
          }
        }
      });
      claim(field, best);
    });

    return map;
  }

  /* Accepts "-8.55", "8.55 S", "-8° 33' 12\"" and comma decimal separators. */
  function parseCoord(raw) {
    var s = clean(raw);
    if (!s) return NaN;
    var hemi = /[swSW]\s*$/.test(s) || /^\s*[swSW]/.test(s) ? -1 : 1;
    s = s.replace(/[NSEWnsew]/g, '').trim();
    var dms = s.match(/^(-?\d+(?:[.,]\d+)?)[^\d-]+(\d+(?:[.,]\d+)?)(?:[^\d-]+(\d+(?:[.,]\d+)?))?/);
    if (dms && /[^\d.,\-+\s]/.test(s)) {
      var d = parseFloat(dms[1].replace(',', '.'));
      var m = parseFloat((dms[2] || '0').replace(',', '.'));
      var sec = parseFloat((dms[3] || '0').replace(',', '.'));
      var sign = d < 0 ? -1 : 1;
      return sign * (Math.abs(d) + m / 60 + sec / 3600) * hemi;
    }
    var n = parseFloat(s.replace(/\s/g, '').replace(',', '.'));
    return isNaN(n) ? NaN : n * hemi;
  }

  function levelGroup(rawLevel) {
    // Matched without accents so "Pré-Escolar" and "Pre-Escolar" behave alike.
    var s = deaccent(clean(rawLevel));
    if (s) {
      var order = CONFIG.LEVEL_MATCH_ORDER;
      for (var i = 0; i < order.length; i++) {
        if (order[i].test.test(s)) return order[i];
      }
    }
    return CONFIG.LEVEL_OTHER;
  }

  /* ------------------------------------------------------ point in polygon */
  function pointInRing(lat, lon, ring) {
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var xi = ring[i][0], yi = ring[i][1];
      var xj = ring[j][0], yj = ring[j][1];
      var hit = (yi > lat) !== (yj > lat) &&
        lon < (xj - xi) * (lat - yi) / (yj - yi) + xi;
      if (hit) inside = !inside;
    }
    return inside;
  }

  function pointInPolygon(lat, lon, rings) {
    if (!rings.length || !pointInRing(lat, lon, rings[0])) return false;
    for (var i = 1; i < rings.length; i++) {
      if (pointInRing(lat, lon, rings[i])) return false; // in a hole
    }
    return true;
  }

  /* Flattens a FeatureCollection into [{ name, polygons, bbox }]. */
  function indexBoundaries(geojson) {
    var out = [];
    var features = (geojson && geojson.features) || [];
    features.forEach(function (f) {
      if (!f || !f.geometry) return;
      var props = f.properties || {};
      var name = '';
      for (var i = 0; i < CONFIG.BOUNDARY_NAME_KEYS.length; i++) {
        var v = clean(props[CONFIG.BOUNDARY_NAME_KEYS[i]]);
        if (v) { name = v; break; }
      }
      if (!name) return;
      var geom = f.geometry;
      var polys = geom.type === 'Polygon' ? [geom.coordinates]
        : geom.type === 'MultiPolygon' ? geom.coordinates : [];
      if (!polys.length) return;
      var minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
      polys.forEach(function (rings) {
        rings[0].forEach(function (c) {
          if (c[1] < minLat) minLat = c[1];
          if (c[1] > maxLat) maxLat = c[1];
          if (c[0] < minLon) minLon = c[0];
          if (c[0] > maxLon) maxLon = c[0];
        });
      });
      out.push({ name: name, polygons: polys, bbox: [minLat, minLon, maxLat, maxLon] });
    });
    return out;
  }

  function locate(index, lat, lon) {
    for (var i = 0; i < index.length; i++) {
      var a = index[i], b = a.bbox;
      if (lat < b[0] || lat > b[2] || lon < b[1] || lon > b[3]) continue;
      for (var p = 0; p < a.polygons.length; p++) {
        if (pointInPolygon(lat, lon, a.polygons[p])) return a.name;
      }
    }
    return '';
  }

  /* Great-circle-free nearest centre; fine at this scale. */
  function nearestMunicipality(lat, lon) {
    var best = '', bestD = Infinity;
    CONFIG.MUNICIPALITIES.forEach(function (m) {
      var dLat = lat - m.center[0];
      var dLon = (lon - m.center[1]) * Math.cos(lat * Math.PI / 180);
      var d = dLat * dLat + dLon * dLon;
      if (d < bestD) { bestD = d; best = m.name; }
    });
    return best;
  }

  /* Splits a multi-value cell and snaps each part onto its canonical name. */
  var canonical = {};
  CONFIG.FACETS.forEach(function (f) {
    canonical[f.key] = {};
    f.known.forEach(function (name) { canonical[f.key][slug(name)] = name; });
    Object.keys(f.aliases || {}).forEach(function (name) {
      f.aliases[name].forEach(function (a) { canonical[f.key][slug(a)] = name; });
    });
  });

  function facetValues(key, raw) {
    var out = [];
    clean(raw).split(CONFIG.MULTI_SPLIT).forEach(function (part) {
      var v = clean(part);
      if (!v) return;
      if (/^\d+\.0+$/.test(v)) v = v.replace(/\.0+$/, ''); // "2026.0" -> "2026"
      v = canonical[key][slug(v)] || v;
      if (out.indexOf(v) === -1) out.push(v);
    });
    return out;
  }

  /* ------------------------------------------------------------ normalise */
  function cell(row, cols, field) {
    return clean(cols[field] ? row[cols[field]] : '');
  }

  /* A single "GPS Coordinates" cell holding "-8.75 125.55" (or "-8.75, 125.55")
     stands in for separate latitude / longitude columns. */
  function splitGps(raw) {
    var parts = clean(raw).split(/[\s,;]+/).filter(Boolean);
    return parts.length === 2 ? [parseCoord(parts[0]), parseCoord(parts[1])] : [NaN, NaN];
  }

  /* Whole numbers only; "8.0" from a spreadsheet export becomes "8". */
  function count(raw) {
    var n = parseFloat(clean(raw).replace(/\s/g, '').replace(',', '.'));
    return isFinite(n) ? String(Math.round(n)) : '';
  }

  /* One CSV row -> one school record, or { error } when it cannot be placed. */
  function buildRecord(row, cols, i) {
    var lat = parseCoord(cell(row, cols, 'lat'));
    var lon = parseCoord(cell(row, cols, 'lon'));
    if ((!isFinite(lat) || !isFinite(lon)) && cols.gps) {
      var ll = splitGps(row[cols.gps]);
      lat = ll[0]; lon = ll[1];
    }
    var name = cell(row, cols, 'name') || '(unnamed school)';
    var id = count(cell(row, cols, 'id')) || cell(row, cols, 'id') || String(i + 1);

    if (!isFinite(lat) || !isFinite(lon) || (lat === 0 && lon === 0) ||
      lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return { error: true, id: id, name: name, reason: 'missing or invalid coordinates' };
    }

    var rawLevel = cell(row, cols, 'level');
    var group = levelGroup(rawLevel);
    var school = {
      id: id,
      name: name,
      level: rawLevel || 'Unspecified',
      group: group.key,
      groupLabel: group.label,
      glyph: group.glyph,
      lat: lat,
      lon: lon,
      municipality: cell(row, cols, 'municipality'),
      post: cell(row, cols, 'post'),
      suco: cell(row, cols, 'suco'),
      ownership: cell(row, cols, 'ownership'),
      students: count(cell(row, cols, 'students')),
      teachers: count(cell(row, cols, 'teachers')),
      devices: count(cell(row, cols, 'devices')),
      license: cell(row, cols, 'license'),
      notes: cell(row, cols, 'notes'),
      estimated: false,
      raw: row
    };
    CONFIG.FACETS.forEach(function (f) {
      school[f.key] = facetValues(f.key, cols[f.key] ? row[cols[f.key]] : '');
    });
    return school;
  }

  function hasCoords(cols) {
    return !!((cols.lat && cols.lon) || cols.gps);
  }

  function normalise(rows, headers) {
    var cols = detectColumns(headers);
    var missing = ['name'].filter(function (f) { return !cols[f]; });
    if (!hasCoords(cols)) missing.push('lat', 'lon');
    var schools = [];
    var dropped = [];

    rows.forEach(function (row, i) {
      var rec = buildRecord(row, cols, i);
      if (rec.error) dropped.push(rec);
      else schools.push(rec);
    });

    return { schools: schools, columns: cols, missing: missing, dropped: dropped, headers: headers };
  }

  /* Fills municipality / post from boundary polygons where the CSV had none.
     Returns the number of records that gained a value. */
  function applyBoundaries(schools, boundaries) {
    var filled = 0;
    schools.forEach(function (s) {
      if (!s.municipality && boundaries.municipality) {
        var m = locate(boundaries.municipality, s.lat, s.lon);
        if (m) { s.municipality = m; s.estimated = true; filled++; }
      }
      if (!s.post && boundaries.post) {
        var p = locate(boundaries.post, s.lat, s.lon);
        if (p) { s.post = p; s.estimated = true; filled++; }
      }
    });
    return filled;
  }

  /* Built-in approximation used automatically when nothing better is available. */
  function estimateMunicipalities(schools) {
    var filled = 0;
    schools.forEach(function (s) {
      if (!s.municipality) {
        s.municipality = nearestMunicipality(s.lat, s.lon);
        s.estimated = true;
        filled++;
      }
    });
    return filled;
  }

  function parseRows(text) {
    var res = Papa.parse(text, {
      header: true,
      skipEmptyLines: 'greedy',
      dynamicTyping: false,
      transformHeader: function (h) { return String(h).replace(/^﻿/, '').trim(); }
    });
    return { rows: res.data, headers: (res.meta && res.meta.fields) || [] };
  }

  function parseCsvText(text) {
    var p = parseRows(text);
    return normalise(p.rows, p.headers);
  }

  /* Joins a project list onto the schools, by ID first and exact name second.
     Facet values are added to whatever schools.csv already carried; single
     fields (devices, students, ...) only fill blanks, never overwrite. A row
     that matches no school but has coordinates is added as a new school.
     Returns { matched, added, unmatched: [labels] }. */
  var FILL_FIELDS = ['municipality', 'post', 'suco', 'ownership', 'students', 'teachers', 'devices', 'license', 'notes'];

  function mergeExtra(schools, text) {
    var p = parseRows(text);
    var cols = detectColumns(p.headers);
    var added = 0;
    var byId = Object.create(null), byName = Object.create(null);
    schools.forEach(function (s) {
      byId[s.id] = s;
      var k = slug(s.name);
      byName[k] = k in byName ? null : s; // ambiguous names are not joined
    });
    var matched = 0, unmatched = [];
    p.rows.forEach(function (row) {
      var id = clean(cols.id ? row[cols.id] : '');
      var name = clean(cols.name ? row[cols.name] : '');
      id = count(id) || id;
      var s = (id && byId[id]) || (name && byName[slug(name)]);
      if (!s) {
        var rec = hasCoords(cols) ? buildRecord(row, cols, schools.length) : { error: true };
        if (!rec.error) {
          schools.push(rec);
          byId[rec.id] = rec;
          added++;
        } else if (id || name) {
          unmatched.push(name ? name + (id ? ' (' + id + ')' : '') : id);
        }
        return;
      }
      matched++;
      var fresh = buildRecord(row, cols, 0);
      FILL_FIELDS.forEach(function (k) {
        var v = fresh.error ? cell(row, cols, k) : fresh[k];
        if (fresh.error && /^(students|teachers|devices)$/.test(k)) v = count(v);
        if (!s[k] && v) s[k] = v;
      });
      CONFIG.FACETS.forEach(function (f) {
        if (!cols[f.key]) return;
        facetValues(f.key, row[cols[f.key]]).forEach(function (v) {
          if (s[f.key].indexOf(v) === -1) s[f.key].push(v);
        });
      });
    });
    return { matched: matched, added: added, unmatched: unmatched, columns: cols };
  }

  function fetchFirst(urls) {
    var i = 0;
    function attempt() {
      if (i >= urls.length) return Promise.reject(new Error('no data file found'));
      var url = urls[i++];
      return fetch(url, { cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error(r.status + ' ' + url); return r.text(); })
        .then(function (text) { return { url: url, text: text }; })
        .catch(attempt);
    }
    return attempt();
  }

  function fetchBoundaries() {
    var keys = Object.keys(CONFIG.BOUNDARY_SOURCES);
    return Promise.all(keys.map(function (k) {
      return fetch(CONFIG.BOUNDARY_SOURCES[k], { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) { return j ? indexBoundaries(j) : null; })
        .catch(function () { return null; });
    })).then(function (indexes) {
      var out = {};
      keys.forEach(function (k, i) { if (indexes[i] && indexes[i].length) out[k] = indexes[i]; });
      return out;
    });
  }

  function toCsv(schools) {
    var fields = ['school_id', 'school_name', 'education_level', 'municipality',
      'administrative_post', 'suco', 'latitude', 'longitude', 'ict_donor', 'internet',
      'devices', 'project_year', 'status', 'license', 'students', 'teachers', 'observations'];
    var lines = [fields.join(',')];
    schools.forEach(function (s) {
      lines.push([s.id, s.name, s.level, s.municipality, s.post, s.suco, s.lat, s.lon,
        s.donor.join('; '), s.internet.join('; '), s.devices, s.projectYear.join('; '),
        s.projectStatus.join('; '), s.license, s.students, s.teachers, s.notes]
        .map(function (v) {
          var t = String(v == null ? '' : v);
          return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
        }).join(','));
    });
    return lines.join('\n');
  }

  global.SchoolData = {
    parseCsvText: parseCsvText,
    mergeExtra: mergeExtra,
    fetchFirst: fetchFirst,
    fetchBoundaries: fetchBoundaries,
    applyBoundaries: applyBoundaries,
    estimateMunicipalities: estimateMunicipalities,
    toCsv: toCsv,
    detectColumns: detectColumns,
    parseCoord: parseCoord
  };
})(window);
