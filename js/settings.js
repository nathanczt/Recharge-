// Réglages utilisateur persistés dans le navigateur.

const KEY = 'recharge.settings.v1';

export const DEFAULTS = {
  vehicle: 'kona65', // Kona Electric 2023+ (seul modèle proposé)
  batteryHealth: 100, // % de capacité restante
  persons: 1, // conducteur compris
  bags: 0,
  factor: 100, // correction de conso en %
  maxSpeed: 130,
  speedFactor: 1.12, // OSRM sous-estime les vitesses réelles
  tempOverride: null, // °C imposés, sinon météo
  startSoc: 90,
  minSoc: 10,
  arrivalSoc: 15,
  maxCharge: 80,
  minPowerKW: 50,
  corridorKm: 3,
  stopOverheadMin: 4,
  avoidTolls: false,
  allowTesla: true,
  source: 'osm',
  ocmKey: '',
  defaultPrice: 0.55,
  prices: {}, // { operatorKey: €/kWh }
  excludedOps: [], // operatorKey
  excludedStations: [], // id
};

export function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
    return { ...DEFAULTS, ...raw, vehicle: DEFAULTS.vehicle };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* stockage indisponible */ }
}

export function loadJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}

export function saveJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}
