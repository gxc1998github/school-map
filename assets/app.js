/* UI: map, filters, search, export. */
(function () {
  'use strict';

  var CONFIG = window.CONFIG;
  var Data = window.SchoolData;

  /* Stands in for "this school has no value" inside a facet filter. */
  var NONE = '__none__';

  var state = {
    schools: [],
    filtered: [],
    markers: new Map(),      // school record -> Leaflet marker (IDs may repeat)
    groupsPresent: [],       // level-group keys in ladder order
    municipality: '',
    post: '',
    levels: null,            // Set of raw level strings, or null = all
    facets: {},              // facet key -> Set of values (NONE for blank), or null = all
    query: '',
    sourceUrl: '',
    hasMunicipalityData: false,
    hasPostData: false,
    estimated: false,
    boundariesUsed: false,
    hydrating: false
  };

  var el = {};
  var map, cluster, statusTimer;

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmt(n) { return n.toLocaleString('en-US'); }

  function status(msg, ms) {
    if (!el.mapStatus) return;
    el.mapStatus.textContent = msg;
    el.mapStatus.classList.add('visible');
    clearTimeout(statusTimer);
    if (ms !== 0) {
      statusTimer = setTimeout(function () {
        el.mapStatus.classList.remove('visible');
      }, ms || 3200);
    }
  }

  /* ------------------------------------------------------------- theming */
  function applyTheme(pref) {
    if (pref === 'auto') document.documentElement.setAttribute('data-theme', 'auto');
    else document.documentElement.setAttribute('data-theme', pref);
    el.themeLabel.textContent = pref.charAt(0).toUpperCase() + pref.slice(1);
    try { localStorage.setItem('tl-school-map-theme', pref); } catch (e) { /* private mode */ }
  }

  /* Marker colours live in CSS custom properties so a theme change repaints
     every marker without rebuilding a single one. */
  function writeRampVars() {
    var keys = state.groupsPresent;
    var ramp = CONFIG.RAMP.steps;
    var ink = CONFIG.RAMP_INK.steps;
    var decls = [];
    keys.forEach(function (key, i) {
      var step = Math.min(i, ramp.length - 1);
      decls.push('--lv-' + key + ':' + ramp[step] + ';--lvi-' + key + ':' + ink[step] + ';');
    });
    decls.push('--lv-other:' + CONFIG.RAMP.other + ';--lvi-other:' + CONFIG.RAMP_INK.other + ';');
    var css = [':root{' + decls.join('') + '}'];
    var tag = $('ramp-vars');
    if (!tag) {
      tag = document.createElement('style');
      tag.id = 'ramp-vars';
      document.head.appendChild(tag);
    }
    tag.textContent = css.join('\n');
  }

  /* --------------------------------------------------------------- basemap */
  var baseLayers = {};
  var currentBase = null;

  function setBasemap(name) {
    var next = baseLayers[name];
    if (!next || (currentBase && currentBase.name === name)) return;
    if (currentBase) map.removeLayer(currentBase.layer);
    map.addLayer(next.layer);
    currentBase = next;
  }

  /* Leaflet never needs a key, but a tile provider can refuse requests
     (rate limits, referrer rules, "API key required" images). If the active
     basemap errors before a single tile loads, fall through to the next one
     so the map never comes up blank or blocked. */
  function watchBasemap(entry) {
    entry.loaded = 0;
    entry.errors = 0;
    entry.layer.on('tileload', function () { entry.loaded++; });
    entry.layer.on('tileerror', function () {
      entry.errors++;
      if (entry.failed || entry.loaded > 0 || entry.errors < 4) return;
      entry.failed = true;
      if (currentBase !== entry) return;
      var fallback = CONFIG.BASEMAPS.filter(function (b) {
        return !baseLayers[b.name].failed;
      })[0];
      if (!fallback) {
        status('Map tiles could not be loaded. Check your connection.', 0);
        return;
      }
      setBasemap(fallback.name);
      status(entry.name + ' tiles are unavailable, switched to ' + fallback.name + '.', 5000);
    });
  }

  /* ------------------------------------------------------------------ map */
  function initMap() {
    map = L.map('map', {
      center: CONFIG.TL_CENTER,
      zoom: 9,
      // Zoom 8 is as far out as the map goes: the scale bar reads 50 km there.
      minZoom: CONFIG.MIN_ZOOM,
      maxZoom: 19,
      zoomControl: true,
      // Keep the view locked to Timor-Leste (Oecusse to Jaco, including Ataúro).
      maxBounds: CONFIG.TL_BOUNDS,
      maxBoundsViscosity: 1.0
    });

    var overlays = {};
    CONFIG.BASEMAPS.forEach(function (b) {
      baseLayers[b.name] = { name: b.name, layer: L.tileLayer(b.url, b.options) };
      watchBasemap(baseLayers[b.name]);
      overlays[b.name] = baseLayers[b.name].layer;
    });
    setBasemap('OpenStreetMap');

    L.control.layers(overlays, null, { position: 'topright', collapsed: true }).addTo(map);
    L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);

    // Keep the layer control in step when the user picks a basemap by hand.
    map.on('baselayerchange', function (e) {
      currentBase = baseLayers[e.name] || currentBase;
    });

    cluster = L.markerClusterGroup({
      chunkedLoading: true,
      spiderfyOnMaxZoom: true,
      showCoverageOnHover: false,
      maxClusterRadius: function (zoom) { return zoom >= 14 ? 24 : 60; },
      disableClusteringAtZoom: 17
    });
    map.addLayer(cluster);
  }

  function markerHtml(school) {
    return '<div class="school-dot" style="background:var(--lv-' + school.group +
      ');color:var(--lvi-' + school.group + ')">' + esc(school.glyph) + '</div>';
  }

  function popupHtml(school) {
    var rows = [
      ['Level', school.level],
      ['Municipality', school.municipality],
      ['Admin. post', school.post],
      ['Suco', school.suco],
      ['Ownership', school.ownership],
      ['Students', school.students],
      ['Teachers', school.teachers],
      ['ICT donor', school.donor.join(', ')],
      ['Devices', school.devices],
      ['Project year', school.projectYear.join(', ')],
      ['Status', school.projectStatus.join(', ')],
      ['License', school.license],
      ['Internet', school.internet.join(', ')],
      ['Notes', school.notes],
      ['School ID', school.id]
    ].filter(function (r) { return r[1]; });

    var dl = rows.map(function (r) {
      return '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>';
    }).join('');

    var coords = school.lat.toFixed(5) + ', ' + school.lon.toFixed(5);
    var gmaps = 'https://www.google.com/maps/search/?api=1&query=' + school.lat + ',' + school.lon;
    var osm = 'https://www.openstreetmap.org/?mlat=' + school.lat + '&mlon=' + school.lon + '#map=17/' + school.lat + '/' + school.lon;

    return '<div class="popup"><h3>' + esc(school.name) + '</h3><dl>' + dl +
      '<dt>Coords</dt><dd>' + coords + '</dd></dl>' +
      (school.estimated ? '<p class="popup-actions">Area estimated from coordinates.</p>' : '') +
      '<p class="popup-actions"><a href="' + gmaps + '" target="_blank" rel="noopener">Google Maps</a> · ' +
      '<a href="' + osm + '" target="_blank" rel="noopener">OpenStreetMap</a></p></div>';
  }

  function buildMarkers() {
    state.markers.clear();
    state.schools.forEach(function (s) {
      var marker = L.marker([s.lat, s.lon], {
        icon: L.divIcon({
          className: 'school-marker',
          html: markerHtml(s),
          iconSize: [18, 18],
          iconAnchor: [9, 9],
          popupAnchor: [0, -10]
        }),
        title: s.name,
        alt: s.name + (s.level ? ' — ' + s.level : ''),
        keyboard: true
      });
      marker.bindPopup(function () { return popupHtml(s); }, { maxWidth: 300, minWidth: 200 });
      state.markers.set(s, marker);
    });
  }

  /* -------------------------------------------------------------- filters */
  function distinct(values) {
    var seen = Object.create(null);
    var out = [];
    values.forEach(function (v) {
      if (v && !seen[v]) { seen[v] = true; out.push(v); }
    });
    return out.sort(function (a, b) { return a.localeCompare(b, undefined, { numeric: true }); });
  }

  /* Schools passing every filter except the named ones — so each control can
     show counts for the choices actually available to it. `except` is a
     string, an array of names, or null for "apply everything". */
  function passing(school, except) {
    var skip = except == null ? [] : (typeof except === 'string' ? [except] : except);
    if (skip.indexOf('municipality') === -1 && state.municipality && school.municipality !== state.municipality) return false;
    if (skip.indexOf('post') === -1 && state.post && school.post !== state.post) return false;
    if (skip.indexOf('levels') === -1 && state.levels && !state.levels.has(school.level)) return false;
    for (var i = 0; i < CONFIG.FACETS.length; i++) {
      var key = CONFIG.FACETS[i].key;
      var picked = state.facets[key];
      if (!picked || skip.indexOf(key) !== -1) continue;
      var values = school[key].length ? school[key] : [NONE];
      if (!values.some(function (v) { return picked.has(v); })) return false;
    }
    if (skip.indexOf('query') === -1 && state.query && !matchesQuery(school, state.query)) return false;
    return true;
  }

  function matchesQuery(school, q) {
    var terms = q.split(/\s+/).filter(Boolean);
    var hay = (school.name + ' ' + school.id + ' ' + school.level + ' ' +
      school.municipality + ' ' + school.post + ' ' + school.suco + ' ' +
      school.donor.join(' ') + ' ' + school.internet.join(' ')).toLowerCase();
    return terms.every(function (t) { return hay.indexOf(t) !== -1; });
  }

  function countBy(schools, key) {
    var counts = Object.create(null);
    schools.forEach(function (s) {
      var v = s[key];
      if (v) counts[v] = (counts[v] || 0) + 1;
    });
    return counts;
  }

  function fillSelect(select, options, counts, selected, allLabel, enabled) {
    var frag = document.createDocumentFragment();
    var all = document.createElement('option');
    all.value = '';
    all.textContent = allLabel;
    frag.appendChild(all);
    options.forEach(function (name) {
      var o = document.createElement('option');
      o.value = name;
      o.textContent = name + ' (' + fmt(counts[name] || 0) + ')';
      frag.appendChild(o);
    });
    // A selection that the current filters have made unavailable is kept as an
    // option so it does not silently vanish from the control.
    if (selected && options.indexOf(selected) === -1) {
      var o2 = document.createElement('option');
      o2.value = selected;
      o2.textContent = selected + ' (0)';
      frag.appendChild(o2);
    }
    select.innerHTML = '';
    select.appendChild(frag);
    select.value = selected || '';
    select.disabled = !enabled;
  }

  function renderFilterControls() {
    // The post filter is a child of the municipality filter, so it must not
    // narrow the municipality list — otherwise picking a post collapses the
    // municipality dropdown to a single entry.
    var forMuni = state.schools.filter(function (s) { return passing(s, ['municipality', 'post']); });
    var muniCounts = countBy(forMuni, 'municipality');
    fillSelect(el.filterMunicipality, distinct(forMuni.map(function (s) { return s.municipality; })),
      muniCounts, state.municipality,
      state.hasMunicipalityData ? 'All municipalities' : 'No municipality data',
      state.hasMunicipalityData);

    // Administrative posts are scoped to the chosen municipality.
    var forPost = state.schools.filter(function (s) { return passing(s, 'post'); });
    var postCounts = countBy(forPost, 'post');
    fillSelect(el.filterPost, distinct(forPost.map(function (s) { return s.post; })),
      postCounts, state.post,
      state.hasPostData ? 'All administrative posts' : 'No administrative post data',
      state.hasPostData);

    refreshLevelCounts();
    refreshFacetCounts();
  }

  /* ------------------------------------------------ ICT donor / internet */
  /* Same build-once, refresh-counts pattern as the level list. A school may
     carry several values, so it counts once under each of them. */
  function facetOptions(key) {
    var known = CONFIG.FACETS.filter(function (f) { return f.key === key; })[0].known;
    var seen = [];
    state.schools.forEach(function (s) {
      s[key].forEach(function (v) { if (seen.indexOf(v) === -1) seen.push(v); });
    });
    // Known values first in their configured order, then anything else A–Z.
    return seen.sort(function (a, b) {
      var ia = known.indexOf(a), ib = known.indexOf(b);
      if (ia === -1) ia = 999;
      if (ib === -1) ib = 999;
      return ia !== ib ? ia - ib : a.localeCompare(b);
    });
  }

  function buildFacetChecks() {
    CONFIG.FACETS.forEach(function (f) {
      var box = el.facets[f.key];
      var values = facetOptions(f.key);
      box.wrap.hidden = !values.length;
      if (!values.length) { box.list.innerHTML = ''; return; }
      // Offer "none recorded" only when some school actually has none.
      var gaps = state.schools.some(function (s) { return !s[f.key].length; });
      box.list.innerHTML = values.concat(gaps ? [NONE] : []).map(function (v) {
        var label = v === NONE ? f.none : v;
        return '<label class="check"><input type="checkbox" checked value="' + esc(v) + '">' +
          '<span class="check-text' + (v === NONE ? ' check-none' : '') + '">' + esc(label) + '</span>' +
          '<span class="check-count" data-value="' + esc(v) + '">0</span></label>';
      }).join('');
    });
  }

  function refreshFacetCounts() {
    CONFIG.FACETS.forEach(function (f) {
      var box = el.facets[f.key];
      if (box.wrap.hidden) return;
      var counts = Object.create(null);
      state.schools.forEach(function (s) {
        if (!passing(s, f.key)) return;
        (s[f.key].length ? s[f.key] : [NONE]).forEach(function (v) { counts[v] = (counts[v] || 0) + 1; });
      });
      var picked = state.facets[f.key];
      box.list.querySelectorAll('.check-count').forEach(function (span) {
        span.textContent = fmt(counts[span.dataset.value] || 0);
      });
      box.list.querySelectorAll('input[type="checkbox"]').forEach(function (b) {
        var want = !picked || picked.has(b.value);
        if (b.checked !== want) b.checked = want;
      });
    });
  }

  function readFacetChecks(key) {
    var boxes = el.facets[key].list.querySelectorAll('input[type="checkbox"]');
    var picked = new Set();
    boxes.forEach(function (b) { if (b.checked) picked.add(b.value); });
    state.facets[key] = (picked.size === 0 || picked.size === boxes.length) ? null : picked;
  }

  /* The level list itself only changes when the dataset changes, so the rows
     are built once and afterwards only their counts and checked state are
     touched. Rebuilding them on every filter pass would yank the checkbox out
     from under the pointer and drop keyboard focus mid-interaction. */
  function buildLevelChecks() {
    var levels = distinct(state.schools.map(function (s) { return s.level; }));

    // Order by the education ladder first, then alphabetically inside a group.
    var order = {};
    CONFIG.LEVEL_GROUPS.forEach(function (g, i) { order[g.key] = i; });
    order[CONFIG.LEVEL_OTHER.key] = 99;
    var groupOf = {};
    state.schools.forEach(function (s) { groupOf[s.level] = s; });
    levels.sort(function (a, b) {
      var ga = order[groupOf[a].group], gb = order[groupOf[b].group];
      return ga !== gb ? ga - gb : a.localeCompare(b);
    });

    if (!levels.length) {
      el.filterLevels.innerHTML = '<p class="note">No education level column in this file.</p>';
      return;
    }
    el.filterLevels.innerHTML = levels.map(function (level) {
      var sample = groupOf[level];
      return '<label class="check" title="' + esc(level + ' — ' + sample.groupLabel) + '">' +
        '<input type="checkbox" checked value="' + esc(level) + '">' +
        '<span class="swatch" style="background:var(--lv-' + sample.group +
        ');color:var(--lvi-' + sample.group + ')" aria-hidden="true">' + esc(sample.glyph) + '</span>' +
        '<span class="check-text">' + esc(level) + '</span>' +
        '<span class="check-count" data-level="' + esc(level) + '">0</span>' +
        '</label>';
    }).join('');
  }

  function refreshLevelCounts() {
    var counts = countBy(state.schools.filter(function (s) { return passing(s, 'levels'); }), 'level');
    el.filterLevels.querySelectorAll('.check-count').forEach(function (span) {
      span.textContent = fmt(counts[span.dataset.level] || 0);
    });
    el.filterLevels.querySelectorAll('input[type="checkbox"]').forEach(function (box) {
      var want = !state.levels || state.levels.has(box.value);
      if (box.checked !== want) box.checked = want;
    });
  }

  function readLevelChecks() {
    var boxes = el.filterLevels.querySelectorAll('input[type="checkbox"]');
    var picked = new Set();
    var total = 0;
    boxes.forEach(function (b) { total++; if (b.checked) picked.add(b.value); });
    state.levels = (picked.size === 0 || picked.size === total) ? null : picked;
  }

  /* ---------------------------------------------------------------- stats */
  function renderStats() {
    el.statShown.textContent = fmt(state.filtered.length);
    el.statTotal.textContent = fmt(state.schools.length);
    el.statMunis.textContent = fmt(distinct(state.filtered.map(function (s) { return s.municipality; })).length);
    el.statPosts.textContent = fmt(distinct(state.filtered.map(function (s) { return s.post; })).length);
    var devices = 0;
    state.filtered.forEach(function (s) {
      if (s.devices) devices += Number(s.devices);
    });
    el.statDevices.textContent = fmt(devices);
    el.statDevicesWrap.hidden = !state.schools.some(function (s) { return s.devices; });
  }

  function renderMarkers() {
    cluster.clearLayers();
    var layers = [];
    state.filtered.forEach(function (s) {
      var m = state.markers.get(s);
      if (m) layers.push(m);
    });
    cluster.addLayers(layers);
  }

  function apply(options) {
    options = options || {};
    state.filtered = state.schools.filter(function (s) { return passing(s, null); });
    renderFilterControls();
    renderMarkers();
    renderStats();
    if (!state.hydrating) writeHash();
    if (options.fit !== false) fitToResults();
  }

  var fitTimer;
  function fitToResults() {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(function () {
      if (!state.filtered.length) return;
      var bounds = L.latLngBounds(state.filtered.map(function (s) { return [s.lat, s.lon]; }));
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15, animate: true });
    }, 60);
  }

  /* ----------------------------------------------------------- URL state */
  function writeHash() {
    var p = new URLSearchParams();
    if (state.municipality) p.set('m', state.municipality);
    if (state.post) p.set('p', state.post);
    if (state.query) p.set('q', state.query);
    if (state.levels) p.set('l', Array.from(state.levels).join('|'));
    CONFIG.FACETS.forEach(function (f) {
      var picked = state.facets[f.key];
      if (picked) p.set(f.key, Array.from(picked).map(function (v) { return v === NONE ? '-' : v; }).join('|'));
    });
    var hash = p.toString();
    var url = location.pathname + location.search + (hash ? '#' + hash : '');
    history.replaceState(null, '', url);
  }

  function readHash() {
    var raw = location.hash.replace(/^#/, '');
    if (!raw) return {};
    var p = new URLSearchParams(raw);
    var facets = {};
    CONFIG.FACETS.forEach(function (f) {
      var v = p.get(f.key);
      facets[f.key] = v ? new Set(v.split('|').map(function (x) { return x === '-' ? NONE : x; })) : null;
    });
    return {
      facets: facets,
      municipality: p.get('m') || '',
      post: p.get('p') || '',
      query: p.get('q') || '',
      levels: p.get('l') ? new Set(p.get('l').split('|')) : null
    };
  }

  /* --------------------------------------------------------------- data */
  function adoptDataset(result, sourceLabel) {
    state.schools = result.schools;
    state.sourceUrl = sourceLabel;

    var groups = [];
    CONFIG.LEVEL_GROUPS.forEach(function (g) {
      if (result.schools.some(function (s) { return s.group === g.key; })) groups.push(g.key);
    });
    state.groupsPresent = groups;
    writeRampVars();

    state.hasMunicipalityData = result.schools.some(function (s) { return s.municipality; });
    state.hasPostData = result.schools.some(function (s) { return s.post; });

    buildMarkers();
    buildLevelChecks();
    buildFacetChecks();
    updateSourceNote(result);
    updateGeoNote(result);
  }

  function updateSourceNote(result) {
    var bits = [fmt(result.schools.length) + ' schools'];
    bits.push(state.sourceUrl);
    if (result.dropped.length) bits.push(fmt(result.dropped.length) + ' skipped (no coordinates)');
    var extra = result.extra;
    if (extra) {
      var parts = [];
      if (extra.added) parts.push(fmt(extra.added) + ' added');
      if (extra.matched) parts.push(fmt(extra.matched) + ' joined');
      if (extra.unmatched.length) parts.push(fmt(extra.unmatched.length) + ' unmatched');
      bits.push('project list: ' + (parts.join(', ') || 'empty'));
    }
    el.sourceNote.textContent = bits.join(' · ');
    var tips = [];
    if (result.dropped.length) {
      tips.push('Skipped: ' + result.dropped.slice(0, 20).map(function (d) { return d.name; }).join(', '));
    }
    if (extra && extra.unmatched.length) {
      tips.push('Not found in schools.csv: ' + extra.unmatched.slice(0, 20).join(', '));
    }
    el.sourceNote.title = tips.join('\n');
  }

  function updateGeoNote(result) {
    var msgs = [];
    if (result.missing.length) {
      msgs.push('Missing expected column(s): ' + result.missing.join(', ') + '.');
    }
    if (state.boundariesUsed) {
      msgs.push('Areas filled in from the boundary files in data/boundaries/.');
    }
    if (state.estimated) {
      msgs.push('Municipalities are estimated from coordinates — approximate near municipal borders.');
    }
    el.geoNote.textContent = msgs.join(' ');
    el.geoNote.hidden = !msgs.length;
    el.geoNote.className = result.missing.length ? 'note warn' : 'note';
  }

  function loadInitial() {
    var boundaries = {};
    var extraTexts = [];
    // Project lists are optional; a missing file is not an error.
    var extraReq = Promise.all(CONFIG.EXTRA_SOURCES.map(function (url) {
      return Data.fetchFirst([url]).then(function (r) { return r.text; }, function () { return null; });
    })).then(function (texts) { extraTexts = texts.filter(Boolean); });
    Data.fetchBoundaries()
      .then(function (b) { boundaries = b; return extraReq; })
      .then(function () { return Data.fetchFirst(CONFIG.DATA_SOURCES); })
      .then(function (res) {
        var parsed = Data.parseCsvText(res.text);
        extraTexts.forEach(function (text) {
          var r = Data.mergeExtra(parsed.schools, text);
          var e = parsed.extra || (parsed.extra = { matched: 0, added: 0, unmatched: [] });
          e.matched += r.matched;
          e.added += r.added;
          e.unmatched = e.unmatched.concat(r.unmatched);
        });
        if (Object.keys(boundaries).length) {
          var filled = Data.applyBoundaries(parsed.schools, boundaries);
          state.boundariesUsed = filled > 0;
        }
        // Built-in fallback: with no municipality column and no boundary
        // file, assign each school to the nearest municipal centre.
        if (!parsed.schools.some(function (s) { return s.municipality; })) {
          state.estimated = Data.estimateMunicipalities(parsed.schools) > 0;
        }
        adoptDataset(parsed, res.url);
        hydrateFromHash();
      })
      .catch(function (err) {
        el.sourceNote.textContent = 'Could not load school data';
        status('Could not load ' + CONFIG.DATA_SOURCES.join(' or ') + ' — ' + err.message, 0);
      });
  }

  function hydrateFromHash() {
    var h = readHash();
    state.hydrating = true;
    state.municipality = h.municipality || '';
    state.post = h.post || '';
    state.query = (h.query || '').toLowerCase();
    state.levels = h.levels || null;
    state.facets = h.facets || {};
    el.search.value = h.query || '';
    state.hydrating = false;
    apply();
  }

  /* --------------------------------------------------------------- events */
  function bind() {
    el.filterMunicipality.addEventListener('change', function () {
      state.municipality = this.value;
      // A post from another municipality can no longer apply.
      if (state.post) {
        var stillValid = state.schools.some(function (s) {
          return s.post === state.post && (!state.municipality || s.municipality === state.municipality);
        });
        if (!stillValid) state.post = '';
      }
      apply();
    });

    el.filterPost.addEventListener('change', function () {
      state.post = this.value;
      apply();
    });

    el.filterLevels.addEventListener('change', function () {
      readLevelChecks();
      apply();
    });

    CONFIG.FACETS.forEach(function (f) {
      el.facets[f.key].list.addEventListener('change', function () {
        readFacetChecks(f.key);
        apply();
      });
    });

    var searchTimer;
    el.search.addEventListener('input', function () {
      var value = this.value.trim().toLowerCase();
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        state.query = value;
        apply({ fit: !!value });
      }, 180);
    });

    el.clearFilters.addEventListener('click', function () {
      state.municipality = '';
      state.post = '';
      state.levels = null;
      state.facets = {};
      state.query = '';
      el.search.value = '';
      apply();
    });

    el.exportCsv.addEventListener('click', function () {
      if (!state.filtered.length) { status('Nothing to export'); return; }
      var blob = new Blob([Data.toCsv(state.filtered)], { type: 'text/csv;charset=utf-8' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'schools-filtered.csv';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
      status('Exported ' + fmt(state.filtered.length) + ' schools');
    });

    el.panelToggle.addEventListener('click', function () {
      var open = el.sidebar.classList.toggle('open');
      this.setAttribute('aria-expanded', String(open));
    });

    window.addEventListener('hashchange', function () {
      if (state.schools.length) hydrateFromHash();
    });
  }

  /* ----------------------------------------------------------------- init */
  function init() {
    el = {
      sourceNote: $('source-note'),
      sidebar: $('sidebar'),
      panelToggle: $('panel-toggle'),
      search: $('search'),
      filterMunicipality: $('filter-municipality'),
      filterPost: $('filter-post'),
      filterLevels: $('filter-levels'),
      clearFilters: $('clear-filters'),
      exportCsv: $('export-csv'),
      geoNote: $('geo-note'),
      statShown: $('stat-shown'),
      statTotal: $('stat-total'),
      statMunis: $('stat-munis'),
      statPosts: $('stat-posts'),
      statDevices: $('stat-devices'),
      statDevicesWrap: $('stat-devices-wrap'),
      mapStatus: $('map-status'),
      facets: {}
    };
    CONFIG.FACETS.forEach(function (f) {
      el.facets[f.key] = { wrap: $('facet-' + f.key), list: $('filter-' + f.key) };
    });

    initMap();
    bind();
    loadInitial();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
