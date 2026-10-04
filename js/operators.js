// Réseaux de recharge connus : normalisation des noms et tarifs par défaut (€/kWh, sans abonnement).
// Les prix sont indicatifs et modifiables dans les réglages.

export const OPERATORS = [
  { key: 'ionity', name: 'Ionity', match: /ionity/i, price: 0.59, dc: 350 },
  { key: 'tesla', name: 'Tesla Supercharger', match: /tesla|supercharg/i, price: 0.55, dc: 250 },
  { key: 'fastned', name: 'Fastned', match: /fastned/i, price: 0.59, dc: 300 },
  { key: 'electra', name: 'Electra', match: /electra/i, price: 0.49, dc: 300 },
  { key: 'allego', name: 'Allego', match: /allego/i, price: 0.59, dc: 300 },
  { key: 'total', name: 'TotalEnergies', match: /total/i, price: 0.55, dc: 175 },
  { key: 'izivia', name: 'Izivia', match: /izivia|corri-door|corridoor/i, price: 0.50, dc: 100 },
  { key: 'engie', name: 'Engie Vianeo', match: /engie|vianeo/i, price: 0.55, dc: 150 },
  { key: 'powerdot', name: 'Power Dot', match: /power ?dot/i, price: 0.55, dc: 150 },
  { key: 'zunder', name: 'Zunder', match: /zunder/i, price: 0.49, dc: 180 },
  { key: 'atlante', name: 'Atlante', match: /atlante/i, price: 0.55, dc: 150 },
  { key: 'leclerc', name: 'E.Leclerc', match: /leclerc/i, price: 0.39, dc: 150 },
  { key: 'lidl', name: 'Lidl', match: /lidl/i, price: 0.39, dc: 150 },
  { key: 'carrefour', name: 'Carrefour', match: /carrefour/i, price: 0.45, dc: 150 },
  { key: 'auchan', name: 'Auchan', match: /auchan/i, price: 0.45, dc: 100 },
  { key: 'intermarche', name: 'Intermarché', match: /intermarch|mousquetaires/i, price: 0.45, dc: 100 },
  { key: 'superu', name: 'Système U', match: /syst[eè]me u|super ?u\b|hyper ?u\b/i, price: 0.45, dc: 100 },
  { key: 'mcdo', name: 'McDonald\'s', match: /mcdonald/i, price: 0.49, dc: 50 },
  { key: 'freshmile', name: 'Freshmile', match: /freshmile/i, price: 0.50, dc: 50 },
  { key: 'shell', name: 'Shell Recharge', match: /shell/i, price: 0.59, dc: 150 },
  { key: 'bp', name: 'bp pulse', match: /\bbp\b|aral/i, price: 0.59, dc: 150 },
  { key: 'ewiva', name: 'Ewiva', match: /ewiva/i, price: 0.59, dc: 300 },
];

export const DEFAULT_PRICE = 0.55;

export function identifyOperator(...texts) {
  const t = texts.filter(Boolean).join(' | ');
  for (const op of OPERATORS) if (op.match.test(t)) return op;
  return null;
}

export function operatorKeyFor(...texts) {
  const op = identifyOperator(...texts);
  if (op) return op.key;
  const t = texts.find(Boolean);
  return t ? 'x:' + t.toLowerCase().trim() : 'x:inconnu';
}
