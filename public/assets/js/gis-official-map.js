// ═══ OFFICIAL GIS WAREHOUSE MAP — lazy chunk, loaded only on the GIS route ═══
// Renders the surveyed warehouse geometry from the official GIS service
// (gis.item.com) through the read-only /api/proxy/gis/ allow list, matching
// the official gis.item.com/gis/warehouse map experience: an interactive
// street basemap (dark/light + satellite), the authoritative planar geometry
// at its real coordinates, layer toggles, hover/click details, and read-only
// inventory stat/detail summaries. Records without real latlng coordinates
// are never placed synthetically; when official geometry is unavailable the
// dashboard keeps the WMS aisle/bay topology schematic as an explicit
// fallback. Leaflet and the basemap tiles are loaded lazily on this route.
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

  // Production-safe raster basemaps with required attribution (no API keys).
  // Map mode follows the Item theme (CARTO light/dark); satellite is Esri
  // World Imagery regardless of theme.
  function gisBasemapUrl(mode, theme) {
    if (mode === 'satellite') {
      return 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
    }
    return theme === 'dark'
      ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
      : 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';
  }

  function gisBasemapAttribution(mode) {
    if (mode === 'satellite') {
      return 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community';
    }
    return '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';
  }

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

  // Repeated-envelope normalizer: the GIS service returns
  // {code,success,msg,data:[...]} and the dashboard proxy may wrap that again
  // in another {data: ...}, so unwrap object `.data` layers until an array or
  // a non-envelope value is reached. Only `.data` is unwrapped — arbitrary
  // guessed list/record keys are never accepted.
  function gisUnwrapData(payload) {
    var value = payload;
    var depth = 0;
    while (value && typeof value === 'object' && !Array.isArray(value) && value.data !== undefined && depth < 8) {
      value = value.data;
      depth++;
    }
    return value;
  }

  // Exact identity match of a facility-search candidate against the selected
  // facility (id / facilityId / facilityCode / code / legacyId, then name).
  function gisFacilityMatches(candidate, facilityId, facilityName) {
    var facilityKey = normalizeKey(facilityId);
    var facilityNameKey = normalizeKey(facilityName);
    var fields = ['id', 'facilityId', 'facility_id', 'facilityCode', 'code', 'legacyId'];
    for (var f = 0; f < fields.length; f++) {
      var value = candidate ? candidate[fields[f]] : null;
      if (normalizeKey(value == null ? '' : String(value)) === facilityKey) return true;
    }
    return !!(facilityNameKey && normalizeKey(candidate && candidate.name == null ? '' : String(candidate && candidate.name)) === facilityNameKey);
  }

  // Dynamic facility → official warehouse resolution. Priority:
  // 1. exact normalized warehouse.facilityId === selected facility (primary),
  // 2. facility-search candidates carrying an explicit warehouse id,
  // 3. accounting code shared by the matched facility and the warehouse,
  // 4. normalized warehouse name === facility name (explicit fallback).
  // Returns {warehouseId, warehouse, source, matchedOn} or null.
  function gisResolveWarehouse(facilityId, facilityName, facilityCandidates, warehouses) {
    var facilityKey = normalizeKey(facilityId);
    var facilityNameKey = normalizeKey(facilityName);
    var idFields = ['warehouseId', 'warehouse_ids', 'warehouseIds'];
    function candidateValue(item, field) {
      var value = item[field];
      return value == null ? '' : String(value);
    }
    function numericId(value) {
      return /^\d+$/.test(String(value)) ? Number(value) : null;
    }
    function sameFacility(candidate) {
      return gisFacilityMatches(candidate, facilityId, facilityName);
    }
    var candidates = Array.isArray(facilityCandidates) ? facilityCandidates : [];
    var list = Array.isArray(warehouses) ? warehouses : [];

    // 1) Primary: warehouse record whose facilityId matches the selected facility.
    for (var j = 0; j < list.length; j++) {
      var warehouse = list[j];
      var facility = normalizeKey(candidateValue(warehouse, 'facilityId') || candidateValue(warehouse, 'facility_code'));
      if (facility && facility === facilityKey) {
        return { warehouseId: Number(warehouse.id), warehouse: warehouse, source: 'warehouse.facilityId', matchedOn: 'facilityId' };
      }
    }
    // 2) Facility-search candidates that reference the selected facility and
    //    carry an explicit warehouse id (or a nested warehouse record).
    for (var i = 0; i < candidates.length; i++) {
      var candidate = candidates[i];
      if (!sameFacility(candidate)) continue;
      for (var w = 0; w < idFields.length; w++) {
        var warehouseId = numericId(candidateValue(candidate, idFields[w]));
        if (warehouseId !== null) return { warehouseId: warehouseId, warehouse: null, source: 'facility-search', matchedOn: idFields[w] };
      }
      var nested = candidate.warehouse || candidate.warehouseInfo;
      if (nested && numericId(candidateValue(nested, 'id')) !== null) {
        return { warehouseId: Number(nested.id), warehouse: nested, source: 'facility-search', matchedOn: 'warehouse.id' };
      }
    }
    // 3) Accounting fallback: the matched facility and the warehouse share an
    //    explicit accounting code (exact normalized equality only).
    var matchedCandidate = null;
    for (var c = 0; c < candidates.length; c++) {
      if (sameFacility(candidates[c])) { matchedCandidate = candidates[c]; break; }
    }
    var accountingKey = matchedCandidate ? normalizeKey(candidateValue(matchedCandidate, 'accountingCode')) : '';
    if (accountingKey) {
      for (var a = 0; a < list.length; a++) {
        if (normalizeKey(candidateValue(list[a], 'accountingCode')) === accountingKey) {
          return { warehouseId: Number(list[a].id), warehouse: list[a], source: 'warehouse.accountingCode', matchedOn: 'accountingCode' };
        }
      }
    }
    // 4) Name fallback: normalized warehouse name equals the facility name.
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

  // Inventory summary categorization: blank / Pending Location / staging /
  // pack / dock values are business categories, never mapped onto polygons.
  function gisCategorizeSummaryName(name) {
    var trimmed = String(name == null ? '' : name).trim();
    if (!trimmed || /^pending location$/i.test(trimmed)) return 'Pending Location';
    if (/staging|暂存/i.test(trimmed)) return 'Staging';
    if (/pack|分拣|包装/i.test(trimmed)) return 'Pack';
    if (/dock|码头/i.test(trimmed)) return 'Dock';
    return '';
  }

  // Classify one inventory stat row against the loaded planar geometry.
  // polygon → exact planarName match (highlightable); category → non-geometry
  // business area (blank/Pending Location/staging/pack/dock); unmapped → other.
  function gisClassifySummaryRow(row, featureByName) {
    var name = String(row && row.planarName != null ? row.planarName : '').trim();
    var qty = Number(row && row.totalQty) || 0;
    if (featureByName && featureByName.has(name)) {
      return { kind: 'polygon', name: name, qty: qty };
    }
    var category = gisCategorizeSummaryName(name);
    if (category) {
      return { kind: 'category', name: category, qty: qty, sourceName: name || 'Pending Location' };
    }
    return { kind: 'unmapped', name: name || 'Unknown', qty: qty };
  }

  // ─────────────────────────── IO (read-only via proxy) ───────────────────────────

  // Every GIS proxy request is scoped to the selected facility: tenant LT,
  // the dashboard-selected facility id and the facility timezone (default
  // America/Los_Angeles, replaced from the matched facility record after
  // facility-search). The facility id is read live so facility switches
  // replace the scope on the very next request.
  function apiFetch(pathAndQuery, options) {
    var headers = Object.assign({}, options && options.headers, {
      'Accept': 'application/json',
      'x-tenant-id': 'LT',
      'x-facility-id': state.facilityId || '',
      'Item-Time-Zone': state.timezone || 'America/Los_Angeles',
      'x-channel': 'WEB',
    });
    var fetchOptions = Object.assign({}, options || {}, { headers: headers });
    return fetch('/api/proxy/gis' + pathAndQuery, fetchOptions).then(function (response) {
      return response.json().catch(function () { return null; });
    });
  }

  function inventoryFilterPayload(filters) {
    var payload = {};
    ['customerId', 'titleId', 'itemId'].forEach(function (key) {
      var value = filters && filters[key];
      if (value != null && String(value) !== '') payload[key] = String(value);
    });
    return payload;
  }

  // Loads the facility/warehouse mapping lists and resolves the warehouse id.
  function loadWarehouseInfo(facilityId, facilityName) {
    var facilitySearchPromise = apiFetch('/gis-bam/facility-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: '{}',
    }).then(function (json) {
      var data = gisUnwrapData(json);
      return Array.isArray(data) ? data : [];
    }).catch(function () { return []; });

    var warehouseListPromise = apiFetch('/gis-app/warehouse').then(function (json) {
      var data = gisUnwrapData(json);
      return Array.isArray(data) ? data : [];
    }).catch(function () { return []; });

    return Promise.all([facilitySearchPromise, warehouseListPromise]).then(function (results) {
      // Adopt the exact matched facility record's timezone for every later
      // planar / inventory request.
      var candidates = Array.isArray(results[0]) ? results[0] : [];
      for (var c = 0; c < candidates.length; c++) {
        if (gisFacilityMatches(candidates[c], facilityId, facilityName)) {
          var facilityTimezone = candidates[c].timeZone;
          if (typeof facilityTimezone === 'string' && /^[A-Za-z0-9_+/\-]{1,64}$/.test(facilityTimezone) && !facilityTimezone.includes('..') && !facilityTimezone.startsWith('/') && !facilityTimezone.endsWith('/')) {
            state.timezone = facilityTimezone;
          }
          break;
        }
      }
      var resolved = gisResolveWarehouse(facilityId, facilityName, results[0], results[1]);
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
      var data = gisUnwrapData(page1);
      if (!data || typeof data !== 'object') return { type: type, records: [], totalCount: 0, totalPage: 1 };
      if (Array.isArray(data)) return { type: type, records: data, totalCount: data.length, totalPage: 1 };
      if (!Array.isArray(data.list)) {
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
      var data = gisUnwrapData(json);
      return Array.isArray(data) ? data : [];
    }).catch(function () { return []; });
  }

  // Read-only inventory summary: POST stat with optional customer/title/item.
  function loadInventoryStat(filters) {
    return apiFetch('/gis-bam/location-inventory/stat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(inventoryFilterPayload(filters)),
    }).then(function (json) {
      var rows = gisUnwrapData(json);
      return Array.isArray(rows) ? rows : [];
    });
  }

  // Read-only paginated inventory detail for one planar.
  function loadInventoryDetail(planarName, filters, page, pageSize) {
    var payload = inventoryFilterPayload(filters);
    payload.planarName = String(planarName);
    payload.currentPage = Math.max(1, Number(page) || 1);
    payload.pageSize = Math.max(1, Math.min(500, Number(pageSize) || 50));
    return apiFetch('/gis-bam/location-inventory/detail', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(payload),
    }).then(function (json) {
      var data = gisUnwrapData(json);
      var list = Array.isArray(data) ? data : (data && Array.isArray(data.list) ? data.list : []);
      return {
        rows: list,
        total: Number(data && data.totalCount) || 0,
        page: payload.currentPage,
        pageSize: payload.pageSize,
      };
    });
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

  // Project every feature into local meters once per load. The inverse map
  // (world → latlng) keeps the Leaflet overlay aligned to the basemap.
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
    mapReady: false,
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
    featureByName: new Map(),
    visible: { zone: true, rack: true, bulk: true, dock: true, aisles: true, grid: false },
    selectedFeature: null,
    hoveredFeature: null,
    fitBounds: null,
    requestToken: 0,
    centerLng: -118.24,
    centerLat: 33.94,
    theme: 'light',
    timezone: 'America/Los_Angeles',
    basemapMode: 'map',
    map: null,
    tileLayer: null,
    planarLayer: null,
    leafletLoading: null,
    inventory: {
      filters: { customerId: '', titleId: '', itemId: '' },
      summary: [],
      detailPlanar: '',
      detail: null,
      detailPage: 1,
      detailPageSize: 50,
    },
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
    var bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (var q = 0; q < ring.length; q++) {
      if (ring[q][0] < bounds.minX) bounds.minX = ring[q][0];
      if (ring[q][1] < bounds.minY) bounds.minY = ring[q][1];
      if (ring[q][0] > bounds.maxX) bounds.maxX = ring[q][0];
      if (ring[q][1] > bounds.maxY) bounds.maxY = ring[q][1];
    }
    return { rings: [ring], bounds: bounds };
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

  // ─────────────────────────── Leaflet integration ───────────────────────────

  function el(id) { return document.getElementById(id); }

  function setStatus(message) {
    var status = el('gis-status');
    if (status) status.textContent = message;
  }

  function rgba(hex, opacity) {
    var r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + opacity + ')';
  }

  function currentTheme() {
    state.theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
    return state.theme;
  }

  function dimColor() {
    return state.theme === 'dark' ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.62)';
  }

  function outlineColor() {
    return state.theme === 'dark' ? '#ffffff' : '#202124';
  }

  function gridColor() {
    return state.theme === 'dark' ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.16)';
  }

  // Lazily load the vendored Leaflet library + stylesheet (GIS route only).
  function gisLoadLeaflet() {
    if (window.L) return Promise.resolve(window.L);
    if (state.leafletLoading) return state.leafletLoading;
    state.leafletLoading = new Promise(function (resolve) {
      if (!document || typeof document.createElement !== 'function') {
        state.leafletLoading = null;
        resolve(null);
        return;
      }
      var css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = '/assets/vendor/leaflet/leaflet.css';
      document.head.appendChild(css);
      var script = document.createElement('script');
      script.src = '/assets/vendor/leaflet/leaflet.js';
      script.async = true;
      var settled = false;
      var finish = function (ok) {
        if (settled) return;
        settled = true;
        state.leafletLoading = null;
        resolve(ok && window.L ? window.L : null);
      };
      script.onload = function () { finish(true); };
      script.onerror = function () { finish(false); };
      setTimeout(function () { finish(false); }, 15000);
      document.head.appendChild(script);
    });
    return state.leafletLoading;
  }

  function worldToLatLng(worldX, worldY) {
    var lngScale = METERS_PER_DEG_LNG * Math.cos((state.centerLat * Math.PI) / 180);
    return [state.centerLat + worldY / METERS_PER_DEG_LAT, state.centerLng + worldX / lngScale];
  }

  function latLngToWorld(latlng) {
    var lngScale = METERS_PER_DEG_LNG * Math.cos((state.centerLat * Math.PI) / 180);
    return { worldX: (latlng.lng - state.centerLng) * lngScale, worldY: (latlng.lat - state.centerLat) * METERS_PER_DEG_LAT };
  }

  function applyBasemap() {
    if (!state.map || !window.L) return;
    if (state.tileLayer) {
      state.map.removeLayer(state.tileLayer);
      state.tileLayer = null;
    }
    var mode = state.basemapMode;
    var theme = currentTheme();
    state.tileLayer = L.tileLayer(gisBasemapUrl(mode, theme), {
      maxZoom: 19,
      attribution: gisBasemapAttribution(mode),
      subdomains: 'abcd',
    });
    state.tileLayer.addTo(state.map);
    if (state.planarLayer) state.planarLayer.redraw();
  }

  function setBasemapMode(mode) {
    state.basemapMode = mode === 'satellite' ? 'satellite' : 'map';
    applyBasemap();
    var toggle = el('gis-map-mode');
    if (toggle) {
      toggle.textContent = state.basemapMode === 'satellite' ? 'Map' : 'Satellite';
      toggle.setAttribute('aria-pressed', String(state.basemapMode === 'satellite'));
    }
    return state.basemapMode;
  }

  // Custom Leaflet layer drawing the official planar geometry onto a canvas
  // that tracks the map view (exact Mercator alignment via latLng conversion).
  var GisPlanarLayer = null;
  function makePlanarLayer() {
    if (GisPlanarLayer) return GisPlanarLayer;
    GisPlanarLayer = L.Layer.extend({
      onAdd: function (map) {
        this._ownMap = map;
        this._canvas = L.DomUtil.create('canvas', 'gis-planar-canvas');
        this._canvas.setAttribute('aria-hidden', 'true');
        map.getPane('overlayPane').appendChild(this._canvas);
        this._reset();
        map.on('resize', this._reset, this);
        map.on('moveend zoomend', this.redraw, this);
      },
      onRemove: function (map) {
        map.off('resize', this._reset, this);
        map.off('moveend zoomend', this.redraw, this);
        if (this._canvas && this._canvas.parentNode) this._canvas.parentNode.removeChild(this._canvas);
        this._canvas = null;
      },
      _reset: function () {
        if (!this._ownMap || !this._canvas) return;
        var size = this._ownMap.getSize();
        this._canvas.width = Math.max(1, size.x);
        this._canvas.height = Math.max(1, size.y);
        this.redraw();
      },
      redraw: function () {
        if (this._ownMap && this._canvas) this._draw();
      },
      _draw: function () {
        var map = this._ownMap;
        var canvas = this._canvas;
        var context = canvas.getContext('2d');
        var size = map.getSize();
        context.clearRect(0, 0, size.x, size.y);
        // Read the live theme every frame so light/dark re-renders never rely
        // on event delivery timing.
        currentTheme();
        var containerPoint = function (worldX, worldY) {
          return map.latLngToContainerPoint(worldToLatLng(worldX, worldY));
        };
        var visible = function (bounds) {
          return bounds.maxX >= state.viewMinX && bounds.minX <= state.viewMaxX && bounds.maxY >= state.viewMinY && bounds.minY <= state.viewMaxY;
        };
        var viewBounds = map.getBounds();
        var northEast = latLngToWorld(viewBounds.getNorthEast());
        var southWest = latLngToWorld(viewBounds.getSouthWest());
        state.viewMinX = southWest.worldX;
        state.viewMaxX = northEast.worldX;
        state.viewMinY = southWest.worldY;
        state.viewMaxY = northEast.worldY;

        // Aisles & roads beneath the planar fills.
        if (state.visible.aisles) {
          context.strokeStyle = AISLE_STYLE.stroke;
          context.globalAlpha = AISLE_STYLE.strokeOpacity;
          context.lineWidth = Math.max(1.5, AISLE_STYLE.strokeWeight / Math.pow(2, Math.max(0, map.getZoom() - 14)));
          context.lineCap = 'round';
          var aisles = state.aisleProjected;
          for (var a = 0; a < aisles.length; a++) {
            var aisle = aisles[a];
            if (!visible(aisle.bounds)) continue;
            var ring = aisle.rings[0];
            if (!ring || ring.length < 2) continue;
            context.beginPath();
            var first = containerPoint(ring[0][0], ring[0][1]);
            context.moveTo(first.x, first.y);
            for (var p = 1; p < ring.length; p++) {
              var next = containerPoint(ring[p][0], ring[p][1]);
              context.lineTo(next.x, next.y);
            }
            context.stroke();
          }
          context.globalAlpha = 1;
          context.lineCap = 'butt';
        }

        var filtersActive = state.customerFilterActive || state.searchFilterActive || state.occupancyFilterActive || state.typeFilterActive;
        var dimmed = dimColor();
        var layerKeys = layerOrder();
        for (var li = 0; li < layerKeys.length; li++) {
          var layerKey = layerKeys[li];
          if (!state.visible[layerKey]) continue;
          var def = LAYER_DEFS[layerKey];
          var fill = rgba(def.fill, def.fillOpacity);
          var stroke = rgba(def.stroke, 1);
          var layerFeatures = state.layerProjected[layerKey] || [];
          for (var i = 0; i < layerFeatures.length; i++) {
            var entry = layerFeatures[i];
            if (!visible(entry.bounds)) continue;
            if (filtersActive && entry.dimmed) {
              context.fillStyle = dimmed;
              context.strokeStyle = 'rgba(128,128,128,0.4)';
            } else {
              context.fillStyle = fill;
              context.strokeStyle = stroke;
            }
            context.lineWidth = Math.max(0.6, def.strokeWeight / Math.pow(2, Math.max(0, map.getZoom() - 14)));
            context.beginPath();
            for (var r = 0; r < entry.rings.length; r++) {
              var featureRing = entry.rings[r];
              if (!featureRing.length) continue;
              var start = containerPoint(featureRing[0][0], featureRing[0][1]);
              context.moveTo(start.x, start.y);
              for (var q = 1; q < featureRing.length; q++) {
                var pt = containerPoint(featureRing[q][0], featureRing[q][1]);
                context.lineTo(pt.x, pt.y);
              }
              context.closePath();
            }
            context.fill();
            if (map.getZoom() > 11) context.stroke();
          }
        }

        // Optional cell grid (3 ft squares over the warehouse outline).
        if (state.visible.grid && state.gridLines.length && map.getZoom() >= 16) {
          context.strokeStyle = gridColor();
          context.lineWidth = 1;
          context.beginPath();
          for (var g = 0; g < state.gridLines.length; g++) {
            var line = state.gridLines[g];
            var from = containerPoint(line[0].x, line[0].y);
            var to = containerPoint(line[1].x, line[1].y);
            context.moveTo(from.x, from.y);
            context.lineTo(to.x, to.y);
          }
          context.stroke();
        }

        // Selected feature outline.
        if (state.selectedFeature && visible(state.selectedFeature.bounds)) {
          var sel = state.selectedFeature;
          context.strokeStyle = outlineColor();
          context.lineWidth = 3;
          context.beginPath();
          for (var sr = 0; sr < sel.rings.length; sr++) {
            var sring = sel.rings[sr];
            if (!sring.length) continue;
            var sstart = containerPoint(sring[0][0], sring[0][1]);
            context.moveTo(sstart.x, sstart.y);
            for (var sp = 1; sp < sring.length; sp++) {
              var spt = containerPoint(sring[sp][0], sring[sp][1]);
              context.lineTo(spt.x, spt.y);
            }
            context.closePath();
          }
          context.stroke();
        }
      },
    });
    return GisPlanarLayer;
  }

  function ensureMap() {
    var container = el('gis-ws-leaflet');
    if (!container || !window.L) return null;
    if (state.map) {
      if (state.map._container && state.map._container.parentNode) state.map.invalidateSize();
      return state.map;
    }
    state.map = L.map(container, {
      zoomControl: false,
      attributionControl: true,
      minZoom: 3,
      maxZoom: 19,
      worldCopyJump: true,
    });
    state.map.attributionControl.setPrefix('Leaflet');
    applyBasemap();
    var LayerCtor = makePlanarLayer();
    state.planarLayer = new LayerCtor();
    state.planarLayer.addTo(state.map);
    state.map.on('click', onMapClick);
    state.map.on('mousemove', onMapMouseMove);
    state.map.on('mouseout', function () {
      state.hoveredFeature = null;
      hideTooltip();
    });
    return state.map;
  }

  function eventToWorld(mapEvent) {
    return latLngToWorld(mapEvent.latlng);
  }

  function featureAtLatLng(latlng) {
    if (!state.spatial) return null;
    var world = latLngToWorld(latlng);
    return hitTest(state.spatial, world.worldX, world.worldY, function (feature) {
      return state.visible[feature.properties.layerType] === true;
    });
  }

  function onMapClick(event) {
    if (!state.active) return;
    var entry = featureAtLatLng(event.latlng);
    state.selectedFeature = entry;
    if (entry) selectFeature(entry.feature);
    else selectFeature(null);
    if (state.planarLayer) state.planarLayer.redraw();
  }

  function onMapMouseMove(event) {
    if (!state.active) return;
    if (state.map.dragging().enabled()) return; // skip hover while dragging
    var entry = featureAtLatLng(event.latlng);
    if (entry !== state.hoveredFeature) {
      state.hoveredFeature = entry;
      if (entry) showTooltip(event, entry.feature);
      else hideTooltip();
      if (state.planarLayer) state.planarLayer.redraw();
    }
  }

  function showTooltip(event, feature) {
    var tooltip = el('gis-map-tooltip');
    if (!tooltip) return;
    var props = feature.properties || {};
    var name = props.name;
    var layer = (LAYER_DEFS[props.layerType] || {}).label || '';
    tooltip.textContent = name ? String(name) + (layer ? ' · ' + layer : '') : 'Official GIS location';
    tooltip.hidden = false;
    var container = el('gis-ws-leaflet');
    if (container) {
      tooltip.style.left = (event.containerPoint.x + 12) + 'px';
      tooltip.style.top = (event.containerPoint.y + 12) + 'px';
    }
  }

  function hideTooltip() {
    var tooltip = el('gis-map-tooltip');
    if (tooltip) tooltip.hidden = true;
  }

  function fitMap() {
    if (!state.map || !state.fitBounds || !window.L) return;
    state.map.fitBounds(state.fitBounds, { padding: [28, 28], maxZoom: 19 });
  }

  function zoomBy(factor) {
    if (!state.map) return;
    if (factor > 0) state.map.zoomIn();
    else state.map.zoomOut();
  }

  function panBy(deltaX, deltaY) {
    if (!state.map || !window.L) return;
    state.map.panBy(L.point(deltaX, deltaY));
  }

  function invalidateSize() {
    if (state.map) state.map.invalidateSize();
  }

  function refresh() {
    currentTheme();
    applyBasemap();
    if (state.map) state.map.invalidateSize();
    if (state.planarLayer) state.planarLayer.redraw();
  }

  function queueRender() {
    if (state.planarLayer) state.planarLayer.redraw();
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

  // Highlight + center a planar by its exact official name (summary row focus).
  function focusPlanarByName(name) {
    var entry = state.featureByName.get(String(name));
    if (!entry) return false;
    state.selectedFeature = entry;
    selectFeature(entry.feature);
    if (state.map && window.L) {
      var center = worldToLatLng((entry.bounds.minX + entry.bounds.maxX) / 2, (entry.bounds.minY + entry.bounds.maxY) / 2);
      state.map.flyTo(center, Math.max(state.map.getZoom(), 17), { duration: 0.6 });
    }
    queueRender();
    return true;
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
    }
  }

  // ─────────────────────────── Public API ───────────────────────────

  function loadForFacility(facilityId, facilityName) {
    state.requestToken++;
    var token = state.requestToken;
    // Scope the entire load to the selected facility synchronously, before
    // facility-search goes out, so no request can reuse a prior facility.
    state.facilityId = facilityId;
    state.facilityName = facilityName;
    state.timezone = 'America/Los_Angeles';
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
        return gisLoadLeaflet().then(function (leaflet) {
          if (token !== state.requestToken) return { stale: true };
          if (!leaflet && document && typeof document.createElement === 'function') {
            state.active = false;
            return { status: 'unavailable', reason: 'map-engine', message: 'The map engine could not be loaded for the official GIS layout.' };
          }
          state.mapReady = !!leaflet;
          finalizeAndRender();
          return {
            status: 'official',
            warehouseId: resolved.warehouseId,
            source: resolved.source,
            counts: counts,
            authoritative: state.authoritative,
          };
        });
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
    state.centerLng = lngBounds ? (lngBounds.minLng + lngBounds.maxLng) / 2 : -118.24;
    state.centerLat = lngBounds ? (lngBounds.minLat + lngBounds.maxLat) / 2 : 33.94;
    var project = makeProjection(state.centerLng, state.centerLat);

    state.projected = projectFeatures(allFeatures, project);
    state.aisleProjected = projectFeatures(state.aisles, project);
    state.outlineProjected = projectWarehouseOutline(state.warehouse, project);
    state.layerProjected = {};
    for (var l = 0; l < layerKeys.length; l++) {
      var key = layerKeys[l];
      state.layerProjected[key] = state.projected.filter(function (entry) {
        return entry.feature.properties.layerType === key;
      });
    }
    state.spatial = buildSpatialIndex(state.projected, 40);
    state.gridLines = buildCellGrid(state.outlineProjected ? state.outlineProjected.rings : null, GRID_CELL_FEET);
    state.featureByName = new Map();
    state.projected.forEach(function (entry) {
      var name = entry.feature.properties && entry.feature.properties.name;
      if (name) state.featureByName.set(String(name), entry);
    });
    state.selectedFeature = null;
    state.hoveredFeature = null;

    var bounds = computeBounds(state.projected, state.aisleProjected, state.outlineProjected);
    if (!bounds) {
      state.active = false;
      return;
    }
    state.fitBounds = (window.L && window.L.latLngBounds) ? window.L.latLngBounds([
      worldToLatLng(bounds.minX, bounds.minY),
      worldToLatLng(bounds.maxX, bounds.maxY),
    ]) : null;

    // Show the workspace map container before sizing/drawing (the loading
    // state hides it; the schematic renderer shows its viewport the same way).
    var loadingState = el('gis-map-state');
    var mapContainer = el('gis-ws-leaflet');
    var schematicCanvas = el('gis-map-canvas');
    if (loadingState) loadingState.hidden = true;
    if (mapContainer) mapContainer.hidden = false;
    if (schematicCanvas) schematicCanvas.hidden = true;
    ensureMap();
    if (state.map) {
      fitMap();
    }
    syncLayerSwatches();
    rebuildFilterState();
    state.active = true;
    if (state.map && state.planarLayer) {
      state.planarLayer.redraw();
    }
    if (mapContainer) {
      mapContainer.dataset.geometrySource = 'official-gis';
      mapContainer.dataset.officialFeatureCount = String(state.projected.length);
      mapContainer.dataset.officialAisleCount = String(state.aisleProjected.length);
      mapContainer.dataset.warehouseId = String(state.warehouseId);
      mapContainer.dataset.renderedTheme = currentTheme();
    }
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

  function removeCanvas() {
    state.active = false;
    if (state.map) {
      state.map.remove();
      state.map = null;
      state.tileLayer = null;
      state.planarLayer = null;
    }
    var mapContainer = el('gis-ws-leaflet');
    if (mapContainer) mapContainer.hidden = true;
    var schematicCanvas = el('gis-map-canvas');
    if (schematicCanvas) schematicCanvas.hidden = false;
    var loadingState = el('gis-map-state');
    if (loadingState) loadingState.hidden = false;
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
    state.mapReady = false;
    state.layers = { zone: [], rack: [], bulk: [], dock: [] };
    state.aisles = [];
    state.counts = { zone: 0, rack: 0, bulk: 0, dock: 0, aisles: 0 };
    state.authoritative = null;
    state.customers = new Map();
    state.customerNames = new Map();
    state.customerUnavailable = false;
    state.timezone = 'America/Los_Angeles';
    state.projected = [];
    state.aisleProjected = [];
    state.layerProjected = {};
    state.outlineProjected = null;
    state.spatial = null;
    state.gridLines = [];
    state.featureByName = new Map();
    state.selectedFeature = null;
    state.hoveredFeature = null;
    state.fitBounds = null;
    state.inventory = {
      filters: { customerId: '', titleId: '', itemId: '' },
      summary: [],
      detailPlanar: '',
      detail: null,
      detailPage: 1,
      detailPageSize: 50,
    };
    removeCanvas();
  }

  function setLayerVisible(layerKey, visible) {
    if (!(layerKey in state.visible)) return;
    state.visible[layerKey] = !!visible;
    queueRender();
  }

  function onThemeChange() {
    currentTheme();
    applyBasemap();
    if (state.planarLayer) state.planarLayer.redraw();
  }

  if (window.addEventListener) {
    window.addEventListener('item-theme-change', onThemeChange);
  }

  window.GISOfficial = {
    pure: {
      normalizeKey: normalizeKey,
      gisUnwrapData: gisUnwrapData,
      gisFacilityMatches: gisFacilityMatches,
      gisToGeoJSON: gisToGeoJSON,
      gisResolveWarehouse: gisResolveWarehouse,
      gisPlanPagination: gisPlanPagination,
      gisCountFeatures: gisCountFeatures,
      gisAuthoritativeStats: gisAuthoritativeStats,
      gisPlanarNames: gisPlanarNames,
      gisParseCustomerPlanars: gisParseCustomerPlanars,
      gisCategorizeSummaryName: gisCategorizeSummaryName,
      gisClassifySummaryRow: gisClassifySummaryRow,
      gisBasemapUrl: gisBasemapUrl,
      gisBasemapAttribution: gisBasemapAttribution,
      LAYER_DEFS: LAYER_DEFS,
      AISLE_STYLE: AISLE_STYLE,
      GRID_CELL_FEET: GRID_CELL_FEET,
    },
    loadForFacility: loadForFacility,
    reset: reset,
    queueRender: queueRender,
    fitMap: fitMap,
    zoomBy: zoomBy,
    panBy: panBy,
    invalidateSize: invalidateSize,
    refresh: refresh,
    setBasemapMode: setBasemapMode,
    setLayerVisible: setLayerVisible,
    rebuildFilterState: rebuildFilterState,
    selectFeature: selectFeature,
    focusPlanarByName: focusPlanarByName,
    loadCustomerMapping: loadCustomerMapping,
    loadInventoryStat: loadInventoryStat,
    loadInventoryDetail: loadInventoryDetail,
    removeCanvas: removeCanvas,
    state: state,
  };
})();
