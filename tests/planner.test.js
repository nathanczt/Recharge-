import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VEHICLES, flatConsumption, chargeTime } from '../js/energy.js';
import { resampleRoute, projectStations, clusterStations, encodePolyline } from '../js/geo.js';
import { buildProfile, planCharging } from '../js/planner.js';

const veh = VEHICLES.kona64;

// Autoroute rectiligne plein est le long du 46e parallèle, ~ lengthKm, à 130 km/h
function straightRoute(lengthKm) {
  const coords = [];
  const segs = [];
  const degPerKm = 1 / (111.32 * Math.cos(46 * Math.PI / 180));
  for (let k = 0; k <= lengthKm; k++) coords.push([46, 2 + k * degPerKm]);
  for (let k = 0; k < lengthKm; k++) segs.push({ dist: 1000, dur: 1000 / (130 / 3.6) });
  return { coords, segs, degPerKm };
}

const baseCfg = {
  capKWh: 64, startSoc: 90, minSoc: 10, arrivalSoc: 15, maxCharge: 80,
  stopOverheadS: 240, secondsPerEuro: 0, detourKWhPerKm: 0.16,
};

function setup(lengthKm, stationKms, opts = {}) {
  const { coords, segs, degPerKm } = straightRoute(lengthKm);
  const { points, chunks } = resampleRoute(coords, segs, 1000);
  const profile = buildProfile(veh, points, chunks, null, null, { maxSpeedKmh: 130, tempC: 15, ...opts });
  const raw = stationKms.map((km, i) => ({
    id: 's' + i, lat: 46.001, lon: 2 + km * degPerKm, powerKW: 150, price: 0.5, operatorKey: 'op' + i,
  }));
  const stations = projectStations(raw, points, 3000);
  return { profile, stations };
}

test('calibration Kona 64 kWh réaliste', () => {
  const c110 = flatConsumption(veh, 110);
  const c130 = flatConsumption(veh, 130);
  assert.ok(c110 > 15 && c110 < 18.5, `110 km/h: ${c110}`);
  assert.ok(c130 > 19.5 && c130 < 23, `130 km/h: ${c130}`);
  assert.ok(flatConsumption(veh, 110, 0) > c110, 'le froid augmente la conso');
  const t = chargeTime(veh, 64, 10, 80, 150) / 60;
  assert.ok(t > 35 && t < 55, `10→80 % : ${t} min`);
  assert.ok(chargeTime(veh, 64, 10, 80, 50) > chargeTime(veh, 64, 10, 80, 150));
});

test('trajet court : aucun arrêt', () => {
  const { profile, stations } = setup(150, [75]);
  const r = planCharging(profile, stations, veh, baseCfg);
  assert.ok(r.ok);
  assert.equal(r.stops.length, 0);
  assert.ok(r.arriveSoc > 15);
});

test('trajet long : arrêts nécessaires et SoC respecté', () => {
  const kms = [];
  for (let k = 40; k < 800; k += 40) kms.push(k);
  const { profile, stations } = setup(800, kms);
  const r = planCharging(profile, stations, veh, baseCfg);
  assert.ok(r.ok);
  assert.ok(r.stops.length >= 2, `stops ${r.stops.length}`);
  for (const s of r.stops) {
    assert.ok(s.arriveSoc >= 10 - 1e-6, `arrivée ${s.arriveSoc}`);
    assert.ok(s.departSoc <= 80);
  }
  assert.ok(r.arriveSoc >= 15 - 1e-6);
  assert.ok(r.cost > 0);
  assert.ok(Math.abs(r.totalS - r.driveS - r.chargeS) < 1e-6);
});

test('trou trop grand : échec avec diagnostic', () => {
  const { profile, stations } = setup(700, [100, 650]);
  const r = planCharging(profile, stations, veh, baseCfg);
  assert.equal(r.ok, false);
  assert.ok(r.farthestKm >= 100 && r.farthestKm < 650);
});

test('borne imposée respectée', () => {
  const kms = [50, 100, 150, 200, 250, 300, 350, 400];
  const { profile, stations } = setup(450, kms);
  stations.find((s) => s.id === 's0').forced = true;
  const r = planCharging(profile, stations, veh, baseCfg);
  assert.ok(r.ok);
  assert.equal(r.stops[0].station.id, 's0');
});

test('mode économique préfère la borne moins chère', () => {
  const { profile, stations } = setup(380, [180, 190]);
  stations[0].price = 0.79;
  stations[1].price = 0.39;
  const r = planCharging(profile, stations, veh, { ...baseCfg, secondsPerEuro: 600 });
  assert.ok(r.ok);
  assert.equal(r.stops.length, 1);
  assert.equal(r.stops[0].station.id, 's1');
});

test('regroupement et encodage polyline', () => {
  const c = clusterStations([
    { lat: 46, lon: 2, powerKW: 50, operatorKey: 'a' },
    { lat: 46.0005, lon: 2, powerKW: 150, operatorKey: 'a' },
    { lat: 46.0005, lon: 2, powerKW: 250, operatorKey: 'b' },
  ]);
  assert.equal(c.length, 2);
  assert.equal(encodePolyline([[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]), '_p~iF~ps|U_ulLnnqC_mqNvxq`@');
});

test('performance : 1000 km et 400 bornes en moins de 2 s', () => {
  const kms = [];
  for (let k = 3; k < 1000; k += 2.5) kms.push(k);
  const { profile, stations } = setup(1000, kms);
  const t0 = performance.now();
  const r = planCharging(profile, stations, veh, { ...baseCfg, secondsPerEuro: 120 });
  const ms = performance.now() - t0;
  assert.ok(r.ok);
  assert.ok(ms < 2000, `${ms} ms`);
  for (const s of r.stops) assert.ok(s.departSoc - s.arriveSoc >= 9.9, 'pas de micro-arrêt');
});
