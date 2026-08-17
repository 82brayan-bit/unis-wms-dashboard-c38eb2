// ═══ OFFICIAL GIS WAREHOUSE MAP — lazy chunk, loaded only on the GIS route ═══
// Renders the surveyed warehouse geometry from the official GIS service
// (gis.item.com) through the read-only /api/proxy/gis/ allow list, matching
// the official gis.item.com/gis/warehouse map experience: full fitted
// geometry, layer toggles, hover/click details, zoom/pan/fit and
// dark/light surfaces. Records without real latlng coordinates are never
// placed synthetically; when official geometry is unavailable the dashboard
// keeps the WMS aisle/bay topology schematic as an explicit fallback.
(function () {
  'use strict';

  // ────────────────────────── Pure helpers (DOM-free) ──────────────────────────

  // Layer palette copied from the official production GIS app (layer list order,
  // fill/stroke colors and opacities as rendered on gis.item.com/gis/warehouse).
  var LAYER_DEFS = Object.freeze({
    zone: { key: 'zone', label: 'Zone', fill: '#AAAAAA', stroke: '#AAAAAA', fillOpacity: 0.3, strokeWeight: 2, zIndex: 2 },
    rack: { key: 'rack', label: 'Rack', fill: '#87CEEB', stroke: '#795046', fillOpacity: 0.7, strokeWeight: 1, zIndex: 3 },
    bulk: { key: 'bulk', label: 'Bulk', fill: '#F0E68C', stroke: '#795046', fillOpacity: 0.7, strokeWeight: 1, zIndex: 4 },
    dock: { key: 'dock', label: 'Dock', fill: '#93FBBF', stroke: '#69D46E', fillOpacity: 0.7, strokeWeight: 2, zIndex: 5 },
  });
  var AISLE_STYLE = Object.freeze({ label: 'Aisles & roads', stroke: '#1E40AF', strokeWeight: 4, strokeOpacity: 0.8, zIndex: 1000 });
  var GRID_CELL_FEET = 3; // official cell grid step (turf squareGrid, "feet")

  function normalizeKey(value) {
    return String(value == null ? '' : value).toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  // Official GeoJSON conversion: keep only records with a real latlng geometry,
  // spread the remaining fields into properties and label by layer type.
  function gisToGeoJSON(list, layerType) {
    var features = [];
    var records = Array.isArray(list) ? list : [];
    for (var i = 0; i < records.length; i++) {
      var record = records[i];
      if (!record || !record.latlng) continue;
      var geometry = record.latlng;
      if (!geometry || !geometry.type || !geometry.coordinates) continue;
      var properties = {};
      var keys = Object.keys(record);
      for (var k = 0; k < keys.length; k++) {
        if (keys[k] === 'latlng') continue;
        properties[keys[k]] = record[keys[k]];
      }
      properties.id = record.id;
      properties.name = record.name || (layerType + '_' + record.id);
      properties.layerType = layerType;
      features.push({ type: 'Feature', geometry: geometry, properties: properties });
    }
    return features;
  }

  // Dynamic facility → official warehouse resolution. Tries, in order:
  // 1. explicit warehouse id fields on facility-search candidates,
  // 2. warehouse records whose facilityId matches the dashboard facility id,
  // 3. name matches (facility name vs warehouse name / candidate name).
  // Returns {warehouseId, warehouse, source, matchedOn} or null.
  function gisResolveWarehouse(facilityId, facilityName, facilityCandidates, warehouses) {
    var facilityKey = normalizeKey(facilityId);
    var facilityNameKey = normalizeKey(facilityName);
    var idFields = ['warehouseId', 'warehouse_ids', 'warehouseIds'];
    var matchFields = ['facilityId', 'facility_id', 'facilityCode', 'code', 'id', 'facility', 'name', 'warehouseName', 'warehouse'];
    function candidateValue(item, field) {
      var value = item[field];
      return value == null ? '' : String(value);
    }
    // 1) Facility-search candidates that reference the dashboard facility.
    var candidates = Array.isArray(facilityCandidates) ? facilityCandidates : [];
    for (var i = 0; i < candidates.length; i++) {
      var candidate = candidates[i];
      var sameFacility = false;
      for (var f = 0; f < matchFields.length; f++) {
        if (normalizeKey(candidateValue(candidate, matchFields[f])) === facilityKey) { sameFacility = true; break; }
      }
      if (!sameFacility && facilityNameKey && normalizeKey(candidateValue(candidate, 'name')) === facilityNameKey) sameFacility = true;
      if (!sameFacility) continue;
      for (var w = 0; w < idFields.length; w++) {
        var warehouseId = candidateValue(candidate, idFields[w]);
        if (/^\d+$/.test(warehouseId)) return { warehouseId: Number(warehouseId), warehouse: null, source: 'facility-search', matchedOn: idFields[w] };
      }
      // Some search payloads nest the warehouse object itself.
      var nested = candidate.warehouse || candidate.warehouseInfo;
      if (nested && /^\d+$/.test(candidateValue(nested, 'id'))) {
        return { warehouseId: Number(nested.id), warehouse: nested, source: 'facility-search', matchedOn: 'warehouse.id' };
      }
    }
    // 2) Warehouse list by facilityId (exact normalized identity only — never
    //    inferred mappings between facility id shapes).
    var list = Array.isArray(warehouses) ? warehouses : [];
    for (var j = 0; j < list.length; j++) {
      var warehouse = list[j];
      var facility = normalizeKey(candidateValue(warehouse, 'facilityId') || candidateValue(warehouse, 'facility_code'));
      if (facility && facility === facilityKey) {
        return { warehouseId: Number(warehouse.id), warehouse: warehouse, source: 'warehouse.facilityId', matchedOn: 'facilityId' };
      }
    }
    // 3) Name match against warehouse names.
    if (facilityNameKey) {
      for (var m = 0; m < list.length; m++) {
        var named = list[m];
        if (normalizeKey(named.name) === facilityNameKey || normalizeKey(named.warehouseName) === facilityNameKey) {
          return { warehouseId: Number(named.id), warehouse: named, source: 'warehouse.name', matchedOn: 'name' };
        }
      }
    }
    return null;
  }

  // Official pagination: page 1 via GET, remaining pages via POST {currentPage}.
  function gisPlanPagination(totalCount, pageSize) {
    return Math.max(1, Math.ceil((Number(totalCount) || 0) / Math.max(1, pageSize)));
  }

  function gisCountFeatures(features) {
    return Array.isArray(features) ? features.length : 0;
  }

  function gisAuthoritativeStats(warehouse) {
    if (!warehouse || !warehouse.stats || typeof warehouse.stats !== 'object') return null;
    var stats = warehouse.stats;
    return {
      zone: Number(stats.zone) || 0,
      rack: Number(stats.rack) || 0,
      bulk: Number(stats.bulk) || 0,
      dock: Number(stats.dock) || 0,
      route: Number(stats.route) || 0,
      camera: Number(stats.camera) || 0,
    };
  }

  // Collect every distinct planar name across the loaded layers (bounded).
  function gisPlanarNames(layers) {
    var names = [];
    var seen = {};
    var layerKeys = ['rack', 'bulk', 'zone', 'dock'];
    for (var l = 0; l < layerKeys.length; l++) {
      var features = layers[layerKeys[l]] || [];
      for (var i = 0; i < features.length; i++) {
        var name = features[i].properties && features[i].properties.name;
        if (!name || seen[name]) continue;
        seen[name] = true;
        names.push(name);
      }
    }
    return names;
  }

  // Tolerant parse of the customers-by-planars response. Accepts an array of
  // {planarName/name, customerId/customerName/id} rows or a {planarName: customer} map.
  function gisParseCustomerPlanars(payload) {
    var map = new Map();
    var data = payload && payload.data !== undefined ? payload.data : payload;
    if (Array.isArray(data)) {
      for (var i = 0; i < data.length; i++) {
        var row = data[i];
        if (!row || typeof row !== 'object') continue;
        var planar = row.planarName || row.planar || row.name || row.location;
        if (!planar) continue;
        var customerId = row.customerId != null ? String(row.customerId) : (row.customer != null ? String(row.customer) : '');
        var customerName = row.customerName || row.customer || customerId;
        if (!customerId) continue;
        map.set(String(planar), { id: customerId, name: String(customerName || customerId) });
      }
    } else if (data && typeof data === 'object') {
      var keys = Object.keys(data);
      for (var k = 0; k < keys.length; k++) {
        var value = data[keys[k]];
        var row = value && typeof value === 'object' ? value : { customerName: value };
        var id = row.customerId != null ? String(row.customerId) : (row.id != null ? String(row.id) : String(value));
        map.set(keys[k], { id: id, name: String(row.customerName || row.name || id) });
      }
    }
    return map;
  }

  // ─────────────────────────── IO (read-only via proxy) ───────────────────────────

  function apiFetch(pathAndQuery, options) {
    return fetch('/api/proxy/gis' + pathAndQuery, options).then(function (response) {
      return response.json().catch(function () { return null; });
    });
  }

  // Loads the facility/warehouse mapping lists and resolves the warehouse id.
  function loadWarehouseInfo(facilityId, facilityName) {
    var facilitySearchPromise = apiFetch('/gis-bam/facility-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: '{}',
    }).then(function (json) {
      var data = json && json.data !== undefined ? json.data : json;
      if (Array.isArray(data)) return data;
      if (data && Array.isArray(data.list)) return data.list;
      if (data && Array.isArray(data.records)) return data.records;
      return [];
    }).catch(function () { return []; });

    var warehouseListPromise = apiFetch('/gis-app/warehouse').then(function (json) {
      var data = json && json.data !== undefined ? json.data : json;
      if (Array.isArray(data)) return data;
      if (data && Array.isArray(data.list)) return data.list;
      return [];
    }).catch(function () { return []; });

    return Promise.all([facilitySearchPromise, warehouseListPromise]).then(function (results) {
      var resolved = gisResolveWarehouse(facilityId, facilityName, results[0], results[1]);
      // When the facility-search candidate resolves an id but the warehouse
      // list holds the full record, attach it so authoritative stats are real.
      if (resolved && !resolved.warehouse) {
        var warehouseList = Array.isArray(results[1]) ? results[1] : [];
        for (var i = 0; i < warehouseList.length; i++) {
          if (String(warehouseList[i].id) === String(resolved.warehouseId)) {
            resolved.warehouse = warehouseList[i];
            break;
          }
        }
      }
      return { resolved: resolved, warehouses: results[1] };
    });
  }

  // Loads one planar layer type with the official pagination contract:
  // GET page 1, then POST {currentPage} for the remaining pages (5 at a time).
  function loadPlanarLayer(warehouseId, type, onProgress) {
    var base = '/gis-bam/planar-model/facility-type-data?warehouseId=' + warehouseId + '&type=' + type.toUpperCase();
    return apiFetch(base).then(function (page1) {
      var data = page1 && page1.data !== undefined ? page1.data : page1;
      if (!data || typeof data !== 'object') return { type: type, records: [], totalCount: 0, totalPage: 1 };
      if (Array.isArray(data)) return { type: type, records: data, totalCount: data.length, totalPage: 1 };
      if (!Array.isArray(data.list)) {
        // Single-object response (e.g. a zone) → wrap it.
        return { type: type, records: [data], totalCount: 1, totalPage: 1 };
      }
      var pageSize = Math.max(1, data.list.length || 1);
      var declaredTotal = Number(data.totalCount) || Number(data.total) || 0;
      var totalPage = gisPlanPagination(declaredTotal || data.list.length, pageSize);
      var merged = (data.list || []).slice();
      var remaining = Math.max(0, totalPage - 1);
      if (remaining === 0) {
        return { type: type, records: merged, totalCount: declaredTotal || merged.length, totalPage: totalPage };
      }
      var batches = [];
      for (var start = 0; start < remaining; start += 5) {
        batches.push(Array.from({ length: Math.min(5, remaining - start) }, function (_, index) {
          return start + index + 2;
        }));
      }
      return batches.reduce(function (chain, batch) {
        return chain.then(function () {
          return Promise.all(batch.map(function (pageNumber) {
            if (onProgress) onProgress(type, pageNumber, totalPage);
            return apiFetch(base, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
              body: JSON.stringify({ currentPage: pageNumber }),
            }).then(function (json) {
              var pageData = json && json.data !== undefined ? json.data : json;
              if (!pageData || !Array.isArray(pageData.list)) return [];
              return pageData.list;
            }).catch(function () { return []; });
          })).then(function (pageResults) {
            pageResults.forEach(function (records) { merged.push.apply(merged, records); });
          });
        });
      }, Promise.resolve()).then(function () {
        return { type: type, records: merged, totalCount: declaredTotal || merged.length, totalPage: totalPage };
      });
    }).catch(function () {
      return { type: type, records: [], totalCount: 0, totalPage: 1 };
    });
  }

  function loadAisles(warehouseId) {
    return apiFetch('/gis-app/warehouse-aisles/warehouse/' + warehouseId).then(function (json) {
      var data = json && json.data !== undefined ? json.data : json;
      if (Array.isArray(data)) return data;
      if (data && Array.isArray(data.list)) return data.list;
      return [];
    }).catch(function () { return []; });
  }

  // ─────────────────────────── Projection + spatial index ───────────────────────────

  var METERS_PER_DEG_LAT = 110540;
  var METERS_PER_DEG_LNG = 111320;

  function makeProjection(centerLng, centerLat) {
    var lngScale = METERS_PER_DEG_LNG * Math.cos((centerLat * Math.PI) / 180);
    return {
      x: function (lng) { return (lng - centerLng) * lngScale; },
      y: function (lat) { return (lat - centerLat) * METERS_PER_DEG_LAT; },
    };
  }

  // Project every feature into local meters once per load.
  function projectFeatures(features, project) {
    var projected = [];
    for (var i = 0; i < features.length; i++) {
      var feature = features[i];
      var geometry = feature.geometry;
      if (!geometry || !geometry.coordinates) continue;
      var groups = null;
      if (geometry.type === 'Polygon') groups = geometry.coordinates;
      else if (geometry.type === 'MultiPolygon') groups = geometry.coordinates[0] || null;
      else if (geometry.type === 'LineString') groups = [geometry.coordinates];
      if (!groups) continue;
      var rings = [];
      for (var r = 0; r < groups.length; r++) {
        var ring = [];
        var points = groups[r];
        if (!Array.isArray(points)) continue;
        for (var p = 0; p < points.length; p++) {
          var pair = points[p];
          if (!Array.isArray(pair) || pair.length < 2) continue;
          ring.push([project.x(pair[0]), project.y(pair[1])]);
        }
        if (ring.length >= 3 || geometry.type === 'LineString') rings.push(ring);
      }
      if (!rings.length) continue;
      var bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      for (var rr = 0; rr < rings.length; rr++) {
        var ringPoints = rings[rr];
        for (var q = 0; q < ringPoints.length; q++) {
          if (ringPoints[q][0] < bounds.minX) bounds.minX = ringPoints[q][0];
          if (ringPoints[q][1] < bounds.minY) bounds.minY = ringPoints[q][1];
          if (ringPoints[q][0] > bounds.maxX) bounds.maxX = ringPoints[q][0];
          if (ringPoints[q][1] > bounds.maxY) bounds.maxY = ringPoints[q][1];
        }
      }
      projected.push({ feature: feature, rings: rings, kind: geometry.type, bounds: bounds });
    }
    return projected;
  }

  // Uniform grid index for fast hover/click hit testing.
  function buildSpatialIndex(projected, cellSize) {
    var index = new Map();
    function cellKey(cx, cy) { return Math.floor(cx / cellSize) + ':' + Math.floor(cy / cellSize); }
    for (var i = 0; i < projected.length; i++) {
      var entry = projected[i];
      var bounds = entry.bounds;
      var minCellX = Math.floor(bounds.minX / cellSize), maxCellX = Math.floor(bounds.maxX / cellSize);
      var minCellY = Math.floor(bounds.minY / cellSize), maxCellY = Math.floor(bounds.maxY / cellSize);
      for (var cx = minCellX; cx <= maxCellX; cx++) {
        for (var cy = minCellY; cy <= maxCellY; cy++) {
          var key = cx + ':' + cy;
          if (!index.has(key)) index.set(key, []);
          index.get(key).push(i);
        }
      }
    }
    return { index: index, cellSize: cellSize, cellKey: cellKey, projected: projected };
  }

  function pointInRing(x, y, ring) {
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var xi = ring[i][0], yi = ring[i][1];
      var xj = ring[j][0], yj = ring[j][1];
      var intersect = ((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function hitTest(index, worldX, worldY, filter) {
    var key = index.cellKey(worldX, worldY);
    var candidates = index.index.get(key) || [];
    for (var i = candidates.length - 1; i >= 0; i--) {
      var entry = index.projected[candidates[i]];
      var bounds = entry.bounds;
      if (worldX < bounds.minX || worldX > bounds.maxX || worldY < bounds.minY || worldY > bounds.maxY) continue;
      if (filter && !filter(entry.feature)) continue;
      for (var r = 0; r < entry.rings.length; r++) {
        if (pointInRing(worldX, worldY, entry.rings[r])) return entry;
      }
    }
    return null;
  }

  // Square cell grid over the warehouse outline (official: 3 ft cells).
  function buildCellGrid(outlineRings, cellFeet) {
    if (!outlineRings || !outlineRings.length) return [];
    var cellMeters = cellFeet * 0.3048;
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    outlineRings.forEach(function (ring) {
      ring.forEach(function (point) {
        if (point[0] < minX) minX = point[0];
        if (point[1] < minY) minY = point[1];
        if (point[0] > maxX) maxX = point[0];
        if (point[1] > maxY) maxY = point[1];
      });
    });
    var lines = [];
    for (var gx = Math.floor(minX / cellMeters) * cellMeters; gx <= maxX; gx += cellMeters) {
      lines.push([{ x: gx, y: minY }, { x: gx, y: maxY }]);
    }
    for (var gy = Math.floor(minY / cellMeters) * cellMeters; gy <= maxY; gy += cellMeters) {
      lines.push([{ x: minX, y: gy }, { x: maxX, y: gy }]);
    }
    return lines;
  }

  // ─────────────────────────── Renderer state ───────────────────────────

  var state = {
    ready: false,
    active: false,
    facilityId: '',
    facilityName: '',
    warehouse: null,
    warehouseId: 0,
    layers: { zone: [], rack: [], bulk: [], dock: [] },
    aisles: [],
    counts: { zone: 0, rack: 0, bulk: 0, dock: 0, aisles: 0 },
    authoritative: null,
    customers: new Map(),
    customerNames: new Map(),
    customerUnavailable: false,
    projected: [],
    aisleProjected: [],
    layerProjected: {},
    outlineProjected: null,
    spatial: null,
    gridLines: [],
    visible: { zone: true, rack: true, bulk: true, dock: true, aisles: true, grid: false },
    selectedFeature: null,
    hoveredFeature: null,
    fit: null,
    transform: { scale: 1, x: 0, y: 0 },
    requestToken: 0,
    canvas: null,
    mapViewport: null,
    pixelRatio: 1,
    renderFrame: 0,
    interactionsBound: false,
    resizeBound: false,
    theme: 'light',
    customerFilterActive: false,
    searchFilterActive: false,
    occupancyFilterActive: false,
    typeFilterActive: false,
    activeCustomerId: '',
    activeQuery: '',
    activeOccupancy: '',
    activeType: '',
  };

  function layerOrder() { return ['zone', 'rack', 'bulk', 'dock']; }

  function isOfficialGeometryPresent(loaded) {
    return (loaded.counts.rack + loaded.counts.bulk + loaded.counts.zone + loaded.counts.dock) > 0;
  }

  function projectWarehouseOutline(warehouse, project) {
    if (!warehouse || !warehouse.latlng || warehouse.latlng.type !== 'Polygon') return null;
    var coordinates = warehouse.latlng.coordinates;
    if (!Array.isArray(coordinates) || !coordinates.length) return null;
    var ring = [];
    var points = coordinates[0];
    for (var i = 0; i < points.length; i++) {
      var pair = points[i];
      if (!Array.isArray(pair) || pair.length < 2) continue;
      ring.push([project.x(pair[0]), project.y(pair[1])]);
    }
    if (ring.length < 3) return null;
    return { rings: [ring], bounds: { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity } };
  }

  function extendBounds(target, bounds) {
    if (!bounds) return;
    if (bounds.minX < target.minX) target.minX = bounds.minX;
    if (bounds.minY < target.minY) target.minY = bounds.minY;
    if (bounds.maxX > target.maxX) target.maxX = bounds.maxX;
    if (bounds.maxY > target.maxY) target.maxY = bounds.maxY;
  }

  function computeBounds(projected, aisles, outlineProjected) {
    var bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    (projected || []).forEach(function (entry) { extendBounds(bounds, entry.bounds); });
    (aisles || []).forEach(function (entry) { extendBounds(bounds, entry.bounds); });
    if (outlineProjected) extendBounds(bounds, outlineProjected.bounds);
    if (!isFinite(bounds.minX) || !isFinite(bounds.maxX)) return null;
    return bounds;
  }

  function fitMap() {
    if (!state.fit) return;
    var rect = state.mapViewport ? state.mapViewport.getBoundingClientRect() : null;
    if (!rect || !rect.width || !rect.height) return;
    var spanX = Math.max(1, state.fit.bounds.maxX - state.fit.bounds.minX);
    var spanY = Math.max(1, state.fit.bounds.maxY - state.fit.bounds.minY);
    state.fit.fitScale = Math.min((rect.width - 16) / spanX, (rect.height - 16) / spanY, 400);
    state.transform.scale = 1;
    state.transform.x = 0;
    state.transform.y = 0;
    queueRender();
  }

  function zoomBy(factor) {
    state.transform.scale = Math.max(0.25, Math.min(40, state.transform.scale * factor));
    queueRender();
  }

  function panBy(deltaX, deltaY) {
    state.transform.x += deltaX;
    state.transform.y += deltaY;
    queueRender();
  }

  // ─────────────────────────── Rendering ───────────────────────────

  function el(id) { return document.getElementById(id); }

  function setStatus(message) {
    var status = el('gis-status');
    if (status) status.textContent = message;
  }

  function rgba(hex, opacity) {
    var r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + opacity + ')';
  }

  function themeColors() {
    var dark = document.documentElement.classList.contains('dark');
    state.theme = dark ? 'dark' : 'light';
    return dark
      ? { surface: '#12161d', grid: 'rgba(255,255,255,0.09)', dim: 'rgba(0,0,0,0.55)', label: '#c7ccd6' }
      : { surface: '#e8eaed', grid: 'rgba(0,0,0,0.14)', dim: 'rgba(255,255,255,0.62)', label: '#3c4043' };
  }

  function resizeCanvas() {
    if (!state.canvas || !state.mapViewport) return;
    var rect = state.mapViewport.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    state.pixelRatio = Math.min(2, window.devicePixelRatio || 1);
    var width = Math.max(1, Math.round(rect.width));
    var height = Math.max(1, Math.round(rect.height));
    if (state.canvas.width !== Math.round(width * state.pixelRatio) || state.canvas.height !== Math.round(height * state.pixelRatio)) {
      state.canvas.width = Math.round(width * state.pixelRatio);
      state.canvas.height = Math.round(height * state.pixelRatio);
    }
  }

  function canvasGeometry() {
    if (!state.canvas || !state.mapViewport || !state.fit) return null;
    var rect = state.mapViewport.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    var scale = state.fit.fitScale * state.transform.scale;
    return {
      scale: scale,
      originX: state.fit.x + state.transform.x,
      originY: state.fit.y + state.transform.y,
      rect: rect,
    };
  }

  function draw() {
    if (!state.canvas || !state.active || !state.fit) return;
    var mapViewport = state.mapViewport;
    if (!mapViewport) return;
    var rect = mapViewport.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    var pixelRatio = state.pixelRatio;
    var width = state.canvas.width / pixelRatio;
    var height = state.canvas.height / pixelRatio;
    var context = state.canvas.getContext('2d');
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, width, height);
    var colors = themeColors();
    context.fillStyle = colors.surface;
    context.fillRect(0, 0, width, height);

    var fit = state.fit;
    var scale = fit.fitScale * state.transform.scale;
    var originX = fit.x + state.transform.x;
    var originY = fit.y + state.transform.y;
    var geometry = { scale: scale, originX: originX, originY: originY, width: width, height: height };
    var viewMinX = -originX / scale, viewMinY = -originY / scale;
    var viewMaxX = (width - originX) / scale, viewMaxY = (height - originY) / scale;

    context.save();
    context.translate(originX, originY);
    context.scale(scale, scale);

    // Aisle/road overlays first (beneath the planar fills, as in the official app).
    if (state.visible.aisles) {
      context.strokeStyle = AISLE_STYLE.stroke;
      context.globalAlpha = AISLE_STYLE.strokeOpacity;
      context.lineWidth = AISLE_STYLE.strokeWeight / scale;
      context.lineCap = 'round';
      var aisles = state.aisleProjected;
      for (var a = 0; a < aisles.length; a++) {
        var aisle = aisles[a];
        if (aisle.bounds.maxX < viewMinX || aisle.bounds.minX > viewMaxX || aisle.bounds.maxY < viewMinY || aisle.bounds.minY > viewMaxY) continue;
        var ring = aisle.rings[0];
        if (!ring || ring.length < 2) continue;
        context.beginPath();
        context.moveTo(ring[0][0], ring[0][1]);
        for (var p = 1; p < ring.length; p++) context.lineTo(ring[p][0], ring[p][1]);
        context.stroke();
      }
      context.globalAlpha = 1;
      context.lineCap = 'butt';
    }

    var filtersActive = state.customerFilterActive || state.searchFilterActive || state.occupancyFilterActive || state.typeFilterActive;
    var dimmedColor = colors.dim;
    var layerKeys = layerOrder();
    for (var li = 0; li < layerKeys.length; li++) {
      var layerKey = layerKeys[li];
      if (!state.visible[layerKey]) continue;
      var def = LAYER_DEFS[layerKey];
      context.fillStyle = rgba(def.fill, def.fillOpacity);
      context.strokeStyle = rgba(def.stroke, 1);
      context.lineWidth = def.strokeWeight / scale;
      var layerFeatures = state.layerProjected[layerKey] || [];
      for (var i = 0; i < layerFeatures.length; i++) {
        var entry = layerFeatures[i];
        var bounds = entry.bounds;
        if (bounds.maxX < viewMinX || bounds.minX > viewMaxX || bounds.maxY < viewMinY || bounds.minY > viewMaxY) continue;
        if (filtersActive && entry.dimmed) {
          if (entry.dimmedColorDrawn) continue;
          context.fillStyle = dimmedColor;
          context.strokeStyle = 'rgba(128,128,128,0.4)';
          context.lineWidth = Math.max(0.5, def.strokeWeight / scale);
          entry.dimmedColorDrawn = true;
        } else {
          entry.dimmedColorDrawn = false;
          context.fillStyle = rgba(def.fill, def.fillOpacity);
          context.strokeStyle = rgba(def.stroke, 1);
          context.lineWidth = def.strokeWeight / scale;
        }
        context.beginPath();
        for (var r = 0; r < entry.rings.length; r++) {
          var featureRing = entry.rings[r];
          if (!featureRing.length) continue;
          context.moveTo(featureRing[0][0], featureRing[0][1]);
          for (var q = 1; q < featureRing.length; q++) context.lineTo(featureRing[q][0], featureRing[q][1]);
          context.closePath();
        }
        context.fill();
        if (def.strokeWeight > 0 && scale > 0.9) context.stroke();
      }
    }

    // Optional cell grid (official: 3 ft squares over the warehouse outline).
    if (state.visible.grid && state.gridLines.length && scale >= 1.2) {
      context.strokeStyle = colors.grid;
      context.lineWidth = 1 / scale;
      context.beginPath();
      for (var g = 0; g < state.gridLines.length; g++) {
        var line = state.gridLines[g];
        context.moveTo(line[0].x, line[0].y);
        context.lineTo(line[1].x, line[1].y);
      }
      context.stroke();
    }

    // Selected feature outline.
    if (state.selectedFeature) {
      var sel = state.selectedFeature;
      if (sel.bounds.maxX >= viewMinX && sel.bounds.minX <= viewMaxX && sel.bounds.maxY >= viewMinY && sel.bounds.minY <= viewMaxY) {
        context.strokeStyle = colors.label;
        context.lineWidth = 3 / scale;
        context.beginPath();
        for (var sr = 0; sr < sel.rings.length; sr++) {
          var sring = sel.rings[sr];
          if (!sring.length) continue;
          context.moveTo(sring[0][0], sring[0][1]);
          for (var sp = 1; sp < sring.length; sp++) context.lineTo(sring[sp][0], sring[sp][1]);
          context.closePath();
        }
        context.stroke();
      }
    }
    context.restore();

    // Warehouse name label at readable zoom (as on the official map).
    if (state.warehouse && state.warehouse.name && scale >= 0.8) {
      var labelX = ((fit.bounds.maxX + fit.bounds.minX) / 2) * scale + originX;
      var labelY = fit.bounds.minY * scale + originY - 8;
      context.font = '700 13px Satoshi, sans-serif';
      context.textAlign = 'center';
      context.textBaseline = 'bottom';
      context.fillStyle = colors.label;
      if (state.theme === 'dark') {
        context.shadowColor = 'rgba(0,0,0,0.8)';
        context.shadowBlur = 4;
      }
      context.fillText(state.warehouse.name, labelX, labelY);
      context.shadowBlur = 0;
    }

    state.canvas.dataset.officialFeatureCount = String(state.projected.length);
    state.canvas.dataset.officialAisleCount = String(state.aisleProjected.length);
    state.canvas.dataset.geometrySource = 'official-gis';
    state.canvas.dataset.renderedTheme = state.theme;
    state.canvas.dataset.warehouseId = String(state.warehouseId);
    state.canvas.dataset.visibleLayers = layerKeys.filter(function (key) { return state.visible[key]; }).join(',');
  }

  function queueRender() {
    if (state.renderFrame) cancelAnimationFrame(state.renderFrame);
    state.renderFrame = requestAnimationFrame(function () {
      state.renderFrame = 0;
      draw();
    });
  }

  // Re-size and re-fit after the viewport becomes visible (the dashboard glue
  // shows the map viewport only after the geometry has finished loading).
  function refresh() {
    if (!state.active) return;
    resizeCanvas();
    fitMap();
    queueRender();
  }

  // ─────────────────────────── Hover / click / interactions ───────────────────────────

  function showTooltip(event, feature) {
    var tooltip = el('gis-map-tooltip');
    if (!tooltip) return;
    var props = feature.properties || {};
    var name = props.name;
    var layer = (LAYER_DEFS[props.layerType] || {}).label || '';
    tooltip.textContent = name ? String(name) + (layer ? ' · ' + layer : '') : 'Official GIS location';
    tooltip.hidden = false;
    var rect = state.mapViewport.getBoundingClientRect();
    tooltip.style.left = (event.clientX - rect.left + 12) + 'px';
    tooltip.style.top = (event.clientY - rect.top + 12) + 'px';
  }

  function hideTooltip() {
    var tooltip = el('gis-map-tooltip');
    if (tooltip) tooltip.hidden = true;
  }

  function featureAt(clientX, clientY) {
    var geometry = canvasGeometry();
    if (!geometry || !state.spatial) return null;
    var worldX = (clientX - geometry.rect.left - geometry.originX) / geometry.scale;
    var worldY = (clientY - geometry.rect.top - geometry.originY) / geometry.scale;
    return hitTest(state.spatial, worldX, worldY, function (feature) {
      return state.visible[feature.properties.layerType] === true;
    });
  }

  var boundInteractions = null;

  function bindMapInteractions() {
    if (!state.mapViewport || state.interactionsBound) return;
    var pointerId = null;
    var lastX = 0, lastY = 0;
    function onPointerDown(event) {
      if (event.button !== 0) return;
      pointerId = event.pointerId;
      lastX = event.clientX;
      lastY = event.clientY;
      if (state.mapViewport.setPointerCapture) state.mapViewport.setPointerCapture(event.pointerId);
    }
    function onPointerMove(event) {
      if (pointerId !== null) {
        panBy(event.clientX - lastX, event.clientY - lastY);
        lastX = event.clientX;
        lastY = event.clientY;
        return;
      }
      var entry = featureAt(event.clientX, event.clientY);
      if (entry !== state.hoveredFeature) {
        state.hoveredFeature = entry;
        if (entry) showTooltip(event, entry.feature);
        else hideTooltip();
        queueRender();
      }
    }
    function endDrag(event) {
      if (pointerId === null || event.pointerId !== pointerId) return;
      pointerId = null;
      if (state.mapViewport.releasePointerCapture) state.mapViewport.releasePointerCapture(event.pointerId);
    }
    function onClick(event) {
      var entry = featureAt(event.clientX, event.clientY);
      state.selectedFeature = entry;
      if (entry) selectFeature(entry.feature);
      else selectFeature(null);
      queueRender();
    }
    function onWheel(event) {
      event.preventDefault();
      zoomBy(event.deltaY < 0 ? 1.12 : 1 / 1.12);
    }
    function onDoubleClick() {
      fitMap();
    }
    var entries = [
      { type: 'pointerdown', fn: onPointerDown, opts: false },
      { type: 'pointermove', fn: onPointerMove, opts: false },
      { type: 'pointerup', fn: endDrag, opts: false },
      { type: 'pointercancel', fn: endDrag, opts: false },
      { type: 'click', fn: onClick, opts: false },
      { type: 'wheel', fn: onWheel, opts: { passive: false } },
      { type: 'dblclick', fn: onDoubleClick, opts: false },
    ];
    entries.forEach(function (entry) {
      state.mapViewport.addEventListener(entry.type, entry.fn, entry.opts);
    });
    boundInteractions = { element: state.mapViewport, entries: entries };
    state.interactionsBound = true;
  }

  function unbindMapInteractions() {
    if (!boundInteractions) return;
    boundInteractions.entries.forEach(function (entry) {
      boundInteractions.element.removeEventListener(entry.type, entry.fn, entry.opts || false);
    });
    boundInteractions = null;
    state.interactionsBound = false;
  }

  // ─────────────────────────── Feature detail ───────────────────────────

  function selectFeature(feature) {
    var detailContent = el('gis-detail-content');
    if (!detailContent) return;
    detailContent.innerHTML = '';
    if (!feature) {
      var empty = document.createElement('div');
      empty.className = 'gis-detail-empty';
      empty.textContent = 'Select a planar object on the map to inspect its official GIS details.';
      detailContent.appendChild(empty);
      return;
    }
    var props = feature.properties || {};
    var fields = [
      ['Planar', props.name],
      ['ID', props.id],
      ['Layer', (LAYER_DEFS[props.layerType] || {}).label || props.layerType],
    ];
    if (props.facilityType) fields.push(['Type', props.facilityType]);
    if (props.inventoryCount != null) fields.push(['Inventory count', props.inventoryCount]);
    if (props.customerId != null) fields.push(['Customer ID', props.customerId]);
    if (props.customerName != null) fields.push(['Customer', props.customerName]);
    if (props.warehouseId != null) fields.push(['Warehouse', props.warehouseId]);
    if (props.length != null) fields.push(['Length', props.length + (props.linearUnit ? ' ' + props.linearUnit : '')]);
    if (props.width != null) fields.push(['Width', props.width + (props.linearUnit ? ' ' + props.linearUnit : '')]);
    fields.forEach(function (pair) {
      var field = document.createElement('div');
      field.className = 'gis-detail-field';
      var key = document.createElement('span');
      key.textContent = pair[0];
      var data = document.createElement('strong');
      data.textContent = pair[1] == null || pair[1] === '' ? 'Not recorded' : String(pair[1]);
      field.append(key, data);
      detailContent.appendChild(field);
    });
  }

  // ─────────────────────────── Filters (official semantics) ───────────────────────────

  function rebuildFilterState() {
    var customerId = (el('gis-customer') || {}).value || '';
    var query = ((el('gis-search') || {}).value || '').trim().toLowerCase();
    var occupancy = (el('gis-occupancy') || {}).value || '';
    var type = (el('gis-type') || {}).value || '';
    state.customerFilterActive = !!customerId;
    state.searchFilterActive = !!query;
    state.occupancyFilterActive = !!occupancy;
    state.typeFilterActive = !!type;
    state.activeCustomerId = customerId;
    state.activeQuery = query;
    state.activeOccupancy = occupancy;
    state.activeType = type;
    var all = state.projected;
    for (var i = 0; i < all.length; i++) {
      var entry = all[i];
      var props = entry.feature.properties || {};
      var name = String(props.name || '');
      var match = true;
      if (customerId) {
        var mapping = state.customers.get(name);
        match = !!mapping && String(mapping.id) === customerId;
      }
      if (match && query && name.toLowerCase().indexOf(query) === -1) match = false;
      if (match && occupancy) {
        var count = Number(props.inventoryCount) || 0;
        if (occupancy === 'EMPTY') match = !(count > 0);
        else if (occupancy === 'OCCUPIED') match = count > 0;
        else match = false;
      }
      if (match && type) match = String(props.facilityType || '') === type;
      entry.dimmed = !match;
      entry.dimmedColorDrawn = false;
    }
  }

  // ─────────────────────────── Public API ───────────────────────────

  // Orchestrates the full official load for a facility and renders when real
  // geometry exists. Resolves to a status descriptor for the dashboard glue.
  function loadForFacility(facilityId, facilityName) {
    state.requestToken++;
    var token = state.requestToken;
    state.active = false;
    hideTooltip();
    setStatus('Loading official GIS layout for ' + facilityName + '…');
    return loadWarehouseInfo(facilityId, facilityName).then(function (info) {
      if (token !== state.requestToken) return { stale: true };
      if (!info.resolved) {
        state.active = false;
        return { status: 'unavailable', reason: 'no-warehouse', message: 'No official GIS warehouse matches facility ' + facilityId + '.' };
      }
      var resolved = info.resolved;
      state.facilityId = facilityId;
      state.facilityName = facilityName;
      state.warehouseId = resolved.warehouseId;
      state.warehouse = resolved.warehouse || null;
      state.authoritative = gisAuthoritativeStats(state.warehouse);
      setStatus('Official GIS warehouse found for ' + facilityName + ' (warehouse ' + resolved.warehouseId + '). Loading geometry…');

      var layers = { zone: [], rack: [], bulk: [], dock: [] };
      var counts = { zone: 0, rack: 0, bulk: 0, dock: 0, aisles: 0 };
      function loadOne(type) {
        return loadPlanarLayer(resolved.warehouseId, type, function (layerType, page, total) {
          if (token !== state.requestToken) return;
          setStatus('Loading official GIS ' + layerType + ' geometry… page ' + page + ' of ' + total);
        }).then(function (result) {
          if (token !== state.requestToken) return;
          var features = gisToGeoJSON(result.records, type);
          layers[type] = features;
          counts[type] = features.length;
        });
      }
      return Promise.all(['zone', 'rack', 'bulk', 'dock'].map(loadOne)).then(function () {
        return loadAisles(resolved.warehouseId);
      }).then(function (aisleRecords) {
        if (token !== state.requestToken) return { stale: true };
        var aisles = gisToGeoJSON(aisleRecords, 'warehouse-aisles');
        counts.aisles = aisles.length;
        state.layers = layers;
        state.aisles = aisles;
        state.counts = counts;
        if (!isOfficialGeometryPresent({ counts: counts })) {
          state.active = false;
          return { status: 'unavailable', reason: 'no-geometry', message: 'No surveyed planar geometry is available for warehouse ' + resolved.warehouseId + '.' };
        }
        finalizeAndRender();
        return {
          status: 'official',
          warehouseId: resolved.warehouseId,
          source: resolved.source,
          counts: counts,
          authoritative: state.authoritative,
        };
      });
    }).catch(function (error) {
      if (token !== state.requestToken) return { stale: true };
      state.active = false;
      return { status: 'unavailable', reason: 'error', message: error && error.message ? error.message : 'Official GIS service could not be reached.' };
    });
  }

  function finalizeAndRender() {
    var allFeatures = [];
    var layerKeys = layerOrder();
    for (var i = 0; i < layerKeys.length; i++) {
      var features = state.layers[layerKeys[i]];
      for (var f = 0; f < features.length; f++) allFeatures.push(features[f]);
    }
    // Center the projection on the loaded geometry (falls back to pointCenter).
    var lngBounds = null;
    function extend(coordinates) {
      for (var i = 0; i < coordinates.length; i++) {
        var pair = coordinates[i];
        if (!Array.isArray(pair) || pair.length < 2) continue;
        var lng = pair[0], lat = pair[1];
        if (!lngBounds) lngBounds = { minLng: lng, minLat: lat, maxLng: lng, maxLat: lat };
        else {
          if (lng < lngBounds.minLng) lngBounds.minLng = lng;
          if (lat < lngBounds.minLat) lngBounds.minLat = lat;
          if (lng > lngBounds.maxLng) lngBounds.maxLng = lng;
          if (lat > lngBounds.maxLat) lngBounds.maxLat = lat;
        }
      }
    }
    allFeatures.forEach(function (feature) {
      var geometry = feature.geometry;
      if (!geometry || !geometry.coordinates) return;
      if (geometry.type === 'Polygon') geometry.coordinates.forEach(extend);
      else if (geometry.type === 'LineString') extend(geometry.coordinates);
    });
    if (!lngBounds && state.warehouse && state.warehouse.pointCenter && state.warehouse.pointCenter.coordinates) {
      var center = state.warehouse.pointCenter.coordinates;
      lngBounds = { minLng: center[0], minLat: center[1], maxLng: center[0], maxLat: center[1] };
    }
    var centerLng = lngBounds ? (lngBounds.minLng + lngBounds.maxLng) / 2 : -118.24;
    var centerLat = lngBounds ? (lngBounds.minLat + lngBounds.maxLat) / 2 : 33.94;
    var project = makeProjection(centerLng, centerLat);

    state.projected = projectFeatures(allFeatures, project);
    state.aisleProjected = projectFeatures(state.aisles, project);
    state.outlineProjected = projectWarehouseOutline(state.warehouse, project);
    if (state.outlineProjected) {
      var ring = state.outlineProjected.rings[0];
      var outlineBounds = state.outlineProjected.bounds;
      for (var q = 0; q < ring.length; q++) {
        if (ring[q][0] < outlineBounds.minX) outlineBounds.minX = ring[q][0];
        if (ring[q][1] < outlineBounds.minY) outlineBounds.minY = ring[q][1];
        if (ring[q][0] > outlineBounds.maxX) outlineBounds.maxX = ring[q][0];
        if (ring[q][1] > outlineBounds.maxY) outlineBounds.maxY = ring[q][1];
      }
    }
    state.layerProjected = {};
    for (var l = 0; l < layerKeys.length; l++) {
      var key = layerKeys[l];
      state.layerProjected[key] = state.projected.filter(function (entry) {
        return entry.feature.properties.layerType === key;
      });
    }
    state.spatial = buildSpatialIndex(state.projected, 40);
    state.gridLines = buildCellGrid(state.outlineProjected ? state.outlineProjected.rings : null, GRID_CELL_FEET);
    state.selectedFeature = null;
    state.hoveredFeature = null;
    state.transform = { scale: 1, x: 0, y: 0 };
    var bounds = computeBounds(state.projected, state.aisleProjected, state.outlineProjected);
    state.fit = bounds ? { bounds: bounds, fitScale: 1, x: 0, y: 0 } : null;
    if (!state.fit) {
      state.active = false;
      return;
    }
    ensureCanvas();
    bindMapInteractions();
    // The dashboard hides the map viewport behind its loading state while the
    // official geometry is fetched. The canvas must be shown and measured
    // before the first draw (the schematic renderer does the same ordering).
    var loadingState = el('gis-map-state');
    var mapViewport = el('gis-map-viewport');
    if (loadingState) loadingState.hidden = true;
    if (mapViewport) mapViewport.hidden = false;
    resizeCanvas();
    fitMap();
    rebuildFilterState();
    syncLayerSwatches();
    state.active = true;
    draw();
  }

  // Official layer palette is applied at runtime (the dashboard's brand policy
  // keeps color literals out of HTML/CSS).
  function syncLayerSwatches() {
    var controls = el('gis-layer-controls');
    if (!controls) return;
    controls.querySelectorAll('[data-gis-swatch]').forEach(function (swatch) {
      var key = swatch.dataset.gisSwatch;
      if (key === 'aisles') swatch.style.backgroundColor = AISLE_STYLE.stroke;
      else if (LAYER_DEFS[key]) swatch.style.backgroundColor = LAYER_DEFS[key].fill;
    });
  }

  function ensureCanvas() {
    var viewport = el('gis-map-viewport');
    if (!viewport) return;
    var schematicCanvas = el('gis-map-canvas');
    if (schematicCanvas) schematicCanvas.hidden = true;
    if (!state.canvas || !state.canvas.parentNode) {
      if (state.canvas && state.canvas.parentNode) state.canvas.parentNode.removeChild(state.canvas);
      state.canvas = document.createElement('canvas');
      state.canvas.id = 'gis-official-canvas';
      state.canvas.className = 'gis-map-canvas gis-official-canvas';
      state.canvas.setAttribute('aria-hidden', 'true');
      viewport.appendChild(state.canvas);
    } else {
      state.canvas.hidden = false;
    }
    state.mapViewport = viewport;
    unbindMapInteractions();
    state.interactionsBound = false;
    if (!state.resizeBound) {
      state.resizeBound = true;
      window.addEventListener('resize', function () {
        if (!state.active) return;
        resizeCanvas();
        queueRender();
      });
    }
  }

  function removeCanvas() {
    state.active = false;
    unbindMapInteractions();
    if (state.canvas) {
      state.canvas.hidden = true;
      if (state.canvas.parentNode) state.canvas.parentNode.removeChild(state.canvas);
      state.canvas = null;
    }
    var schematicCanvas = el('gis-map-canvas');
    if (schematicCanvas) schematicCanvas.hidden = false;
    state.mapViewport = null;
    state.interactionsBound = false;
  }

  function setLayerVisible(layerKey, visible) {
    if (!(layerKey in state.visible)) return;
    state.visible[layerKey] = !!visible;
    queueRender();
  }

  function loadCustomerMapping(planarNames) {
    state.customerUnavailable = true;
    if (!planarNames || !planarNames.length) return Promise.resolve(false);
    var CHUNK = 500;
    var chunks = [];
    for (var start = 0; start < planarNames.length; start += CHUNK) chunks.push(planarNames.slice(start, start + CHUNK));
    return chunks.reduce(function (chain, chunk) {
      return chain.then(function () {
        return apiFetch('/gis-bam/location-inventory/customers-by-planars', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({ planarNames: chunk }),
        }).then(function (json) {
          if (!json) return;
          var parsed = gisParseCustomerPlanars(json);
          if (parsed.size) {
            parsed.forEach(function (mapping, planar) { state.customers.set(planar, mapping); });
          }
        }).catch(function () {});
      });
    }, Promise.resolve()).then(function () {
      var available = state.customers.size > 0;
      state.customerUnavailable = !available;
      if (available) {
        state.customerNames = new Map();
        state.customers.forEach(function (mapping) {
          if (!state.customerNames.has(mapping.id)) state.customerNames.set(mapping.id, mapping.name);
        });
      }
      return available;
    });
  }

  function reset() {
    state.requestToken++;
    state.active = false;
    state.layers = { zone: [], rack: [], bulk: [], dock: [] };
    state.aisles = [];
    state.counts = { zone: 0, rack: 0, bulk: 0, dock: 0, aisles: 0 };
    state.authoritative = null;
    state.customers = new Map();
    state.customerNames = new Map();
    state.customerUnavailable = false;
    state.projected = [];
    state.aisleProjected = [];
    state.layerProjected = {};
    state.outlineProjected = null;
    state.spatial = null;
    state.gridLines = [];
    state.selectedFeature = null;
    state.hoveredFeature = null;
    state.fit = null;
    removeCanvas();
  }

  window.GISOfficial = {
    pure: {
      normalizeKey: normalizeKey,
      gisToGeoJSON: gisToGeoJSON,
      gisResolveWarehouse: gisResolveWarehouse,
      gisPlanPagination: gisPlanPagination,
      gisCountFeatures: gisCountFeatures,
      gisAuthoritativeStats: gisAuthoritativeStats,
      gisPlanarNames: gisPlanarNames,
      gisParseCustomerPlanars: gisParseCustomerPlanars,
      LAYER_DEFS: LAYER_DEFS,
      AISLE_STYLE: AISLE_STYLE,
      GRID_CELL_FEET: GRID_CELL_FEET,
    },
    loadForFacility: loadForFacility,
    reset: reset,
    queueRender: queueRender,
    refresh: refresh,
    fitMap: fitMap,
    zoomBy: zoomBy,
    panBy: panBy,
    setLayerVisible: setLayerVisible,
    rebuildFilterState: rebuildFilterState,
    selectFeature: selectFeature,
    loadCustomerMapping: loadCustomerMapping,
    removeCanvas: removeCanvas,
    state: state,
  };
})();
