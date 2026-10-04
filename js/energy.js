// Modèle physique de consommation et de recharge.
// Pur (aucune dépendance au DOM) : testable avec `node --test`.

export const VEHICLES = {
  kona65: {
    name: 'Hyundai Kona Electric 65 kWh (2023+)',
    usableKWh: 64.8,
    massKg: 1770,
    cda: 0.635, // Cx 0.27 × 2.35 m²
    crr: 0.0085,
    driveEff: 0.89,
    regenEff: 0.65,
    auxKW: 0.35,
    heatPump: true,
    curve: [[0, 70], [10, 95], [25, 100], [40, 85], [55, 72], [65, 62], [75, 50], [80, 40], [90, 22], [100, 7]],
    acMaxKW: 11,
  },
};

const G = 9.81;

export function airDensity(tempC) {
  return 1.293 * 273.15 / (273.15 + tempC);
}

// Puissance des auxiliaires (chauffage / clim / électronique) en kW
export function auxPower(v, tempC) {
  let p = v.auxKW;
  const cold = Math.max(0, 18 - tempC);
  p += cold * (v.heatPump ? 0.055 : 0.11);
  p += Math.max(0, tempC - 24) * 0.08;
  return p;
}

// Surconsommation batterie froide (résistance interne, densité de l'huile, pneus)
export function coldFactor(tempC) {
  return 1 + Math.max(0, 15 - tempC) * 0.006;
}

/**
 * Énergie prélevée sur la batterie (kWh) pour un tronçon.
 * @param {object} veh   profil véhicule
 * @param {object} seg   { distM, speedKmh, dhM, headwindMs, tempC }
 * @param {object} opts  { extraMassKg, factor }
 */
export function segmentEnergy(veh, seg, opts = {}) {
  const { distM, speedKmh, dhM = 0, headwindMs = 0, tempC = 15 } = seg;
  if (distM <= 0) return 0;
  const m = veh.massKg + 75 + (opts.extraMassKg || 0);
  const v = Math.max(1, speedKmh / 3.6);
  const vAir = v + headwindMs;
  const fAero = 0.5 * airDensity(tempC) * veh.cda * vAir * Math.abs(vAir);
  const fRoll = veh.crr * m * G;
  const eTrac = (fAero + fRoll) * distM + m * G * dhM; // J
  let eBat = eTrac > 0 ? eTrac / veh.driveEff : eTrac * veh.regenEff;
  // Arrêts/relances en ville : énergie cinétique partiellement perdue
  if (speedKmh < 70) eBat += (1 - speedKmh / 70) * 0.04 * (distM / 1000) * 3.6e6;
  let kWh = eBat / 3.6e6;
  kWh *= coldFactor(tempC);
  const hours = distM / 1000 / Math.max(5, speedKmh);
  kWh += auxPower(veh, tempC) * hours;
  return kWh * (opts.factor || 1);
}

// Conso en kWh/100 km sur le plat, sans vent (pour l'affichage)
export function flatConsumption(veh, speedKmh, tempC = 15, opts = {}) {
  return segmentEnergy(veh, { distM: 100000, speedKmh, tempC }, opts);
}

function interp(curve, x) {
  if (x <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i++) {
    const [x1, y1] = curve[i];
    if (x <= x1) {
      const [x0, y0] = curve[i - 1];
      return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
    }
  }
  return curve[curve.length - 1][1];
}

// Réduction de puissance quand la batterie est froide (sans préconditionnement de la batterie)
export function coldChargeFactor(tempC) {
  if (tempC >= 15) return 1;
  return Math.max(0.55, 1 - (15 - tempC) * 0.025);
}

export function chargePower(veh, soc, stationKW, tempC = 15) {
  const station = stationKW * 0.95;
  return Math.max(1, Math.min(interp(veh.curve, soc) * coldChargeFactor(tempC), station));
}

/** Temps de charge (secondes) de `fromSoc` à `toSoc` (%) */
export function chargeTime(veh, capKWh, fromSoc, toSoc, stationKW, tempC = 15) {
  if (toSoc <= fromSoc) return 0;
  let t = 0;
  const step = 0.5;
  for (let s = fromSoc; s < toSoc; s += step) {
    const ds = Math.min(step, toSoc - s);
    const p = chargePower(veh, s + ds / 2, stationKW, tempC);
    t += (capKWh * ds / 100) / p * 3600;
  }
  return t;
}

// Énergie facturée (au compteur de la borne), pertes de conversion incluses
export function gridEnergy(batteryKWh, stationKW) {
  return batteryKWh / (stationKW > 22 ? 0.93 : 0.88);
}
