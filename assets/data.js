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

  /* ------------------------------------------------------------ normalise */
  function normalise(rows, headers) {
    var cols = detectColumns(headers);
    var missing = ['name', 'lat', 'lon'].filter(function (f) { return !cols[f]; });
    var schools = [];
    var dropped = [];

    rows.forEach(function (row, i) {
      var lat = parseCoord(cols.lat ? row[cols.lat] : '');
      var lon = parseCoord(cols.lon ? row[cols.lon] : '');
      var name = clean(cols.name ? row[cols.name] : '') || '(unnamed school)';
      var id = clean(cols.id ? row[cols.id] : '') || String(i + 1);

      if (!isFinite(lat) || !isFinite(lon) || (lat === 0 && lon === 0) ||
        lat < -90 || lat > 90 || lon < -180 || lon > 180) {
        dropped.push({ id: id, name: name, reason: 'missing or invalid coordinates' });
        return;
      }

      var rawLevel = clean(cols.level ? row[cols.level] : '');
      var group = levelGroup(rawLevel);
      schools.push({
        id: id,
        name: name,
        level: rawLevel || 'Unspecified',
        group: group.key,
        groupLabel: group.label,
        glyph: group.glyph,
        lat: lat,
        lon: lon,
        municipality: clean(cols.municipality ? row[cols.municipality] : ''),
        post: clean(cols.post ? row[cols.post] : ''),
        suco: clean(cols.suco ? row[cols.suco] : ''),
        ownership: clean(cols.ownership ? row[cols.ownership] : ''),
        students: clean(cols.students ? row[cols.students] : ''),
        teachers: clean(cols.teachers ? row[cols.teachers] : ''),
        estimated: false,
        raw: row
      });
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

  /* Opt-in approximation used only when nothing better is available. */
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

  function parseCsvText(text) {
    var res = Papa.parse(text, {
      header: true,
      skipEmptyLines: 'greedy',
      dynamicTyping: false,
      transformHeader: function (h) { return String(h).replace(/^﻿/, '').trim(); }
    });
    var headers = (res.meta && res.meta.fields) || [];
    return normalise(res.data, headers);
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
      'administrative_post', 'suco', 'latitude', 'longitude'];
    var lines = [fields.join(',')];
    schools.forEach(function (s) {
      lines.push([s.id, s.name, s.level, s.municipality, s.post, s.suco, s.lat, s.lon]
        .map(function (v) {
          var t = String(v == null ? '' : v);
          return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
        }).join(','));
    });
    return lines.join('\n');
  }

  global.SchoolData = {
    parseCsvText: parseCsvText,
    fetchFirst: fetchFirst,
    fetchBoundaries: fetchBoundaries,
    applyBoundaries: applyBoundaries,
    estimateMunicipalities: estimateMunicipalities,
    toCsv: toCsv,
    detectColumns: detectColumns,
    parseCoord: parseCoord
  };
})(window);
