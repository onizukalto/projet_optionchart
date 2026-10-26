"""Réglages de l'application, lus dans les variables d'environnement (fichier .env avec Docker)."""

import os
from pathlib import Path

FREEFLOW_API_KEY = os.environ.get("FREEFLOW_API_KEY", "")

# "freeflow" = vraies données ; "demo" = données inventées (pour tester sans clé)
MODE = os.environ.get("MODE", "freeflow" if FREEFLOW_API_KEY else "demo")

# Sous-jacents proposés dans l'interface, et le future associé à chacun
SYMBOLES = ["QQQ", "NDX", "SPY", "SPX"]
SYMBOLE_DEFAUT = os.environ.get("SYMBOLE", "QQQ")
FUTURES = {
    # sous-jacent : (racine du micro-future, clé FreeFlow /public/macro, ticker Yahoo, pas de la grille)
    "QQQ": ("MNQ", "nq", "MNQ=F", 100),
    "NDX": ("MNQ", "nq", "MNQ=F", 100),
    "SPY": ("MES", "es", "MES=F", 25),
    "SPX": ("MES", "es", "MES=F", 25),
}

# Plan B si FreeFlow ne répond pas pour les bougies : le même sous-jacent sur Yahoo
YAHOO_SOUS_JACENT = {"QQQ": "QQQ", "NDX": "^NDX", "SPY": "SPY", "SPX": "^GSPC"}

# Rafraîchissement des données "lentes" (bougies, net drift...). Le snapshot, lui,
# arrive en continu par le flux SSE de FreeFlow (ne consomme pas de quota).
REFRESH_SECONDES = int(os.environ.get("REFRESH_SECONDES", "60"))

# Limite d'appels FreeFlow par minute (plan standard : 15, premium : 100). On garde une marge.
LIMITE_APPELS_MINUTE = int(os.environ.get("LIMITE_APPELS_MINUTE", "13"))

# Sweeps et blocks d'options : prime minimale (en $) pour qu'un ordre soit affiché en bulle
PRIME_MIN_FLUX = float(os.environ.get("PRIME_MIN_FLUX", "25000"))

# On ne garde que les strikes à +/- ZONE autour du prix pour les walls et les graphiques
ZONE = float(os.environ.get("ZONE", "0.06"))

# Flux RSS ajoutés à la section News (séparés par des virgules). Vide = FreeFlow seulement.
NEWS_RSS = [u.strip() for u in os.environ.get(
    "NEWS_RSS",
    "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114,"
    "https://feeds.content.dowjones.io/public/rss/mw_topstories",
).split(",") if u.strip()]

# Dossier où l'historique de la séance est sauvegardé (monté en volume avec Docker)
DATA_DIR = Path(os.environ.get("DATA_DIR", Path(__file__).resolve().parent.parent / "data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)

# Mot de passe optionnel pour protéger le dashboard une fois en ligne
DASHBOARD_USER = os.environ.get("DASHBOARD_USER", "")
DASHBOARD_PASSWORD = os.environ.get("DASHBOARD_PASSWORD", "")