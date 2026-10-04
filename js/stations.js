// Récupération des bornes le long d'un trajet : OpenStreetMap (Overpass) ou Open Charge Map.

import { thin, encodePolyline } from './geo.js';
import { identifyOperator, operatorKeyFor } from './operators.js';

const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

function parseKW(v) {
  if (!v) return 0;
  let max = 0;
  for (const part of String(v).split(/[;,/]/)) {
    const m = part.match(/([\d.]+)\s*(k?w|kva)?/i);
    if (!m) continue;
    let n = parseFloat(m[1]);
    const unit = (m[2] || '').toLowerCase();
    if (unit === 'w' || (!unit && n > 1000)) n /= 1000;
    if (n > max && n < 1000) max = n;
  }
  return max;
}

const CCS_KEYS = ['socket:type2_combo', 'socket:ccs', 'socket:combo'];

/** Convertit un élément OSM en borne normalisée (null si non compatible CCS). */
export function parseOsmElement(el, opts = {}) {
  const t = el.tags || {};
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  if (lat == null) return null;
  if (t.access && /^(private|no)$/.test(t.access) && !/tesla/i.test(t.operator || t.brand || '')) return null;
  if (t['disused:amenity'] || t.operational_status === 'closed') return null;

  const op = identifyOperator(t.network, t.operator, t.brand, t.name);
  const hasCcs = CCS_KEYS.some((k) => t[k] && t[k] !== 'no' && t[k] !== '0');
  const hasChademoOnly = t['socket:chademo'] && !hasCcs;
  const hasAnySocket = Object.keys(t).some((k) => /^socket:[^:]+$/.test(k));

  let powerKW = 0;
  for (const k of CCS_KEYS) powerKW = Math.max(powerKW, parseKW(t[k + ':output']));
  if (!powerKW && hasCcs) powerKW = parseKW(t['charging_station:output']) || parseKW(t['maxpower']) || 0;
  let powerKnown = powerKW > 0;

  if (op?.key === 'tesla') {
    if (!opts.allowTesla) return null;
    if (!powerKW) powerKW = 150;
  }
  if (!hasCcs && op?.key !== 'tesla') {
    if (hasAnySocket || hasChademoOnly) return null; // prises décrites mais pas de CCS
    if (!op) return null; // aucune info : on ignore
  }
  if (!powerKW) {
    // Réseau rapide connu sans puissance renseignée
    powerKW = op ? Math.min(op.dc, 150) : 50;
    powerKnown = false;
  }
  const operatorName = op?.name || t.operator || t.network || t.brand || 'Opérateur inconnu';
  return {
    id: 'osm:' + el.type + '/' + el.id,
    lat, lon,
    name: t.name || operatorName,
    operator: operatorName,
    operatorKey: operatorKeyFor(t.network, t.operator, t.brand, t.name),
    powerKW,
    powerKnown,
    points: parseInt(t.capacity, 10) || 1,
    priceText: t.charge || t.fee === 'no' && 'Gratuit' || null,
    hours: t.opening_hours || null,
    source: 'OpenStreetMap',
  };
}

async function overpass(query, signal) {
  let lastErr;
  for (const url of OVERPASS) {
    try {
      const res = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(query), signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      if (!res.ok) throw new Error('Overpass ' + res.status);
      return await res.json();
    } catch (e) {
      if (signal?.aborted) throw e;
      lastErr = e;
    }
  }
  throw lastErr;
}

/** Bornes OSM dans un corridor autour du trajet (points [{lat, lon, d}]). */
export async function fetchOsmStations(points, corridorM, opts, signal, onProgress) {
  // Tronçons de ~250 km pour ne pas dépasser les limites d'Overpass
  const total = points[points.length - 1].d;
  const pieces = Math.max(1, Math.ceil(total / 250000));
  const out = new Map();
  for (let p = 0; p < pieces; p++) {
    const from = points.findIndex((pt) => pt.d >= total * p / pieces);
    let to = points.findIndex((pt) => pt.d >= total * (p + 1) / pieces);
    if (to < 0) to = points.length - 1;
    const sub = thin(points.slice(from, to + 1), 120);
    const line = sub.map((pt) => pt.lat.toFixed(5) + ',' + pt.lon.toFixed(5)).join(',');
    const q = `[out:json][timeout:90];(node["amenity"="charging_station"](around:${corridorM},${line});` +
      `way["amenity"="charging_station"](around:${corridorM},${line}););out center tags;`;
    const data = await overpass(q, signal);
    for (const el of data.elements || []) {
      const s = parseOsmElement(el, opts);
      if (s) out.set(s.id, s);
    }
    onProgress?.((p + 1) / pieces);
  }
  return [...out.values()];
}

/** Bornes Open Charge Map (clé API gratuite requise). */
export async function fetchOcmStations(points, corridorM, opts, signal) {
  const poly = encodePolyline(thin(points, 300).map((p) => [p.lat, p.lon]));
  const params = new URLSearchParams({
    output: 'json', key: opts.ocmKey, polyline: poly, distance: String(corridorM / 1000), distanceunit: 'KM',
    maxresults: '5000', compact: 'false', verbose: 'false', connectiontypeid: '33',
  });
  const res = await fetch('https://api.openchargemap.io/v3/poi/?' + params, { signal });
  if (!res.ok) throw new Error('Open Charge Map ' + res.status);
  const data = await res.json();
  const out = [];
  for (const poi of data) {
    if (poi.StatusType && poi.StatusType.IsOperational === false) continue;
    const ccs = (poi.Connections || []).filter((c) => c.ConnectionTypeID === 33);
    if (!ccs.length) continue;
    const powerKW = Math.max(...ccs.map((c) => c.PowerKW || 0)) || 50;
    const opTitle = poi.OperatorInfo?.Title;
    const op = identifyOperator(opTitle, poi.AddressInfo?.Title);
    if (op?.key === 'tesla' && !opts.allowTesla) continue;
    out.push({
      id: 'ocm:' + poi.ID,
      lat: poi.AddressInfo.Latitude,
      lon: poi.AddressInfo.Longitude,
      name: poi.AddressInfo.Title,
      operator: op?.name || opTitle || 'Opérateur inconnu',
      operatorKey: operatorKeyFor(opTitle, poi.AddressInfo?.Title),
      powerKW,
      powerKnown: ccs.some((c) => c.PowerKW),
      points: poi.NumberOfPoints || ccs.reduce((n, c) => n + (c.Quantity || 1), 0),
      priceText: poi.UsageCost || null,
      hours: null,
      source: 'Open Charge Map',
    });
  }
  return out;
}
