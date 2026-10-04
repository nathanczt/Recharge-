// Profil énergétique du trajet + planification optimale des recharges.
// Pur : testable avec `node --test`.

import { segmentEnergy, chargeTime, gridEnergy } from './energy.js';

/**
 * Calcule l'énergie et le temps cumulés le long du trajet.
 * @param veh     profil véhicule
 * @param points  [{lat, lon, d}]
 * @param chunks  [{distM, durS, heading}]
 * @param elev    altitudes (m) par point, ou null
 * @param weather (pointIdx, tSec) => { tempC, windMs, windFrom } ; ou null
 * @param opts    { maxSpeedKmh, speedFactor, extraMassKg, factor, tempC }
 */
export function buildProfile(veh, points, chunks, elev, weather, opts) {
  const n = points.length;
  const ecum = new Float64Array(n);
  const tcum = new Float64Array(n);
  const temps = new Float64Array(n);
  const speeds = new Float64Array(chunks.length);
  let e = 0, t = 0;
  for (let k = 0; k < chunks.length; k++) {
    const c = chunks[k];
    const osrmKmh = c.durS > 0 ? c.distM / c.durS * 3.6 : 50;
    const speedKmh = Math.max(5, Math.min(osrmKmh * (opts.speedFactor || 1), opts.maxSpeedKmh || 130));
    const w = weather ? weather(k, t) : null;
    const tempC = w && opts.tempC == null ? w.tempC : (opts.tempC ?? 15);
    let headwindMs = 0;
    if (w && w.windMs) {
      // vent à hauteur de voiture ≈ 70 % du vent à 10 m
      headwindMs = w.windMs * 0.7 * Math.cos((c.heading - w.windFrom) * Math.PI / 180);
    }
    const dhM = elev ? elev[k + 1] - elev[k] : 0;
    e += segmentEnergy(veh, { distM: c.distM, speedKmh, dhM, headwindMs, tempC }, opts);
    t += c.distM / 1000 / speedKmh * 3600;
    ecum[k + 1] = e;
    tcum[k + 1] = t;
    temps[k] = tempC;
    speeds[k] = speedKmh;
  }
  temps[n - 1] = temps[Math.max(0, n - 2)];
  return { points, ecum, tcum, temps, speeds };
}

const DETOUR_ROAD_FACTOR = 1.3;
const DETOUR_KMH = 40;

/**
 * Planifie les arrêts recharge en minimisant temps + coût pondéré.
 * @param profile   résultat de buildProfile
 * @param stations  bornes projetées { id, idx, offsetM, powerKW, price, forced? }
 * @param veh       profil véhicule
 * @param cfg       { capKWh, startSoc, minSoc, arrivalSoc, maxCharge, stopOverheadS,
 *                    secondsPerEuro, detourKWhPerKm }
 */
export function planCharging(profile, stations, veh, cfg) {
  const { ecum, tcum, temps, points } = profile;
  const cap = cfg.capKWh;
  const last = points.length - 1;
  const nodes = [{ kind: 'start', idx: 0, offsetM: 0 }, ...stations, { kind: 'end', idx: last, offsetM: 0 }];
  const N = nodes.length;
  const A = 101;
  const detourKWh = (n) => n.offsetM / 1000 * DETOUR_ROAD_FACTOR * (cfg.detourKWhPerKm ?? 0.16);
  const detourS = (n) => n.offsetM / 1000 * DETOUR_ROAD_FACTOR / DETOUR_KMH * 3600;

  const best = new Float64Array(N * A).fill(Infinity);
  const prevNode = new Int32Array(N * A).fill(-1);
  const prevDep = new Int16Array(N * A).fill(-1);
  const depArg = new Int16Array(N * A).fill(-1);

  // Départs possibles (SoC % en quittant une borne)
  const depOptions = [];
  for (let d = 10; d < cfg.maxCharge; d += 5) depOptions.push(d);
  depOptions.push(cfg.maxCharge);

  // Temps de charge cumulé de 0 à s %, mis en cache par (puissance, température)
  const curveCache = new Map();
  const cumCharge = (kw, tempC) => {
    const key = Math.round(kw) + '|' + Math.round(tempC);
    let arr = curveCache.get(key);
    if (!arr) {
      arr = new Float64Array(A);
      for (let s = 1; s < A; s++) arr[s] = arr[s - 1] + chargeTime(veh, cap, s - 1, s, kw, tempC);
      curveCache.set(key, arr);
    }
    return arr;
  };

  let farthest = 0;
  const reach = (i, d, depCost) => {
    const from = nodes[i];
    const avail = (d - cfg.minSoc) / 100 * cap - detourKWh(from);
    const e0 = ecum[from.idx];
    let runMax = e0;
    let p = from.idx;
    for (let j = i + 1; j < N; j++) {
      const to = nodes[j];
      while (p < to.idx) { p++; if (ecum[p] > runMax) runMax = ecum[p]; }
      if (runMax - e0 > avail) break; // panne avant d'atteindre ce point
      const used = ecum[to.idx] - e0 + detourKWh(from) + detourKWh(to);
      const soc = d - used / cap * 100;
      const need = to.kind === 'end' ? cfg.arrivalSoc : cfg.minSoc;
      if (soc >= need) {
        const a = Math.min(100, Math.floor(soc));
        const cost = depCost + tcum[to.idx] - tcum[from.idx] + detourS(from) + detourS(to);
        const k = j * A + a;
        if (cost < best[k]) { best[k] = cost; prevNode[k] = i; prevDep[k] = d; }
        if (to.idx > farthest) farthest = to.idx;
      }
      if (to.forced) break; // on ne peut pas sauter une borne imposée
    }
  };

  reach(0, cfg.startSoc, 0);

  for (let i = 1; i < N - 1; i++) {
    const st = nodes[i];
    const cum = cumCharge(st.powerKW, temps[st.idx]);
    for (const d of depOptions) {
      let bestCost = Infinity, bestA = -1;
      // Un arrêt doit apporter au moins 10 % (sauf borne imposée)
      const minGain = st.forced ? 1 : 10;
      for (let a = 0; a <= d - minGain; a++) {
        const c0 = best[i * A + a];
        if (c0 === Infinity) continue;
        const kWh = (d - a) / 100 * cap;
        const euros = gridEnergy(kWh, st.powerKW) * st.price + (st.sessionFee || 0);
        const c = c0 + (cum[d] - cum[a]) + cfg.stopOverheadS + euros * cfg.secondsPerEuro;
        if (c < bestCost) { bestCost = c; bestA = a; }
      }
      if (bestA < 0) continue;
      depArg[i * A + d] = bestA;
      reach(i, d, bestCost);
    }
  }

  // Meilleure arrivée
  let bestEnd = Infinity, endA = -1;
  for (let a = 0; a < A; a++) {
    const c = best[(N - 1) * A + a];
    if (c < bestEnd) { bestEnd = c; endA = a; }
  }
  if (endA < 0) {
    return { ok: false, farthestKm: points[farthest].d / 1000 };
  }

  // Remonte le chemin
  const chain = []; // [{ node, dep }]
  let j = N - 1, a = endA;
  while (j > 0) {
    const k = j * A + a;
    const i = prevNode[k], d = prevDep[k];
    chain.unshift({ i, d });
    if (i === 0) break;
    a = depArg[i * A + d];
    j = i;
  }

  // Re-simulation exacte
  const stops = [];
  let soc = cfg.startSoc;
  let clock = 0;
  let prev = nodes[0];
  let totalCost = 0, totalChargeS = 0, totalGrid = 0;
  const socAt = new Float64Array(points.length);
  const segment = (from, to, socStart) => {
    for (let p = from.idx; p <= to.idx; p++) socAt[p] = socStart - (ecum[p] - ecum[from.idx] + detourKWh(from)) / cap * 100;
  };
  for (let c = 0; c < chain.length; c++) {
    const { i, d } = chain[c];
    const st = nodes[i];
    const depSoc = i === 0 ? cfg.startSoc : d;
    if (i !== 0) {
      const used = ecum[st.idx] - ecum[prev.idx] + detourKWh(prev) + detourKWh(st);
      const arrive = soc - used / cap * 100;
      clock += tcum[st.idx] - tcum[prev.idx] + detourS(prev) + detourS(st);
      const chargeS = chargeTime(veh, cap, Math.max(0, arrive), depSoc, st.powerKW, temps[st.idx]) + cfg.stopOverheadS;
      const kWh = (depSoc - arrive) / 100 * cap;
      const grid = gridEnergy(kWh, st.powerKW);
      const cost = grid * st.price + (st.sessionFee || 0);
      stops.push({ station: st, arriveSoc: arrive, departSoc: depSoc, arriveT: clock, chargeS, kWh, gridKWh: grid, cost, km: points[st.idx].d / 1000 });
      clock += chargeS;
      totalCost += cost; totalChargeS += chargeS; totalGrid += grid;
      segment(prev, st, soc);
    }
    soc = depSoc;
    prev = st;
  }
  const end = nodes[N - 1];
  const used = ecum[end.idx] - ecum[prev.idx] + detourKWh(prev);
  segment(prev, end, soc);
  clock += tcum[end.idx] - tcum[prev.idx] + detourS(prev);
  const arriveSoc = soc - used / cap * 100;

  return {
    ok: true,
    stops,
    arriveSoc,
    totalS: clock,
    driveS: clock - totalChargeS,
    chargeS: totalChargeS,
    cost: totalCost,
    gridKWh: totalGrid,
    energyKWh: ecum[last],
    distKm: points[last].d / 1000,
    socAt,
  };
}

// Valeurs du temps testées : de « chaque minute compte » à « chaque euro compte » (secondes par €)
export const OPTION_WEIGHTS = [5, 45, 120, 300, 720, 2000];

/**
 * Calcule plusieurs itinéraires de recharge et ne garde que les compromis intéressants :
 * aucune option n'est à la fois plus lente et plus chère qu'une autre.
 * Renvoie les options triées de la plus rapide à la moins chère, avec un libellé.
 */
export function planOptions(profile, stations, veh, cfg, weights = OPTION_WEIGHTS) {
  const found = [];
  let failure = null;
  for (const w of weights) {
    const r = planCharging(profile, stations, veh, { ...cfg, secondsPerEuro: w });
    if (!r.ok) { failure = failure || r; continue; }
    const sig = r.stops.map((s) => s.station.id + '@' + s.departSoc).join('|');
    if (!found.some((f) => f.sig === sig)) found.push({ ...r, sig });
  }
  if (!found.length) return { ok: false, farthestKm: failure?.farthestKm ?? 0, options: [] };

  // Front de Pareto temps / coût (on ignore les écarts < 1 min et < 0,50 €)
  const better = (a, b) => a.totalS <= b.totalS + 60 && a.cost <= b.cost + 0.5 &&
    (a.totalS < b.totalS - 60 || a.cost < b.cost - 0.5);
  let options = found.filter((o) => !found.some((p) => p !== o && better(p, o)));
  // Doublons pratiques : même durée et même coût à peu près
  options = options.filter((o, i) => !options.slice(0, i).some((p) =>
    Math.abs(p.totalS - o.totalS) < 120 && Math.abs(p.cost - o.cost) < 1));
  options.sort((a, b) => a.totalS - b.totalS || a.cost - b.cost);
  if (options.length > 3) options = [options[0], options[Math.floor(options.length / 2)], options[options.length - 1]];

  // Moins de 3 options : on propose d'autres arrêts (bornes différentes) s'ils restent raisonnables
  const fastest = options[0];
  if (fastest.stops.length) {
    const used = new Set();
    const maxS = fastest.totalS + Math.max(1800, fastest.totalS * 0.12);
    for (let tries = 0; options.length < 3 && tries < 3; tries++) {
      for (const o of options) for (const s of o.stops) if (!s.station.forced) used.add(s.station.id);
      const r = planCharging(profile, stations.filter((s) => !used.has(s.id)), veh, { ...cfg, secondsPerEuro: 120 });
      if (!r.ok || r.totalS > maxS) break;
      const sig = r.stops.map((s) => s.station.id + '@' + s.departSoc).join('|');
      if (options.some((o) => o.sig === sig)) break;
      options.push({ ...r, sig, alternative: true });
    }
  }

  const minCost = Math.min(...options.map((o) => o.cost));
  const cheapest = options.find((o) => o.cost === minCost);
  options.forEach((o, i) => {
    if (options.length === 1) o.label = 'Meilleur itinéraire';
    else if (i === 0) o.label = o === cheapest ? 'Le plus rapide et le moins cher' : 'Le plus rapide';
    else if (o === cheapest) o.label = 'Le moins cher';
    else o.label = o.alternative ? 'Autre arrêt' : 'Compromis';
  });
  return { ok: true, options };
}
