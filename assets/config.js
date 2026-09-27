/* Configuration: column detection, education-level grouping, palette, geography.
   Loaded before data.js and app.js. Everything here is data, not behaviour. */
(function (global) {
  'use strict';

  /* ---------------------------------------------------------------- columns */
  /* Header names are matched case-insensitively after stripping everything
     that is not a letter or digit, so "School Name", "school_name" and
     "SCHOOL-NAME" all collapse to "schoolname". Portuguese and Tetum headers
     are included because most Timor-Leste school exports use them. */
  var COLUMN_ALIASES = {
    id: ['schoolid', 'school_id', 'id', 'code', 'schoolcode', 'codigo', 'codigoescola', 'emiscode', 'emisid'],
    name: ['schoolname', 'school', 'name', 'nome', 'nomeescola', 'escola', 'eskola', 'naranescola'],
    level: ['educationlevel', 'level', 'schoollevel', 'nivel', 'nivelensino', 'niveleducacao', 'grade', 'type', 'schooltype', 'tipo'],
    lat: ['latitude', 'lat', 'ycoord', 'y', 'gpslatitude', 'coordy'],
    lon: ['longitude', 'lon', 'lng', 'long', 'xcoord', 'x', 'gpslongitude', 'coordx'],
    municipality: ['municipality', 'municipio', 'municipiu', 'district', 'distrito', 'adm1', 'admin1', 'region'],
    post: ['administrativepost', 'adminpost', 'administrative_post', 'postoadministrativo', 'postuadministrativu', 'posto', 'subdistrict', 'subdistrito', 'adm2', 'admin2'],
    suco: ['suco', 'suku', 'village', 'aldeia', 'adm3', 'admin3'],
    ownership: ['ownership', 'management', 'sector', 'publicprivate', 'tipoescola', 'propriedade'],
    students: ['students', 'enrolment', 'enrollment', 'totalstudents', 'numstudents', 'alunos', 'estudantes'],
    teachers: ['teachers', 'totalteachers', 'numteachers', 'professores', 'docentes']
  };

  /* -------------------------------------------------------- education level */
  /* Education level is ORDINAL (a ladder), not categorical, so colour is an
     ordered single-hue ramp rather than eight unrelated hues. Raw values from
     the CSV are always preserved for filtering, search and export; the group
     below only decides which ramp step a marker is painted with, capped at
     five steps because that is the most the blue ramp fits on the dark surface
     while keeping every adjacent step visibly apart. Identity never rests on
     colour alone: each marker also carries the group's letter. */
  /* `order` is the rung on the ladder (display, legend, ramp step); `match` is
     the order the regexes are tried. They differ on purpose: "Secondary
     Technical-Vocational" contains "secondary", so the technical test has to
     run before the general one or every technical school lands in "general". */
  var LEVEL_GROUPS = [
    {
      key: 'pre', label: 'Pre-school', glyph: 'P', match: 1,
      test: /pre.?school|pre.?escolar|preescolar|kinder|jardim|infant|creche|early.?child/i
    },
    {
      key: 'basic', label: 'Basic education', glyph: 'B', match: 2,
      test: /basic|basico|b[aá]siku|ensino.?b|primary|prim[aá]ri|elementar|eb[123]?\b|ciclo|pre.?secondary/i
    },
    {
      key: 'sec-gen', label: 'Secondary — general', glyph: 'S', match: 4,
      test: /secondar|secund[aá]ri|\besg\b|geral|general|high.?school/i
    },
    {
      key: 'sec-tec', label: 'Secondary — technical / vocational', glyph: 'T', match: 3,
      test: /technic|t[eé]cnic|vocational|vocacional|\bestv\b|\betv\b|professional|profissional|polytech/i
    },
    {
      key: 'higher', label: 'Higher education', glyph: 'H', match: 0,
      test: /higher|superior|universit|universidad|tertiary|college|institut[eo]|faculdad|academ/i
    }
  ];
  /* Same objects, ordered for matching rather than for display. */
  var LEVEL_MATCH_ORDER = LEVEL_GROUPS.slice().sort(function (a, b) { return a.match - b.match; });
  var LEVEL_OTHER = { key: 'other', label: 'Other / unclassified', glyph: '·' };

  /* Ordinal ramp, one hue, pale -> deep. Validated against the dark panel
     the markers render on: monotone lightness, every adjacent gap
     >= 0.06 OKLCH L, pale end clears 2:1 contrast. */
  var RAMP = {
    steps: ['#cde2fb', '#9ec5f4', '#5598e7', '#2a78d6', '#184f95'],
    other: '#898781'
  };
  /* Ink for the glyph drawn on top of each ramp step. */
  var RAMP_INK = {
    steps: ['#0b0b0b', '#0b0b0b', '#0b0b0b', '#ffffff', '#ffffff'],
    other: '#ffffff'
  };

  /* ------------------------------------------------------------- geography */
  var TL_CENTER = [-8.83, 125.9];
  var TL_BOUNDS = [[-9.55, 123.9], [-8.05, 127.45]];

  /* The 13 municipalities plus the special administrative region. Coordinates
     are rough centres used by the built-in "estimate from coordinates"
     fallback, which runs automatically when the CSV carries no municipality
     column and no boundary file is supplied. Nearest-centre assignment is
     approximate near municipal borders, so estimated values are labelled. */
  var MUNICIPALITIES = [
    { name: 'Aileu', center: [-8.73, 125.57] },
    { name: 'Ainaro', center: [-8.99, 125.51] },
    { name: 'Ataúro', center: [-8.23, 125.60] },
    { name: 'Baucau', center: [-8.55, 126.42] },
    { name: 'Bobonaro', center: [-8.95, 125.25] },
    { name: 'Covalima', center: [-9.27, 125.32] },
    { name: 'Dili', center: [-8.56, 125.58] },
    { name: 'Ermera', center: [-8.79, 125.40] },
    { name: 'Lautem', center: [-8.52, 126.95] },
    { name: 'Liquica', center: [-8.65, 125.24] },
    { name: 'Manatuto', center: [-8.75, 126.02] },
    { name: 'Manufahi', center: [-9.00, 125.72] },
    { name: 'Viqueque', center: [-8.80, 126.40] },
    { name: 'RAEOA (Oe-Cusse Ambeno)', center: [-9.22, 124.36] }
  ];

  /* Basemaps: all free to use without an API key, which is what makes this
     deployable to GitHub Pages as a plain static site. */
  var BASEMAPS = [
    {
      name: 'OpenStreetMap',
      url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      options: { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }
    },
    {
      name: 'Satellite',
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      options: { maxZoom: 19, attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics' }
    }
  ];

  /* The dataset. Single source — there is no sample fallback. */
  var DATA_SOURCES = ['data/schools.csv'];
  /* Optional boundary files. Present -> exact point-in-polygon assignment. */
  var BOUNDARY_SOURCES = {
    municipality: 'data/boundaries/municipalities.geojson',
    post: 'data/boundaries/administrative-posts.geojson'
  };
  /* Property names searched inside those GeoJSON files for the area label. */
  var BOUNDARY_NAME_KEYS = ['shapeName', 'name', 'NAME', 'Name', 'ADM1_EN', 'ADM2_EN', 'admin1Name', 'admin2Name', 'MUNICIPIO', 'municipality', 'post'];

  global.CONFIG = {
    COLUMN_ALIASES: COLUMN_ALIASES,
    LEVEL_GROUPS: LEVEL_GROUPS,
    LEVEL_MATCH_ORDER: LEVEL_MATCH_ORDER,
    LEVEL_OTHER: LEVEL_OTHER,
    RAMP: RAMP,
    RAMP_INK: RAMP_INK,
    TL_CENTER: TL_CENTER,
    TL_BOUNDS: TL_BOUNDS,
    MUNICIPALITIES: MUNICIPALITIES,
    BASEMAPS: BASEMAPS,
    DATA_SOURCES: DATA_SOURCES,
    BOUNDARY_SOURCES: BOUNDARY_SOURCES,
    BOUNDARY_NAME_KEYS: BOUNDARY_NAME_KEYS
  };
})(window);
