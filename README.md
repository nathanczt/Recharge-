# ⚡ Recharge

Planificateur d'itinéraires pour voiture électrique, pensé pour le téléphone (installable comme une app).
Profils inclus : **Hyundai Kona Electric 64 kWh (2018-2023)** et **Kona 65 kWh (2023+)**.

## Ce qui le distingue

- **Consommation précise** : modèle physique (aérodynamique, roulement, pente réelle du trajet, vent et
  température prévus à l'heure de passage, chauffage/clim, masse des passagers, santé de la batterie),
  avec un coefficient de correction pour coller à ta conduite.
- **Arrêts optimaux** : programmation dynamique sur toutes les bornes du corridor, en tenant compte de la
  courbe de charge de la voiture, de la puissance de la borne, du froid, du détour et du temps perdu à chaque arrêt.
- **Choix des bornes** : puissance minimale, réseaux à éviter, bornes à imposer / exclure / remplacer,
  Superchargeurs Tesla ouverts à tous.
- **Coût du trajet** : prix au kWh par réseau (modifiables avec tes abonnements), pertes de charge incluses.
  Trois priorités : Rapide, Équilibré (1 € ≈ 2 min), Économique (1 € ≈ 12 min).
- **Navigation** : chaque arrêt s'ouvre dans Google Maps ou Waze, ou tout le trajet d'un coup dans Google Maps.

## Données (gratuites, sans compte)

| Besoin | Service |
|---|---|
| Adresses | Base Adresse Nationale (IGN) + Photon (OSM) |
| Itinéraire | OSRM |
| Relief | Open-Meteo Elevation |
| Météo | Open-Meteo Forecast (16 jours) |
| Bornes | OpenStreetMap (Overpass), ou Open Charge Map avec une clé gratuite |
| Carte | OpenStreetMap / CARTO |

## Lancer en local

```bash
npm start        # sert le site sur http://localhost:8080
npm test         # tests du modèle et du planificateur
```

Aucune compilation : HTML, CSS et modules JavaScript.

## Mise en ligne

Le workflow `.github/workflows/pages.yml` publie le site sur GitHub Pages à chaque push sur `main`.
À activer une fois : *Settings → Pages → Source : GitHub Actions*.

## Structure

- `js/energy.js` : profils véhicules, consommation, courbes de charge
- `js/planner.js` : profil énergétique du trajet et optimisation des arrêts
- `js/geo.js` : géométrie (rééchantillonnage, projection des bornes)
- `js/api.js` : adresses, itinéraire, relief, météo
- `js/stations.js` / `js/operators.js` : bornes et réseaux
- `js/app.js` : interface
