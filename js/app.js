import { VEHICLES, flatConsumption } from './energy.js';
import { resampleRoute, projectStations, clusterStations, haversine } from './geo.js';
import { buildProfile, planOptions } from './planner.js';
import { geocode, route, elevations, weatherAlong } from './api.js';
import { fetchOsmStations, fetchOcmStations } from './stations.js';
import { OPERATORS, DEFAULT_PRICE } from './operators.js';
import { loadSettings, saveSettings, loadJSON, saveJSON, DEFAULTS } from './settings.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let settings = loadSettings();
const state = {
  from: loadJSON('recharge.from', null),
  to: loadJSON('recharge.to', null),
  trip: null, // données réseau en cache : route, points, chunks, elev, weather, stations
  forced: new Set(),
  result: null,
  candidates: [],
  abort: null,
};

/* ================= Formatage ================= */

const fmtDur = (s) => {
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
};
const fmtClock = (d) => d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
const fmtEuro = (v) => v.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
const fmtKm = (km) => `${Math.round(km)} km`;
const pct = (v) => `${Math.round(v)} %`;

function toast(msg, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}

/* ================= Carte ================= */

const map = L.map('map', { zoomControl: false, attributionControl: true }).setView([46.6, 2.4], 6);
const dark = matchMedia('(prefers-color-scheme: dark)').matches;
L.tileLayer(`https://{s}.basemaps.cartocdn.com/rastertiles/${dark ? 'dark_all' : 'voyager'}/{z}/{x}/{y}{r}.png`, {
  maxZoom: 19, subdomains: 'abcd',
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
}).addTo(map);
const layers = {
  route: L.layerGroup().addTo(map),
  candidates: L.layerGroup().addTo(map),
  stops: L.layerGroup().addTo(map),
  ends: L.layerGroup().addTo(map),
};

function endMarker(p, color) {
  return L.marker([p.lat, p.lon], {
    icon: L.divIcon({ className: '', html: `<div class="end-marker" style="background:${color}"></div>`, iconSize: [18, 18], iconAnchor: [9, 9] }),
  });
}

function drawEnds() {
  layers.ends.clearLayers();
  if (state.from) endMarker(state.from, '#16a34a').addTo(layers.ends);
  if (state.to) endMarker(state.to, '#dc2626').addTo(layers.ends);
}

function fitMap(latlngs) {
  const mobile = innerWidth < 900;
  const sheet = $('#sheet');
  const sheetH = mobile ? Math.min(sheet.getBoundingClientRect().height, innerHeight * 0.4) : 0;
  map.fitBounds(L.latLngBounds(latlngs), {
    paddingTopLeft: [mobile ? 20 : 440, 60],
    paddingBottomRight: [20, mobile ? sheetH + 20 : 20],
  });
}

/* ================= Panneau ================= */

const sheet = $('#sheet');
$('#sheetHandle').addEventListener('click', () => {
  sheet.dataset.state = sheet.dataset.state === 'open' ? 'peek' : 'open';
});

function showView(id) {
  for (const v of ['formView', 'loadingView', 'resultView']) $('#' + v).hidden = v !== id;
}

/* ================= Formulaire ================= */

const fromInput = $('#fromInput');
const toInput = $('#toInput');
const sugg = $('#suggestions');

function setPlace(which, place) {
  state[which] = place;
  (which === 'from' ? fromInput : toInput).value = place ? place.label : '';
  saveJSON('recharge.' + which, place);
  drawEnds();
  if (state.from && state.to) fitMap([[state.from.lat, state.from.lon], [state.to.lat, state.to.lon]]);
  else if (place) map.setView([place.lat, place.lon], 11);
}

let suggTimer, suggAbort, suggFor, suggItems = [], suggSel = -1;
function onPlaceInput(e) {
  const input = e.target;
  suggFor = input === fromInput ? 'from' : 'to';
  state[suggFor] = null;
  clearTimeout(suggTimer);
  const q = input.value.trim();
  if (q.length < 3) { sugg.hidden = true; return; }
  suggTimer = setTimeout(async () => {
    suggAbort?.abort();
    suggAbort = new AbortController();
    try {
      const c = map.getCenter();
      suggItems = await geocode(q, suggAbort.signal, { lat: c.lat, lon: c.lng });
      suggSel = -1;
      renderSugg();
    } catch (err) {
      if (err.name !== 'AbortError') toast('Recherche d\'adresse impossible');
    }
  }, 250);
}
function renderSugg() {
  if (!suggItems.length) { sugg.hidden = true; return; }
  sugg.innerHTML = suggItems.map((s, i) =>
    `<li role="option" data-i="${i}" aria-selected="${i === suggSel}">${esc(s.label)}<small>${esc(s.sub)}</small></li>`).join('');
  sugg.style.top = suggFor === 'from' ? '52px' : '100%';
  sugg.hidden = false;
}
function pickSugg(i) {
  const s = suggItems[i];
  if (!s) return;
  setPlace(suggFor, s);
  sugg.hidden = true;
  if (suggFor === 'from' && !state.to) toInput.focus();
  else (document.activeElement)?.blur();
}
sugg.addEventListener('pointerdown', (e) => {
  const li = e.target.closest('li');
  if (li) { e.preventDefault(); pickSugg(+li.dataset.i); }
});
for (const input of [fromInput, toInput]) {
  input.addEventListener('input', onPlaceInput);
  input.addEventListener('focus', () => { sheet.dataset.state = 'open'; });
  input.addEventListener('blur', () => setTimeout(() => { sugg.hidden = true; }, 150));
  input.addEventListener('keydown', (e) => {
    if (sugg.hidden) { if (e.key === 'Enter' && state.from && state.to) compute(); return; }
    if (e.key === 'ArrowDown') { suggSel = Math.min(suggItems.length - 1, suggSel + 1); renderSugg(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { suggSel = Math.max(0, suggSel - 1); renderSugg(); e.preventDefault(); }
    else if (e.key === 'Enter') { pickSugg(Math.max(0, suggSel)); e.preventDefault(); }
    else if (e.key === 'Escape') sugg.hidden = true;
  });
}

$('#locateBtn').addEventListener('click', () => {
  if (!navigator.geolocation) return toast('Géolocalisation indisponible');
  toast('Localisation…', 2000);
  navigator.geolocation.getCurrentPosition(
    (pos) => setPlace('from', { label: 'Ma position', sub: '', lat: pos.coords.latitude, lon: pos.coords.longitude }),
    () => toast('Position refusée ou indisponible'),
    { enableHighAccuracy: true, timeout: 10000 },
  );
});

$('#swapBtn').addEventListener('click', () => {
  const f = state.from;
  setPlace('from', state.to);
  setPlace('to', f);
});

// Les 4 pourcentages de batterie demandés dans le formulaire (mémorisés)
const socInput = $('#socInput');
const pctRefresh = [];
function bindPct(id, key) {
  const input = $('#' + id + 'Input');
  const out = $('#' + id + 'Out');
  const upd = () => { out.textContent = input.value + ' %'; };
  const load = () => { input.value = settings[key]; upd(); };
  input.addEventListener('input', () => { upd(); settings[key] = +input.value; saveSettings(settings); });
  pctRefresh.push(load);
  load();
}
bindPct('soc', 'startSoc');
bindPct('arrSoc', 'arrivalSoc');
bindPct('maxCharge', 'maxCharge');
bindPct('minSoc', 'minSoc');

function localNow() {
  const d = new Date(Date.now() - new Date().getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}
$('#departInput').value = localNow();

const speedSelect = $('#speedSelect');
speedSelect.value = String(settings.maxSpeed);
speedSelect.addEventListener('change', () => { settings.maxSpeed = +speedSelect.value; saveSettings(settings); });

const tolls = $('#tollsInput');
tolls.checked = settings.avoidTolls;
tolls.addEventListener('change', () => { settings.avoidTolls = tolls.checked; saveSettings(settings); });

function renderCarHint() {
  const v = VEHICLES[settings.vehicle];
  $('#carHint').textContent = `${v.name} · ${(v.usableKWh * settings.batteryHealth / 100).toFixed(1)} kWh utiles`;
}
renderCarHint();

if (state.from) fromInput.value = state.from.label;
if (state.to) toInput.value = state.to.label;
drawEnds();
if (state.from && state.to) fitMap([[state.from.lat, state.from.lon], [state.to.lat, state.to.lon]]);

$('#goBtn').addEventListener('click', () => compute());
$('#backBtn').addEventListener('click', () => {
  // Depuis le détail d'une proposition : retour à la liste des propositions
  const r = state.result;
  if (r && r.view === 'detail' && r.plan.ok && r.plan.options.length > 1) {
    r.view = 'list';
    showSelected();
    $('#sheet').scrollTop = 0;
    return;
  }
  showView('formView');
});

/* ================= Calcul ================= */

const STEPS = [
  ['route', 'Itinéraire'],
  ['elev', 'Relief'],
  ['weather', 'Météo (température, vent)'],
  ['stations', 'Bornes le long du trajet'],
  ['plan', 'Optimisation des arrêts'],
];
function stepState(id, cls, note) {
  const li = $(`#steps li[data-id="${id}"]`);
  if (!li) return;
  li.className = cls;
  li.querySelector('small').textContent = note || '';
}

$('#cancelBtn').addEventListener('click', () => {
  state.abort?.abort();
  showView('formView');
});

function routeKey() {
  return [state.from, state.to].map((p) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`).join('|') + '|' + settings.avoidTolls;
}
function stationsKey() {
  return [settings.source, settings.corridorKm, settings.allowTesla, settings.ocmKey].join('|');
}

async function compute({ keepForced = false } = {}) {
  if (!state.from || !state.to) {
    toast('Choisis un départ et une arrivée dans la liste');
    return;
  }
  if (!keepForced) state.forced.clear();
  state.abort?.abort();
  const ac = new AbortController();
  state.abort = ac;
  const signal = ac.signal;
  const departure = new Date($('#departInput').value || Date.now());

  showView('loadingView');
  sheet.dataset.state = 'open';
  $('#steps').innerHTML = STEPS.map(([id, label]) => `<li data-id="${id}">${label}<small></small></li>`).join('');

  try {
    const rk = routeKey();
    let trip = state.trip && state.trip.routeKey === rk ? state.trip : null;

    // 1. Itinéraire
    stepState('route', 'active');
    if (!trip) {
      const r = await route([state.from, state.to], { avoidTolls: settings.avoidTolls }, signal);
      const stepM = Math.max(300, r.distance / 1500);
      const { points, chunks } = resampleRoute(r.coords, r.segs, stepM);
      trip = { routeKey: rk, route: r, points, chunks };
    }
    stepState('route', 'done', `${fmtKm(trip.route.distance / 1000)} · ${fmtDur(trip.route.duration)} sans recharge`);
    drawRoute(trip);

    // 2. Relief
    stepState('elev', 'active');
    if (trip.elev === undefined) {
      try {
        trip.elev = await elevations(trip.points, signal, (f) => stepState('elev', 'active', `${Math.round(f * 100)} %`));
      } catch (e) {
        if (signal.aborted) throw e;
        trip.elev = null;
      }
    }
    if (trip.elev) {
      const { up, down } = climb(trip.elev);
      stepState('elev', 'done', `+${up} m / −${down} m`);
    } else stepState('elev', 'warn', 'Indisponible : calcul sur terrain plat');

    // 3. Météo
    stepState('weather', 'active');
    const wk = departure.toISOString().slice(0, 13);
    if (settings.tempOverride != null) {
      stepState('weather', 'done', `Température imposée : ${settings.tempOverride} °C (vent ignoré)`);
    } else {
      if (trip.weatherKey !== wk) {
        try {
          trip.weather = await weatherAlong(trip.points, departure, signal);
        } catch (e) {
          if (signal.aborted) throw e;
          trip.weather = null;
        }
        trip.weatherKey = wk;
      }
      if (trip.weather) {
        const s = trip.weather.summary();
        stepState('weather', 'done', `${Math.round(s.min)} à ${Math.round(s.max)} °C au départ, vent pris en compte`);
      } else stepState('weather', 'warn', 'Prévision indisponible : 15 °C sans vent');
    }

    // 4. Bornes
    stepState('stations', 'active');
    const sk = stationsKey();
    if (trip.stationsKey !== sk) {
      const corridorM = settings.corridorKm * 1000;
      const opts = { allowTesla: settings.allowTesla, ocmKey: settings.ocmKey };
      let raw;
      if (settings.source === 'ocm' && settings.ocmKey) {
        raw = await fetchOcmStations(trip.points, corridorM, opts, signal);
      } else {
        raw = await fetchOsmStations(trip.points, corridorM, opts, signal,
          (f) => stepState('stations', 'active', `${Math.round(f * 100)} %`));
      }
      trip.stations = projectStations(clusterStations(raw), trip.points, corridorM * 1.2);
      trip.stationsKey = sk;
    }
    stepState('stations', 'done', `${trip.stations.length} sites compatibles CCS`);
    state.trip = trip;

    // 5. Optimisation
    stepState('plan', 'active');
    await new Promise((r) => setTimeout(r, 30));
    runPlan(departure);
  } catch (e) {
    if (e.name === 'AbortError') return;
    console.error(e);
    const li = $('#steps li.active');
    if (li) { li.className = 'warn'; li.querySelector('small').textContent = e.message; }
    toast('Erreur : ' + e.message, 6000);
    $('#cancelBtn').textContent = 'Retour';
  }
}

function climb(elev) {
  let up = 0, down = 0;
  for (let i = 1; i < elev.length; i++) {
    const d = elev[i] - elev[i - 1];
    if (d > 0) up += d; else down -= d;
  }
  return { up: Math.round(up), down: Math.round(down) };
}

function stationPrice(s) {
  if (settings.prices[s.operatorKey] != null) return settings.prices[s.operatorKey];
  const op = OPERATORS.find((o) => o.key === s.operatorKey);
  return op ? op.price : settings.defaultPrice ?? DEFAULT_PRICE;
}

function vehicleCfg() {
  const veh = VEHICLES[settings.vehicle];
  return { veh, capKWh: veh.usableKWh * settings.batteryHealth / 100 };
}

function runPlan(departure, { keepView = false } = {}) {
  const trip = state.trip;
  const { veh, capKWh } = vehicleCfg();
  const opts = {
    maxSpeedKmh: settings.maxSpeed,
    speedFactor: settings.speedFactor,
    extraMassKg: settings.extraMassKg,
    factor: settings.factor / 100,
    tempC: settings.tempOverride,
  };
  const weather = settings.tempOverride == null ? trip.weather : null;
  const profile = buildProfile(veh, trip.points, trip.chunks, trip.elev, weather, opts);

  const excludedOps = new Set(settings.excludedOps);
  const excludedSt = new Set(settings.excludedStations);
  const candidates = trip.stations
    .filter((s) => state.forced.has(s.id) || (s.powerKW >= settings.minPowerKW && !excludedOps.has(s.operatorKey) && !excludedSt.has(s.id)))
    .map((s) => ({ ...s, price: stationPrice(s), forced: state.forced.has(s.id) }));
  state.candidates = candidates;

  const cfg = {
    capKWh,
    startSoc: +socInput.value,
    minSoc: settings.minSoc,
    arrivalSoc: settings.arrivalSoc,
    maxCharge: settings.maxCharge,
    stopOverheadS: settings.stopOverheadMin * 60,
    detourKWhPerKm: flatConsumption(veh, 50, 15) / 100,
  };
  const t0 = performance.now();
  const plan = planOptions(profile, candidates, veh, cfg);
  console.info('Planification', Math.round(performance.now() - t0), 'ms', candidates.length, 'bornes', plan.options.length, 'options');
  // Garde le même type d'option sélectionné après un recalcul (borne imposée, exclue…)
  const prevLabel = state.result?.plan.ok ? state.result.plan.options[state.result.selected]?.label : null;
  const keep = plan.options.findIndex((o) => o.label === prevLabel);
  const view = keepView && state.result ? state.result.view : (plan.options.length > 1 ? 'list' : 'detail');
  state.result = { plan, selected: keep >= 0 ? keep : 0, profile, departure, cfg, view };
  showSelected();
}

// Itinéraire actuellement affiché (ou l'échec)
function currentRes() {
  const { plan, selected } = state.result;
  return plan.ok ? plan.options[selected] : plan;
}

function showSelected() {
  drawCandidates();
  renderResult();
}

/* ================= Rendu carte ================= */

function drawRoute(trip) {
  layers.route.clearLayers();
  const ll = trip.route.coords;
  L.polyline(ll, { color: '#0f766e', weight: 9, opacity: 0.25 }).addTo(layers.route);
  L.polyline(ll, { color: dark ? '#2dd4bf' : '#0f766e', weight: 4 }).addTo(layers.route);
  fitMap(ll);
}

function powerColor(kw) {
  if (kw >= 150) return '#7c3aed';
  if (kw >= 100) return '#2563eb';
  return '#0891b2';
}

function stationPopup(s) {
  const forced = state.forced.has(s.id);
  return `<b>${esc(s.name)}</b><br>${esc(s.operator)} · ${Math.round(s.powerKW)} kW${s.powerKnown ? '' : ' (estimé)'}` +
    `<br>${s.points > 1 ? s.points + ' points de charge · ' : ''}${fmtEuro(s.price)}/kWh` +
    (s.priceText ? `<br><small>Tarif affiché : ${esc(s.priceText)}</small>` : '') +
    (s.hours ? `<br><small>Horaires : ${esc(s.hours)}</small>` : '') +
    `<br><small>km ${Math.round(state.trip.points[s.idx].d / 1000)} · à ${(s.offsetM / 1000).toFixed(1)} km du trajet · ${esc(s.source)}</small>` +
    `<div class="popup-actions">` +
    (forced ? `<button class="small-btn" data-act="unforce" data-id="${esc(s.id)}">Ne plus imposer</button>`
      : `<button class="small-btn accent" data-act="force" data-id="${esc(s.id)}">S'arrêter ici</button>`) +
    `<button class="small-btn" data-act="exclude" data-id="${esc(s.id)}">Exclure</button>` +
    `<a class="small-btn" target="_blank" rel="noopener" href="${gmaps(s)}">Itinéraire</a></div>`;
}

function drawCandidates() {
  layers.candidates.clearLayers();
  layers.stops.clearLayers();
  const res = currentRes();
  const { plan, view } = state.result;
  const shown = !res.ok ? [] : view === 'list' ? plan.options : [res];
  const stopIds = new Set(shown.flatMap((o) => o.stops.map((s) => s.station.id)));
  for (const s of state.candidates) {
    if (stopIds.has(s.id)) continue;
    L.circleMarker([s.lat, s.lon], {
      radius: s.powerKW >= 150 ? 6 : 5, color: '#fff', weight: 1.5, fillColor: powerColor(s.powerKW), fillOpacity: 0.9,
    }).bindPopup(() => stationPopup(s)).addTo(layers.candidates);
  }
  const seen = new Set();
  shown.forEach((o, k) => {
    const oi = view === 'list' ? k : state.result.selected;
    o.stops.forEach((stop, i) => {
      const s = stop.station;
      if (seen.has(s.id)) return;
      seen.add(s.id);
      const txt = view === 'list' ? OPT_LETTERS[oi] : i + 1;
      L.marker([s.lat, s.lon], {
        icon: L.divIcon({ className: '', html: `<div class="stop-marker opt-${view === 'list' ? oi : 0}">${txt}</div>`, iconSize: [28, 28], iconAnchor: [14, 14] }),
        zIndexOffset: 1000,
      }).bindPopup(() => stationPopup(s)).addTo(layers.stops);
    });
  });
}

const OPT_LETTERS = ['A', 'B', 'C'];

map.getContainer().addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  stationAction(b.dataset.act, b.dataset.id);
  map.closePopup();
});

function stationAction(act, id) {
  if (act === 'force') state.forced.add(id);
  else if (act === 'unforce') state.forced.delete(id);
  else if (act === 'exclude') {
    state.forced.delete(id);
    if (!settings.excludedStations.includes(id)) settings.excludedStations.push(id);
    saveSettings(settings);
    toast('Borne exclue (réactivable dans les réglages)');
  } else if (act === 'swap') {
    const [oldId, newId] = id.split('>');
    state.forced.delete(oldId);
    state.forced.add(newId);
  }
  runPlan(state.result.departure, { keepView: true });
}

/* ================= Rendu résultats ================= */

const gmaps = (p) => `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lon}&travelmode=driving`;
const waze = (p) => `https://waze.com/ul?ll=${p.lat},${p.lon}&navigate=yes`;

function fullTripLink(stops) {
  const wp = stops.slice(0, 9).map((s) => `${s.station.lat},${s.station.lon}`).join('|');
  return `https://www.google.com/maps/dir/?api=1&origin=${state.from.lat},${state.from.lon}` +
    `&destination=${state.to.lat},${state.to.lon}&travelmode=driving` + (wp ? `&waypoints=${encodeURIComponent(wp)}` : '');
}

function renderResult() {
  const { plan, selected, profile, departure, cfg } = state.result;
  const res = currentRes();
  showView('resultView');
  $('#resultTitle').textContent = `${state.from.label} → ${state.to.label}`;
  const body = $('#resultBody');

  if (!res.ok) {
    body.innerHTML = `<div class="error-box"><b>Trajet impossible avec ces réglages.</b><br>
      Impossible d'aller au-delà du km ${Math.round(res.farthestKm)} : aucune borne compatible n'est atteignable ensuite.</div>
      <p class="meta">Pistes : augmente la charge maximale, baisse la puissance minimale des bornes, élargis le corridor
      de recherche ou réduis la vitesse max. Source utilisée : ${settings.source === 'ocm' ? 'Open Charge Map' : 'OpenStreetMap'}.</p>
      <div class="actions-row"><button class="small-btn accent" id="openSettings2">Ouvrir les réglages</button></div>`;
    $('#openSettings2').onclick = openSettings;
    return;
  }

  if (state.result.view === 'list') {
    body.innerHTML = optionsHTML(plan.options, departure);
    body.querySelectorAll('[data-opt]').forEach((b) => {
      const open = () => {
        state.result.selected = +b.dataset.opt;
        state.result.view = 'detail';
        showSelected();
        $('#sheet').scrollTop = 0;
      };
      b.onclick = open;
      b.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };
    });
    return;
  }

  const arrival = new Date(departure.getTime() + res.totalS * 1000);
  const avg = res.energyKWh / res.distKm * 100;
  const tempTxt = settings.tempOverride != null ? `${settings.tempOverride} °C`
    : state.trip.weather ? (() => { const s = state.trip.weather.summary(); const a = Math.round(s.min), b = Math.round(s.max); return a === b ? `${a} °C` : `${a} à ${b} °C`; })() : '15 °C (par défaut)';

  const optHead = plan.options.length > 1
    ? `<div class="opt-head"><span class="opt-badge opt-${selected}">${OPT_LETTERS[selected]}</span> <span class="grow">${esc(res.label)}</span>
      <button class="small-btn" id="toListBtn">‹ Autres itinéraires</button></div>` : '';
  let html = optHead + tilesHTML(res, departure) + `
  <p class="meta"><b>${fmtKm(res.distKm)}</b> · conduite ${fmtDur(res.driveS)} · conso moyenne <b>${avg.toFixed(1)} kWh/100</b>
   · ${tempTxt}${state.trip.elev ? ` · relief +${climb(state.trip.elev).up} m` : ''}</p>
  ${chartSVG(res, profile, state.trip.elev, cfg)}
  <div class="actions-row">
    <a class="small-btn accent" target="_blank" rel="noopener" href="${fullTripLink(res.stops)}">Ouvrir dans Google Maps</a>
    <button class="small-btn" id="recalcBtn">Recalculer</button>
  </div>
  <ol class="timeline">
    <li class="tl-item tl-start"><span class="tl-badge">A</span>
      <span class="tl-time">${fmtClock(departure)}</span> · <span class="tl-name">${esc(state.from.label)}</span>
      <div class="tl-sub">Départ avec ${pct(cfg.startSoc)}</div></li>`;

  let prevKm = 0, prevT = 0;
  res.stops.forEach((stop, i) => {
    const s = stop.station;
    const legKm = stop.km - prevKm;
    const legS = stop.arriveT - prevT;
    const arr = new Date(departure.getTime() + stop.arriveT * 1000);
    const dep = new Date(arr.getTime() + stop.chargeS * 1000);
    html += `<li class="tl-item"><span class="tl-badge">${i + 1}</span>
      <div class="leg">↓ ${fmtKm(legKm)} · ${fmtDur(legS)}</div>
      <span class="tl-time">${fmtClock(arr)}</span> · <span class="tl-name">${esc(s.name)}</span>
      ${s.forced ? '<span class="badge">imposée</span>' : ''}
      <div class="tl-sub">${esc(s.operator)} · ${Math.round(s.powerKW)} kW${s.powerKnown ? '' : '<span class="badge warn">puissance estimée</span>'} · km ${Math.round(stop.km)}${s.offsetM > 400 ? ` · détour ${(s.offsetM / 1000).toFixed(1)} km` : ''}</div>
      <div class="stop-card">
        <div class="stop-stats">
          <span>🔋 ${pct(stop.arriveSoc)} → <b>${pct(stop.departSoc)}</b></span>
          <span>⏱️ <b>${fmtDur(stop.chargeS)}</b> (repart ${fmtClock(dep)})</span>
          <span>⚡ ${stop.kWh.toFixed(1)} kWh</span>
          <span>💶 <b>${fmtEuro(stop.cost)}</b> (${fmtEuro(s.price)}/kWh)</span>
        </div>
        <div class="stop-actions">
          <a class="small-btn accent" target="_blank" rel="noopener" href="${gmaps(s)}">Google Maps</a>
          <a class="small-btn" target="_blank" rel="noopener" href="${waze(s)}">Waze</a>
          <button class="small-btn" data-alts="${i}">Autres bornes</button>
          ${s.forced ? `<button class="small-btn" data-sact="unforce" data-id="${esc(s.id)}">Libérer</button>` : ''}
          <button class="small-btn" data-sact="exclude" data-id="${esc(s.id)}">Exclure</button>
        </div>
        <div class="alts" id="alts-${i}" hidden></div>
      </div></li>`;
    prevKm = stop.km; prevT = stop.arriveT + stop.chargeS;
  });

  html += `<li class="tl-item tl-end"><span class="tl-badge">B</span>
    <div class="leg">↓ ${fmtKm(res.distKm - prevKm)} · ${fmtDur(res.totalS - prevT)}</div>
    <span class="tl-time">${fmtClock(arrival)}</span> · <span class="tl-name">${esc(state.to.label)}</span>
    <div class="tl-sub">Arrivée avec ${pct(res.arriveSoc)}</div></li></ol>
    <p class="meta">Les prix sont des estimations basées sur tes tarifs par réseau (réglages). Bornes : ${state.candidates.length} candidates ·
    ${settings.source === 'ocm' && settings.ocmKey ? 'Open Charge Map' : 'OpenStreetMap'}. Touche une borne sur la carte pour l'imposer ou l'exclure.</p>`;
  body.innerHTML = html;

  $('#toListBtn')?.addEventListener('click', () => $('#backBtn').click());
  $('#recalcBtn').onclick = () => compute({ keepForced: true });
  body.querySelectorAll('[data-sact]').forEach((b) => { b.onclick = () => stationAction(b.dataset.sact, b.dataset.id); });
  body.querySelectorAll('[data-alts]').forEach((b) => { b.onclick = () => toggleAlts(+b.dataset.alts); });
}

function tilesHTML(res, departure) {
  const arrival = new Date(departure.getTime() + res.totalS * 1000);
  return `<div class="tiles">
    <div class="tile"><b>${fmtDur(res.totalS)}</b><span>Arrivée ${fmtClock(arrival)}${arrival.toDateString() !== departure.toDateString() ? ' (J+1)' : ''}</span></div>
    <div class="tile"><b>${fmtEuro(res.cost)}</b><span>Recharges · ${Math.round(res.gridKWh)} kWh</span></div>
    <div class="tile"><b>${res.stops.length} arrêt${res.stops.length > 1 ? 's' : ''}</b><span>${fmtDur(res.chargeS)} de recharge</span></div>
    <div class="tile"><b>${pct(res.arriveSoc)}</b><span>Batterie à l'arrivée</span></div>
  </div>`;
}

// Liste des propositions : une carte par itinéraire, à toucher pour voir le détail
function optionsHTML(options, departure) {
  const fastest = options[0];
  const cards = options.map((o, i) => {
    const dt = o.totalS - fastest.totalS;
    const de = o.cost - fastest.cost;
    const diff = i === 0 ? '' : `<p class="rc-diff">${dt >= 60 ? '+' + fmtDur(dt) : 'même durée'} · ${Math.abs(de) < 0.01 ? 'même prix' : (de < 0 ? '−' : '+') + fmtEuro(Math.abs(de))} par rapport à A</p>`;
    const via = o.stops.length ? 'via ' + o.stops.map((s) => esc(s.station.name)).join(', ') : 'sans recharge';
    return `<div class="route-card" role="button" tabindex="0" data-opt="${i}">
      <div class="rc-head"><span class="opt-badge opt-${i}">${OPT_LETTERS[i]}</span>
        <div class="rc-title"><b>${esc(o.label)}</b><span>${via}</span></div></div>
      ${tilesHTML(o, departure)}
      ${diff}
      <span class="rc-more">Voir le détail ›</span>
    </div>`;
  }).join('');
  return `<p class="options-title">${options.length} itinéraires proposés · touche-en un pour le détail</p>${cards}`;
}

function toggleAlts(i) {
  const box = $('#alts-' + i);
  if (!box.hidden) { box.hidden = true; return; }
  const res = currentRes();
  const stop = res.stops[i];
  const pts = state.trip.points;
  const used = new Set(res.stops.map((s) => s.station.id));
  const alts = state.candidates
    .filter((c) => !used.has(c.id) && Math.abs(pts[c.idx].d / 1000 - stop.km) <= 50)
    .sort((a, b) => Math.abs(pts[a.idx].d / 1000 - stop.km) - Math.abs(pts[b.idx].d / 1000 - stop.km))
    .slice(0, 8);
  box.innerHTML = alts.length ? alts.map((c) => {
    const dk = Math.round(pts[c.idx].d / 1000 - stop.km);
    return `<div class="alt"><div class="alt-info"><b>${esc(c.name)}</b>${esc(c.operator)} · ${Math.round(c.powerKW)} kW · ${fmtEuro(c.price)}/kWh · ${dk >= 0 ? '+' : ''}${dk} km</div>
      <button class="small-btn" data-swap="${esc(stop.station.id)}>${esc(c.id)}">Choisir</button></div>`;
  }).join('') : '<p class="meta">Aucune autre borne compatible à ±50 km.</p>';
  box.querySelectorAll('[data-swap]').forEach((b) => { b.onclick = () => stationAction('swap', b.dataset.swap); });
  box.hidden = false;
}

function chartSVG(res, profile, elev, cfg) {
  const W = 360, H = 120, padB = 14, padT = 6;
  const pts = profile.points;
  const total = pts[pts.length - 1].d;
  const x = (d) => (d / total * W).toFixed(1);
  const y = (soc) => (padT + (100 - Math.max(0, Math.min(100, soc))) / 100 * (H - padT - padB)).toFixed(1);
  const step = Math.max(1, Math.floor(pts.length / 400));
  const stopAt = new Map(res.stops.map((s) => [s.station.idx, s]));
  let path = `M0,${y(cfg.startSoc)}`;
  for (let i = 1; i < pts.length; i++) {
    const s = stopAt.get(i);
    if (s) {
      path += ` L${x(pts[i].d)},${y(s.arriveSoc)} L${x(pts[i].d)},${y(s.departSoc)}`;
    } else if (i % step === 0 || i === pts.length - 1) {
      path += ` L${x(pts[i].d)},${y(res.socAt[i])}`;
    }
  }
  let elevPath = '';
  if (elev) {
    let lo = Infinity, hi = -Infinity;
    for (const e of elev) { if (e < lo) lo = e; if (e > hi) hi = e; }
    const span = Math.max(200, hi - lo);
    const ey = (e) => (H - padB - (e - lo) / span * (H - padB) * 0.45).toFixed(1);
    elevPath = `M0,${H - padB}`;
    for (let i = 0; i < pts.length; i += step) elevPath += ` L${x(pts[i].d)},${ey(elev[i])}`;
    elevPath += ` L${W},${H - padB} Z`;
  }
  const stopLines = res.stops.map((s) => `<line class="stopline" x1="${x(pts[s.station.idx].d)}" x2="${x(pts[s.station.idx].d)}" y1="${padT}" y2="${H - padB}"/>`).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Niveau de batterie le long du trajet">
    ${elevPath ? `<path class="elev" d="${elevPath}"/>` : ''}
    <line class="reserve" x1="0" x2="${W}" y1="${y(cfg.minSoc)}" y2="${y(cfg.minSoc)}"/>
    ${stopLines}
    <path class="soc" d="${path}" vector-effect="non-scaling-stroke"/>
    <text x="2" y="${H - 2}">0 km</text><text x="${W - 2}" y="${H - 2}" text-anchor="end">${fmtKm(total / 1000)}</text>
    <text x="2" y="${padT + 8}">100 %</text>
  </svg>`;
}

/* ================= Réglages ================= */

$('#settingsBtn').addEventListener('click', openSettings);

function num(id, label, value, { min, max, step = 1, unit = '' } = {}) {
  return `<div class="field"><label for="${id}">${label} <output>${value}${unit}</output></label>
    <input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${value}" data-unit="${unit}"></div>`;
}

function openSettings() {
  const s = settings;
  const opRows = OPERATORS.map((o) => {
    const price = s.prices[o.key] ?? o.price;
    const excl = s.excludedOps.includes(o.key);
    return `<tr><td>${esc(o.name)}</td>
      <td><input type="number" step="0.01" min="0" max="2" data-price="${o.key}" value="${price}"> €</td>
      <td><input type="checkbox" data-excl="${o.key}" ${excl ? '' : 'checked'} aria-label="Utiliser ${esc(o.name)}"></td></tr>`;
  }).join('');

  $('#settingsBody').innerHTML = `
    <h3>Véhicule</h3>
    <p class="meta"><b>${esc(VEHICLES[s.vehicle].name)}</b> · ${VEHICLES[s.vehicle].usableKWh} kWh utiles · charge rapide jusqu'à ~100 kW</p>
    ${num('healthIn', 'État de santé batterie (SoH)', s.batteryHealth, { min: 70, max: 100, unit: ' %' })}
    ${num('massIn', 'Passagers et bagages (en plus du conducteur)', s.extraMassKg, { min: 0, max: 400, step: 10, unit: ' kg' })}

    <h3>Précision de la consommation</h3>
    ${num('factorIn', 'Correction (si tu consommes plus / moins que prévu)', s.factor, { min: 80, max: 130, unit: ' %' })}
    <div class="calib" id="calib"></div>
    <div class="field" style="margin-top:14px"><label for="tempMode">Température</label><select id="tempMode">
      <option value="auto" ${s.tempOverride == null ? 'selected' : ''}>Prévisions météo le long du trajet (+ vent)</option>
      ${[-10, -5, 0, 5, 10, 15, 20, 25, 30, 35].map((t) => `<option value="${t}" ${s.tempOverride === t ? 'selected' : ''}>Imposer ${t} °C</option>`).join('')}
    </select></div>

    <p class="meta">Les % de batterie (départ, arrivée, charge maximum, minimum) se règlent directement sur l'écran principal.</p>

    <h3>Bornes</h3>
    ${num('minPowIn', 'Puissance minimale', s.minPowerKW, { min: 22, max: 150, step: 1, unit: ' kW' })}
    ${num('corrIn', 'Distance max. du trajet', s.corridorKm, { min: 1, max: 10, step: 0.5, unit: ' km' })}
    ${num('overIn', 'Temps perdu par arrêt (se garer, brancher, payer)', s.stopOverheadMin, { min: 0, max: 15, unit: ' min' })}
    <label class="check"><input type="checkbox" id="teslaIn" ${s.allowTesla ? 'checked' : ''}> Inclure les Superchargeurs Tesla ouverts à tous</label>

    <h3>Réseaux et prix (€/kWh)</h3>
    <p class="meta">Mets tes tarifs réels (abonnements, cartes). Décoche un réseau pour l'éviter.</p>
    <table class="ops"><tbody>${opRows}
      <tr><td><i>Autres opérateurs</i></td><td><input type="number" step="0.01" min="0" max="2" id="defPrice" value="${s.defaultPrice}"> €</td><td></td></tr>
    </tbody></table>
    ${s.excludedStations.length ? `<p class="meta">${s.excludedStations.length} borne(s) exclue(s). <button type="button" class="small-btn" id="clearExcl">Tout réactiver</button></p>` : ''}

    <h3>Source des bornes</h3>
    <div class="field"><label for="srcSel">Base de données</label><select id="srcSel">
      <option value="osm" ${s.source === 'osm' ? 'selected' : ''}>OpenStreetMap (sans clé)</option>
      <option value="ocm" ${s.source === 'ocm' ? 'selected' : ''}>Open Charge Map (clé API gratuite)</option>
    </select></div>
    <div class="field" id="ocmField" ${s.source === 'ocm' ? '' : 'hidden'}><label for="ocmKey">Clé API Open Charge Map</label>
      <input type="password" id="ocmKey" value="${esc(s.ocmKey)}" autocomplete="off" placeholder="openchargemap.org → Mon profil → Clés API"></div>

    <h3>Réinitialiser</h3>
    <button type="button" class="secondary" id="resetBtn">Remettre les réglages par défaut</button>
    <p class="meta" style="margin-top:16px">Données : © contributeurs OpenStreetMap, OSRM, Open-Meteo, Base Adresse Nationale, Photon. Modèle de conso physique (aéro, roulement, pente, vent, température, auxiliaires).</p>`;

  const body = $('#settingsBody');
  const bind = (id, fn) => body.querySelector('#' + id)?.addEventListener('input', (e) => {
    const out = e.target.closest('.field')?.querySelector('output');
    if (out) out.textContent = e.target.value + (e.target.dataset.unit || '');
    fn(e.target);
    saveSettings(settings);
    renderCalib();
    renderCarHint();
  });
  bind('healthIn', (el) => { settings.batteryHealth = +el.value; });
  bind('massIn', (el) => { settings.extraMassKg = +el.value; });
  bind('factorIn', (el) => { settings.factor = +el.value; });
  bind('tempMode', (el) => { settings.tempOverride = el.value === 'auto' ? null : +el.value; });
  bind('minPowIn', (el) => { settings.minPowerKW = +el.value; });
  bind('corrIn', (el) => { settings.corridorKm = +el.value; });
  bind('overIn', (el) => { settings.stopOverheadMin = +el.value; });
  bind('teslaIn', (el) => { settings.allowTesla = el.checked; });
  bind('defPrice', (el) => { settings.defaultPrice = +el.value || DEFAULT_PRICE; });
  bind('srcSel', (el) => { settings.source = el.value; $('#ocmField').hidden = el.value !== 'ocm'; });
  bind('ocmKey', (el) => { settings.ocmKey = el.value.trim(); });
  body.querySelectorAll('[data-price]').forEach((el) => el.addEventListener('input', () => {
    const v = parseFloat(el.value);
    if (!isNaN(v)) settings.prices[el.dataset.price] = v;
    saveSettings(settings);
  }));
  body.querySelectorAll('[data-excl]').forEach((el) => el.addEventListener('change', () => {
    const k = el.dataset.excl;
    settings.excludedOps = settings.excludedOps.filter((x) => x !== k);
    if (!el.checked) settings.excludedOps.push(k);
    saveSettings(settings);
  }));
  body.querySelector('#clearExcl')?.addEventListener('click', (e) => {
    settings.excludedStations = [];
    saveSettings(settings);
    e.target.closest('p').remove();
  });
  body.querySelector('#resetBtn').addEventListener('click', () => {
    if (!confirm('Remettre tous les réglages par défaut ?')) return;
    settings = { ...DEFAULTS, prices: {}, excludedOps: [], excludedStations: [] };
    saveSettings(settings);
    pctRefresh.forEach((f) => f());
    openSettings();
  });
  renderCalib();
  const dlg = $('#settingsDlg');
  if (!dlg.open) dlg.showModal();
}

function renderCalib() {
  const el = $('#calib');
  if (!el) return;
  const veh = VEHICLES[settings.vehicle];
  const o = { extraMassKg: settings.extraMassKg, factor: settings.factor / 100 };
  const speeds = [50, 90, 110, 130];
  const cap = veh.usableKWh * settings.batteryHealth / 100;
  const row = (t) => `<tr><td>${t} °C</td>${speeds.map((v) => `<td>${flatConsumption(veh, v, t, o).toFixed(1)}</td>`).join('')}</tr>`;
  const range = (v, t) => Math.round(cap * 0.8 / flatConsumption(veh, v, t, o) * 100);
  el.innerHTML = `<table><tr><th>kWh/100 km</th>${speeds.map((v) => `<th>${v} km/h</th>`).join('')}</tr>
    ${row(20)}${row(5)}${row(-5)}</table>
    <div style="margin-top:6px">Autonomie 90→10 % à 130 km/h : <b>${range(130, 20)} km</b> (20 °C) · <b>${range(130, 0)} km</b> (0 °C)</div>`;
}

$('#settingsDlg').addEventListener('close', () => {
  speedSelect.value = String(settings.maxSpeed);
  if (state.result && !$('#resultView').hidden) compute({ keepForced: true });
});

/* ================= PWA ================= */

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Pour le débogage
window.__recharge = { state, get settings() { return settings; }, haversine };
