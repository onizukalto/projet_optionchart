# Options Desk

Dashboard noir façon terminal de flux, pour QQQ, NDX, SPY et SPX, avec conversion des niveaux
en micro-future (MNQ pour QQQ/NDX, MES pour SPY/SPX).

## Les 4 sections (rail à gauche)

| Section | Contenu |
|---|---|
| **Desk** | tuiles de métriques ; chart 1 min (sous-jacent ou micro-future) avec niveaux, lignes *major long/short γ*, ±1σ, grille du future, **nuages de gamma** et **bulles de flux d'options** ; **Tape options** (les bulles sur une chart à part) ; panneau Niveaux / Métriques / News ; **smile** de volatilité ; profils GEX, OI, **flux par strike**, DEX, Vanna, Charm ; net drift, **VIX intraday**, **IV vs volatilité réalisée** |
| **Topology** | surface 3D strike × échéance × GEX (vert = γ positif, rouge = γ négatif) + carte 2D + poids de chaque échéance |
| **News** | fil FreeFlow + flux RSS, recherche, filtres Macro / Important |
| **Apprendre** | une fiche par niveau et métrique, avec un graphique sur les données du moment et un exemple |

En haut : choix du sous-jacent et de l'échéance (0DTE, 1DTE, 2DTE…). Après 16 h 15 (New York) et le week-end,
le 0DTE est l'échéance de la **prochaine** séance.

En bas du rail : **Calibrer** (cible) et **Copier Pine** (presse-papier).

## Conversion vers MNQ / MES (le ratio)

Les niveaux sont multipliés par un ratio future / sous-jacent. Par ordre de priorité :

1. **calibré** : tu entres deux prix relevés au même moment (ex. 723 QQQ = 29 940 MNQ) avec le bouton cible.
   Valable jusqu'au changement de contrat (roll), où il s'efface tout seul. À refaire ~1 fois par semaine
   (l'écart future / indice diminue un peu chaque jour).
2. **synchro** : mesuré sur les bougies 1 min du sous-jacent (FreeFlow) et du future (Yahoo) **à la même minute**, en séance.
3. **dernier connu** : le dernier ratio synchro, sauvegardé dans `data/ratios.json`.
4. **direct** : prix du future ÷ prix du sous-jacent à l'instant. Faux hors séance (le future bouge la nuit,
   pas le QQQ) : c'est ce qui décalait les niveaux avant.

La source utilisée est affichée à côté du ratio, en haut à droite.

## Comment les données circulent

```
FreeFlow ─ flux SSE (snapshot en continu, gratuit après connexion) ─┐
FreeFlow ─ bougies, net drift, sweeps, flux par strike, topologie,  ├─► service.py ─► /api/etat ─► navigateur (toutes les 2 s)
           métriques (toutes les 60 s, ~4,5 appels/min)              │
FreeFlow ─ prix NQ / ES / VIX (60 s) · news (60 s) · Yahoo (MNQ/MES) ┘
```

- Un **abonnement** est ouvert par couple (sous-jacent, échéance) affiché, et se ferme seul
  3 minutes après que plus personne ne le regarde.
- Un **limiteur** garantit qu'on ne dépasse jamais `LIMITE_APPELS_MINUTE`.
- Le navigateur demande `/api/etat` toutes les 2 s, mais le serveur ne renvoie les données
  que si elles ont changé (sinon une réponse de quelques octets).
- L'historique des nuages, de l'IV et des sweeps est sauvegardé dans `data/` (il survit à un redémarrage),
  ainsi que le VIX (`vix.json`), le calibrage (`calibrage.json`) et le dernier ratio (`ratios.json`).
- Hors séance, rien n'est ajouté à l'historique (le snapshot ne bouge plus) : pas de fausses bougies.

## Fichiers

```
app/config.py      réglages (lus dans .env)
app/freeflow.py    appels à l'API FreeFlow + limiteur + flux SSE
app/calculs.py     profils, niveaux, métriques, ±1σ, contrat front (MNQZ6…)
app/service.py     abonnements, boucles de mise à jour, état envoyé au navigateur
app/news.py        fil d'actualités (FreeFlow + RSS)
app/demo.py        données inventées (MODE=demo)
app/main.py        serveur web (+ /api/calibrage)
static/app.js          cœur : état, navigation, catalogues des niveaux et métriques
static/graphiques.js   petits graphiques SVG (barres, courbes, jauges)
static/desk.js         section Desk (chart, nuages, bulles, tape, smile, VIX, IV)
static/topology.js     section Topology (Plotly, chargé à la demande)
static/news.js         section News
static/apprendre.js    section Apprendre
```

## Lancer en local (sans Docker)

```bash
pip install -r requirements.txt
MODE=demo uvicorn app.main:app --reload --port 8000     # données de démo
uvicorn app.main:app --port 8000                         # vraies données (clé dans FREEFLOW_API_KEY)
```

Puis http://localhost:8000

## Lancer avec Docker

```bash
cp .env.example .env        # puis mets ta clé dans .env
docker compose up -d --build
docker compose logs -f
```

Puis http://localhost:8765

## Déployer sur un serveur (VPS)

1. Un petit VPS Linux suffit (1 vCPU / 1-2 Go).
2. `curl -fsSL https://get.docker.com | sh`
3. `scp -r dashboard_options utilisateur@IP_DU_SERVEUR:~`
4. Sur le serveur : `cd dashboard_options && cp .env.example .env && vim .env`
   → ta clé **et un mot de passe** (`DASHBOARD_USER` / `DASHBOARD_PASSWORD`).
5. `docker compose up -d --build`, puis `http://IP_DU_SERVEUR:8765`

## TradingView

Le bouton **Copier Pine** (en bas du rail) donne le script Pine Script avec les niveaux convertis en micro-future
(MNQ ou MES selon le sous-jacent) : Pine Editor → Cmd+A → Cmd+V → Save.
