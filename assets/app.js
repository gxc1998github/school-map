/* UI: map, filters, search, results. */
(function () {
  'use strict';

  var CONFIG = window.CONFIG;
  var Data = window.SchoolData;

  var RESULT_LIMIT = 300;

  var state = {
    schools: [],
    filtered: [],
    markers: new Map(),      // school id -> Leaflet marker
    groupsPresent: [],       // level-group keys in ladder order
    municipality: '',
    post: '',
    levels: null,            // Set of raw level strings, or null = all
    query: '',
    activeId: null,
    sourceUrl: '',
    hasMunicipalityData: false,
    hasPostData: false,
    estimateOn: false,
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
  function effectiveTheme() {
    var pref = document.documentElement.getAttribute('data-theme');
    if (pref === 'light' || pref === 'dark') return pref;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function applyTheme(pref) {
    if (pref === 'auto') document.documentElement.setAttribute('data-theme', 'auto');
    else document.documentElement.setAttribute('data-theme', pref);
    el.themeLabel.textContent = pref.charAt(0).toUpperCase() + pref.slice(1);
    try { localStorage.setItem('tl-school-map-theme', pref); } catch (e) { /* private mode */ }
    syncBasemapToTheme();
  }

  /* Marker colours live in CSS custom properties so a theme change repaints
     every marker without rebuilding a single one. */
  function writeRampVars() {
    var keys = state.groupsPresent;
    var css = [];
    ['light', 'dark'].forEach(function (mode) {
      var ramp = CONFIG.RAMP[mode];
      var ink = CONFIG.RAMP_INK[mode];
      var decls = [];
      keys.forEach(function (key, i) {
        var step = Math.min(i, ramp.length - 1);
        decls.push('--lv-' + key + ':' + ramp[step] + ';--lvi-' + key + ':' + ink[step] + ';');
      });
      decls.push('--lv-other:' + CONFIG.RAMP.other + ';--lvi-other:' + CONFIG.RAMP_INK.other + ';');
      var body = decls.join('');
      if (mode === 'light') {
        css.push(':root{' + body + '}');
      } else {
        css.push('@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){' + body + '}}');
        css.push(':root[data-theme="dark"]{' + body + '}');
      }
    });
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

  function syncBasemapToTheme() {
    if (!map) return;
    // Only auto-swap between the two Carto styles; a deliberate choice of
    // OpenStreetMap or Satellite is left alone.
    var name = currentBase && currentBase.name;
    if (name !== 'Carto Light' && name !== 'Carto Dark') return;
    var want = effectiveTheme() === 'dark' ? 'Carto Dark' : 'Carto Light';
    if (want !== name) setBasemap(want);
  }

  function setBasemap(name) {
    var next = baseLayers[name];
    if (!next || (currentBase && currentBase.name === name)) return;
    if (currentBase) map.removeLayer(currentBase.layer);
    map.addLayer(next.layer);
    currentBase = next;
  }

  /* ------------------------------------------------------------------ map */
  function initMap() {
    map = L.map('map', {
      center: CONFIG.TL_CENTER,
      zoom: 9,
      minZoom: 6,
      maxZoom: 19,
      zoomControl: true,
      worldCopyJump: true
    });

    var overlays = {};
    CONFIG.BASEMAPS.forEach(function (b) {
      baseLayers[b.name] = { name: b.name, layer: L.tileLayer(b.url, b.options) };
      overlays[b.name] = baseLayers[b.name].layer;
    });
    setBasemap(effectiveTheme() === 'dark' ? 'Carto Dark' : 'Carto Light');

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
      marker.on('popupopen', function () { setActive(s.id, false); });
      state.markers.set(s.id, marker);
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
    if (skip.indexOf('query') === -1 && state.query && !matchesQuery(school, state.query)) return false;
    return true;
  }

  function matchesQuery(school, q) {
    var terms = q.split(/\s+/).filter(Boolean);
    var hay = (school.name + ' ' + school.id + ' ' + school.level + ' ' +
      school.municipality + ' ' + school.post + ' ' + school.suco).toLowerCase();
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

  /* -------------------------------------------------------------- results */
  function renderLegend() {
    var counts = Object.create(null);
    state.filtered.forEach(function (s) { counts[s.group] = (counts[s.group] || 0) + 1; });
    var groups = CONFIG.LEVEL_GROUPS.concat([CONFIG.LEVEL_OTHER]).filter(function (g) {
      return state.groupsPresent.indexOf(g.key) !== -1 || g.key === CONFIG.LEVEL_OTHER.key;
    }).filter(function (g) {
      return state.schools.some(function (s) { return s.group === g.key; });
    });

    el.legend.innerHTML = groups.map(function (g) {
      return '<li><span class="swatch" style="background:var(--lv-' + g.key +
        ');color:var(--lvi-' + g.key + ')" aria-hidden="true">' + esc(g.glyph) + '</span>' +
        '<span class="legend-name">' + esc(g.label) + '</span>' +
        '<span class="legend-count">' + fmt(counts[g.key] || 0) + '</span></li>';
    }).join('');
  }

  function renderResults() {
    var shown = state.filtered.slice(0, RESULT_LIMIT);
    if (!shown.length) {
      el.results.innerHTML = '<li class="empty">No schools match these filters.</li>';
      el.resultsMore.hidden = true;
      return;
    }
    var html = shown.map(function (s) {
      var meta = [s.level, s.post, s.municipality].filter(Boolean).join(' · ');
      return '<li><button type="button" class="result" data-id="' + esc(s.id) + '"' +
        (state.activeId === s.id ? ' aria-current="true"' : '') + '>' +
        '<span class="swatch" style="background:var(--lv-' + s.group +
        ');color:var(--lvi-' + s.group + ')" aria-hidden="true">' + esc(s.glyph) + '</span>' +
        '<span class="result-body"><span class="result-name">' + esc(s.name) + '</span>' +
        '<span class="result-meta">' + esc(meta) + '</span></span></button></li>';
    }).join('');
    el.results.innerHTML = html;

    if (state.filtered.length > RESULT_LIMIT) {
      el.resultsMore.textContent = 'Showing the first ' + fmt(RESULT_LIMIT) + ' of ' +
        fmt(state.filtered.length) + ' matches — narrow the filters or search to see the rest. All ' +
        fmt(state.filtered.length) + ' are on the map.';
      el.resultsMore.hidden = false;
    } else {
      el.resultsMore.hidden = true;
    }
  }

  function renderStats() {
    el.statShown.textContent = fmt(state.filtered.length);
    el.statTotal.textContent = fmt(state.schools.length);
    el.statMunis.textContent = fmt(distinct(state.filtered.map(function (s) { return s.municipality; })).length);
    el.statPosts.textContent = fmt(distinct(state.filtered.map(function (s) { return s.post; })).length);
  }

  function renderMarkers() {
    cluster.clearLayers();
    var layers = [];
    state.filtered.forEach(function (s) {
      var m = state.markers.get(s.id);
      if (m) layers.push(m);
    });
    cluster.addLayers(layers);
  }

  function apply(options) {
    options = options || {};
    state.filtered = state.schools.filter(function (s) { return passing(s, null); });
    renderFilterControls();
    renderMarkers();
    renderLegend();
    renderResults();
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

  function setActive(id, pan) {
    state.activeId = id;
    el.results.querySelectorAll('.result').forEach(function (b) {
      if (b.dataset.id === String(id)) b.setAttribute('aria-current', 'true');
      else b.removeAttribute('aria-current');
    });
    if (pan) {
      var school = state.schools.find(function (s) { return s.id === id; });
      var marker = state.markers.get(id);
      if (!school || !marker) return;
      map.setView([school.lat, school.lon], Math.max(map.getZoom(), 16), { animate: true });
      // The marker may be inside a cluster; ask the group to reveal it first.
      cluster.zoomToShowLayer(marker, function () { marker.openPopup(); });
    }
  }

  /* ----------------------------------------------------------- URL state */
  function writeHash() {
    var p = new URLSearchParams();
    if (state.municipality) p.set('m', state.municipality);
    if (state.post) p.set('p', state.post);
    if (state.query) p.set('q', state.query);
    if (state.levels) p.set('l', Array.from(state.levels).join('|'));
    if (state.estimateOn) p.set('est', '1');
    var hash = p.toString();
    var url = location.pathname + location.search + (hash ? '#' + hash : '');
    history.replaceState(null, '', url);
  }

  function readHash() {
    var raw = location.hash.replace(/^#/, '');
    if (!raw) return {};
    var p = new URLSearchParams(raw);
    return {
      municipality: p.get('m') || '',
      post: p.get('p') || '',
      query: p.get('q') || '',
      levels: p.get('l') ? new Set(p.get('l').split('|')) : null,
      estimate: p.get('est') === '1'
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
    updateSourceNote(result);
    updateGeoNote(result);
  }

  function updateSourceNote(result) {
    var bits = [fmt(result.schools.length) + ' schools'];
    bits.push(state.sourceUrl);
    if (result.dropped.length) bits.push(fmt(result.dropped.length) + ' skipped (no coordinates)');
    el.sourceNote.textContent = bits.join(' · ');
    el.sourceNote.title = result.dropped.length
      ? 'Skipped: ' + result.dropped.slice(0, 20).map(function (d) { return d.name; }).join(', ')
      : '';
  }

  function updateGeoNote(result) {
    var msgs = [];
    if (result.missing.length) {
      msgs.push('Missing expected column(s): ' + result.missing.join(', ') + '.');
    }
    if (!state.hasMunicipalityData && !state.hasPostData) {
      msgs.push('This file has no municipality or administrative post column. ' +
        'Add one, drop boundary GeoJSON files into data/boundaries/, or switch on the estimate below.');
    } else if (state.boundariesUsed) {
      msgs.push('Areas filled in from the boundary files in data/boundaries/.');
    }
    if (state.estimateOn) {
      msgs.push('Municipalities are estimated by nearest centre — approximate near municipal borders.');
    }
    el.geoNote.textContent = msgs.join(' ');
    el.geoNote.hidden = !msgs.length;
    el.geoNote.className = 'note warn';
    el.estimateRow.hidden = state.hasMunicipalityData;
  }

  function loadInitial() {
    var boundaries = {};
    Data.fetchBoundaries()
      .then(function (b) { boundaries = b; return Data.fetchFirst(CONFIG.DATA_SOURCES); })
      .then(function (res) {
        var parsed = Data.parseCsvText(res.text);
        if (Object.keys(boundaries).length) {
          var filled = Data.applyBoundaries(parsed.schools, boundaries);
          state.boundariesUsed = filled > 0;
        }
        adoptDataset(parsed, res.url);
        hydrateFromHash();
      })
      .catch(function (err) {
        el.sourceNote.textContent = 'Could not load school data';
        el.results.innerHTML = '<li class="empty">No data file found. ' +
          'Add <code>data/schools.csv</code>.</li>';
        status('Could not load ' + CONFIG.DATA_SOURCES.join(' or ') + ' — ' + err.message, 0);
      });
  }

  function hydrateFromHash() {
    var h = readHash();
    state.hydrating = true;
    if (h.estimate && !state.hasMunicipalityData) {
      el.estimateToggle.checked = true;
      applyEstimate(true);
    }
    state.municipality = h.municipality || '';
    state.post = h.post || '';
    state.query = (h.query || '').toLowerCase();
    state.levels = h.levels || null;
    el.search.value = h.query || '';
    state.hydrating = false;
    apply();
  }

  function applyEstimate(on) {
    state.estimateOn = on;
    if (on) {
      Data.estimateMunicipalities(state.schools);
      state.hasMunicipalityData = state.schools.some(function (s) { return s.municipality; });
    } else {
      state.schools.forEach(function (s) {
        if (s.estimated) { s.municipality = ''; s.estimated = false; }
      });
      state.hasMunicipalityData = state.schools.some(function (s) { return s.municipality; });
      state.municipality = '';
    }
    updateGeoNote({ missing: [], dropped: [], schools: state.schools });
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
      state.query = '';
      el.search.value = '';
      apply();
    });

    el.results.addEventListener('click', function (e) {
      var btn = e.target.closest('.result');
      if (!btn) return;
      setActive(btn.dataset.id, true);
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

    el.estimateToggle.addEventListener('change', function () {
      applyEstimate(this.checked);
      apply();
    });

    el.themeToggle.addEventListener('click', function () {
      var order = ['auto', 'light', 'dark'];
      var current = localStorage.getItem('tl-school-map-theme') || 'auto';
      applyTheme(order[(order.indexOf(current) + 1) % order.length]);
    });

    el.panelToggle.addEventListener('click', function () {
      var open = el.sidebar.classList.toggle('open');
      this.setAttribute('aria-expanded', String(open));
    });

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncBasemapToTheme);

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
      themeToggle: $('theme-toggle'),
      themeLabel: $('theme-label'),
      search: $('search'),
      filterMunicipality: $('filter-municipality'),
      filterPost: $('filter-post'),
      filterLevels: $('filter-levels'),
      clearFilters: $('clear-filters'),
      legend: $('legend'),
      results: $('results'),
      resultsMore: $('results-more'),
      exportCsv: $('export-csv'),
      geoNote: $('geo-note'),
      estimateRow: $('estimate-row'),
      estimateToggle: $('estimate-toggle'),
      statShown: $('stat-shown'),
      statTotal: $('stat-total'),
      statMunis: $('stat-munis'),
      statPosts: $('stat-posts'),
      mapStatus: $('map-status')
    };

    var saved = 'auto';
    try { saved = localStorage.getItem('tl-school-map-theme') || 'auto'; } catch (e) { /* private mode */ }
    document.documentElement.setAttribute('data-theme', saved);
    el.themeLabel.textContent = saved.charAt(0).toUpperCase() + saved.slice(1);

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
