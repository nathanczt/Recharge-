// Outils géométriques purs.

const R = 6371000;
const rad = (d) => d * Math.PI / 180;

export function haversine(a, b) {
  const dLat = rad(b[0] - a[0]);
  const dLon = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Cap (degrés, 0 = nord) de a vers b
export function bearing(a, b) {
  const y = Math.sin(rad(b[1] - a[1])) * Math.cos(rad(b[0]));
  const x = Math.cos(rad(a[0])) * Math.sin(rad(b[0])) -
    Math.sin(rad(a[0])) * Math.cos(rad(b[0])) * Math.cos(rad(b[1] - a[1]));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/**
 * Découpe un itinéraire en tronçons réguliers.
 * @param coords   [[lat, lon], ...]
 * @param segs     [{ dist (m), dur (s) }, ...] de longueur coords.length - 1
 * @param stepM    longueur cible d'un tronçon
 * @returns points [{ lat, lon, d }] et chunks [{ distM, durS, heading }] (points.length = chunks.length + 1)
 */
export function resampleRoute(coords, segs, stepM) {
  const points = [{ lat: coords[0][0], lon: coords[0][1], d: 0 }];
  const chunks = [];
  let accD = 0, accT = 0, total = 0;
  let chunkStart = coords[0];
  for (let i = 0; i < segs.length; i++) {
    accD += segs[i].dist;
    accT += segs[i].dur;
    total += segs[i].dist;
    const last = i === segs.length - 1;
    if (accD >= stepM || (last && accD > 0)) {
      const end = coords[i + 1];
      chunks.push({ distM: accD, durS: accT, heading: bearing(chunkStart, end) });
      points.push({ lat: end[0], lon: end[1], d: total });
      chunkStart = end;
      accD = 0; accT = 0;
    }
  }
  return { points, chunks };
}

// Réduit une polyligne à environ `maxPts` points (pour les requêtes API)
export function thin(points, maxPts) {
  if (points.length <= maxPts) return points.slice();
  const out = [];
  const step = (points.length - 1) / (maxPts - 1);
  for (let i = 0; i < maxPts; i++) out.push(points[Math.round(i * step)]);
  return out;
}

// Encodage "Google polyline" (précision 5)
export function encodePolyline(latlons) {
  let out = '', pLat = 0, pLon = 0;
  const enc = (v) => {
    v = v < 0 ? ~(v << 1) : v << 1;
    let s = '';
    while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
    return s + String.fromCharCode(v + 63);
  };
  for (const [lat, lon] of latlons) {
    const iLat = Math.round(lat * 1e5), iLon = Math.round(lon * 1e5);
    out += enc(iLat - pLat) + enc(iLon - pLon);
    pLat = iLat; pLon = iLon;
  }
  return out;
}

/**
 * Projette des stations sur l'itinéraire (point le plus proche).
 * Ajoute { idx, offsetM } à chaque station et ne garde que celles à moins de maxOffsetM.
 */
export function projectStations(stations, points, maxOffsetM) {
  // Grille grossière pour éviter un O(n×m) trop lent sur les longs trajets
  const cell = 0.05;
  const grid = new Map();
  points.forEach((p, i) => {
    const k = Math.floor(p.lat / cell) + ':' + Math.floor(p.lon / cell);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  });
  const out = [];
  for (const s of stations) {
    const ci = Math.floor(s.lat / cell), cj = Math.floor(s.lon / cell);
    let best = Infinity, bestIdx = -1;
    for (let di = -2; di <= 2; di++) for (let dj = -2; dj <= 2; dj++) {
      const list = grid.get((ci + di) + ':' + (cj + dj));
      if (!list) continue;
      for (const i of list) {
        const d = haversine([s.lat, s.lon], [points[i].lat, points[i].lon]);
        if (d < best) { best = d; bestIdx = i; }
      }
    }
    if (bestIdx >= 0 && best <= maxOffsetM) out.push({ ...s, idx: bestIdx, offsetM: best });
  }
  return out.sort((a, b) => a.idx - b.idx);
}

// Regroupe les bornes d'un même opérateur sur un même site (< radiusM) : garde la plus puissante
export function clusterStations(stations, radiusM = 150) {
  const sorted = stations.slice().sort((a, b) => b.powerKW - a.powerKW);
  const kept = [];
  for (const s of sorted) {
    const near = kept.find((k) => (k.operatorKey || '') === (s.operatorKey || '') &&
      haversine([k.lat, k.lon], [s.lat, s.lon]) < radiusM);
    if (near) {
      near.points = (near.points || 1) + (s.points || 1);
    } else kept.push({ ...s });
  }
  return kept;
}
