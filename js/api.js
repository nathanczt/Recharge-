// Services externes gratuits et sans clé : adresses, itinéraire, altitude, météo.

async function getJSON(url, signal) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`${new URL(url).host} : erreur ${res.status}`);
  return res.json();
}

/* ---------- Adresses ---------- */

async function searchBAN(q, signal) {
  const qs = '?q=' + encodeURIComponent(q) + '&limit=5';
  let data;
  try {
    data = await getJSON('https://data.geopf.fr/geocodage/search' + qs, signal);
  } catch (e) {
    if (signal?.aborted) throw e;
    data = await getJSON('https://api-adresse.data.gouv.fr/search/' + qs, signal);
  }
  return (data.features || []).map((f) => ({
    label: f.properties.label,
    sub: f.properties.context || '',
    lat: f.geometry.coordinates[1],
    lon: f.geometry.coordinates[0],
  }));
}

async function searchPhoton(q, signal, near) {
  let url = 'https://photon.komoot.io/api/?limit=5&lang=fr&q=' + encodeURIComponent(q);
  if (near) url += `&lat=${near.lat}&lon=${near.lon}`;
  const data = await getJSON(url, signal);
  return (data.features || []).map((f) => {
    const p = f.properties;
    const main = [p.name, p.housenumber && p.street ? `${p.housenumber} ${p.street}` : p.street].filter(Boolean)[0] || p.city;
    return {
      label: main,
      sub: [p.postcode, p.city !== main ? p.city : null, p.state, p.country].filter(Boolean).join(', '),
      lat: f.geometry.coordinates[1],
      lon: f.geometry.coordinates[0],
    };
  });
}

export async function geocode(q, signal, near) {
  const [ban, photon] = await Promise.allSettled([searchBAN(q, signal), searchPhoton(q, signal, near)]);
  const list = [...(ban.value || []).slice(0, 4), ...(photon.value || [])];
  const seen = new Set();
  return list.filter((r) => {
    const k = r.lat.toFixed(3) + ',' + r.lon.toFixed(3);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 7);
}

/* ---------- Itinéraire (OSRM) ---------- */

export async function route(waypoints, { avoidTolls = false } = {}, signal) {
  const coords = waypoints.map((w) => `${w.lon.toFixed(6)},${w.lat.toFixed(6)}`).join(';');
  const base = 'https://router.project-osrm.org/route/v1/driving/' + coords +
    '?overview=full&geometries=geojson&annotations=distance,duration&steps=false';
  let data;
  try {
    data = await getJSON(base + (avoidTolls ? '&exclude=toll' : ''), signal);
  } catch (e) {
    if (!avoidTolls || signal?.aborted) throw e;
    data = await getJSON(base, signal);
  }
  if (data.code !== 'Ok' || !data.routes?.length) throw new Error('Aucun itinéraire trouvé');
  const r = data.routes[0];
  const coordsLL = r.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
  const segs = [];
  for (const leg of r.legs) {
    const a = leg.annotation;
    for (let i = 0; i < a.distance.length; i++) segs.push({ dist: a.distance[i], dur: a.duration[i] });
  }
  // Les étapes intermédiaires dupliquent un point entre deux legs
  while (segs.length > coordsLL.length - 1) segs.pop();
  while (segs.length < coordsLL.length - 1) segs.push({ dist: 0, dur: 0 });
  return { coords: coordsLL, segs, distance: r.distance, duration: r.duration };
}

/* ---------- Altitude (Open-Meteo, MNT ~90 m) ---------- */

export async function elevations(points, signal, onProgress) {
  const out = new Array(points.length);
  const batches = [];
  for (let i = 0; i < points.length; i += 100) batches.push(i);
  let done = 0;
  const worker = async () => {
    while (batches.length) {
      const start = batches.shift();
      const slice = points.slice(start, start + 100);
      const url = 'https://api.open-meteo.com/v1/elevation?latitude=' +
        slice.map((p) => p.lat.toFixed(5)).join(',') + '&longitude=' + slice.map((p) => p.lon.toFixed(5)).join(',');
      const data = await getJSON(url, signal);
      data.elevation.forEach((e, k) => { out[start + k] = e; });
      onProgress?.(++done / Math.ceil(points.length / 100));
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  // Lissage léger (ponts / tunnels mal représentés dans le MNT)
  const sm = out.slice();
  for (let i = 1; i < out.length - 1; i++) sm[i] = (out[i - 1] + 2 * out[i] + out[i + 1]) / 4;
  return sm;
}

/* ---------- Météo (Open-Meteo, prévisions 16 jours) ---------- */

/**
 * Renvoie une fonction (chunkIdx, tSec) => { tempC, windMs, windFrom } basée sur
 * des points météo espacés d'environ 40 km, à l'heure de passage estimée.
 */
export async function weatherAlong(points, departure, signal) {
  const total = points[points.length - 1].d;
  const n = Math.min(40, Math.max(2, Math.round(total / 40000) + 1));
  const samples = [];
  for (let k = 0; k < n; k++) {
    const target = total * k / (n - 1);
    let idx = points.findIndex((p) => p.d >= target);
    if (idx < 0) idx = points.length - 1;
    samples.push(idx);
  }
  const url = 'https://api.open-meteo.com/v1/forecast?latitude=' +
    samples.map((i) => points[i].lat.toFixed(3)).join(',') +
    '&longitude=' + samples.map((i) => points[i].lon.toFixed(3)).join(',') +
    '&hourly=temperature_2m,wind_speed_10m,wind_direction_10m&wind_speed_unit=ms&timeformat=unixtime&forecast_days=16&past_days=1';
  let data = await getJSON(url, signal);
  if (!Array.isArray(data)) data = [data];
  const t0 = departure.getTime() / 1000;
  const lastTime = data[0].hourly.time[data[0].hourly.time.length - 1];
  if (t0 > lastTime) return null; // départ trop lointain pour la prévision

  const lookup = (s, tAbs) => {
    const h = data[s].hourly;
    let i = Math.round((tAbs - h.time[0]) / 3600);
    i = Math.max(0, Math.min(h.time.length - 1, i));
    return { tempC: h.temperature_2m[i], windMs: h.wind_speed_10m[i], windFrom: h.wind_direction_10m[i] };
  };
  // Pour chaque tronçon, l'échantillon météo le plus proche
  const nearest = new Int16Array(points.length);
  let s = 0;
  for (let i = 0; i < points.length; i++) {
    while (s < samples.length - 1 && Math.abs(points[samples[s + 1]].d - points[i].d) < Math.abs(points[samples[s]].d - points[i].d)) s++;
    nearest[i] = s;
  }
  const fn = (k, tSec) => lookup(nearest[k], t0 + tSec);
  fn.summary = () => {
    const temps = data.map((d, i) => lookup(i, t0).tempC);
    return { min: Math.min(...temps), max: Math.max(...temps) };
  };
  return fn;
}
