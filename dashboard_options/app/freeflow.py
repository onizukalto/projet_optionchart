"""
Client de l'API FreeFlow : une petite fonction par route utilisée,
plus un limiteur d'appels partagé par tout le programme.
"""

import json
import threading
import time
from collections import deque
from datetime import datetime
from zoneinfo import ZoneInfo

import requests

from . import config

BASE_URL = "https://www.free-flow.site"
NY = ZoneInfo("America/New_York")


class ErreurFreeFlow(Exception):
    pass


MESSAGES = {
    401: "Clé API invalide ou révoquée",
    402: "Pas d'abonnement actif",
    422: "Symbole ou échéance mal formé",
    429: "Limite d'appels dépassée",
    503: "Source FreeFlow indisponible",
}


# ------------------------------------------------------------------
# Limiteur : au plus LIMITE_APPELS_MINUTE appels sur 60 s glissantes
# ------------------------------------------------------------------
class Limiteur:
    def __init__(self, par_minute):
        self.par_minute = par_minute
        self.appels = deque()
        self.verrou = threading.Lock()

    def attendre(self):
        while True:
            with self.verrou:
                maintenant = time.time()
                while self.appels and maintenant - self.appels[0] > 60:
                    self.appels.popleft()
                if len(self.appels) < self.par_minute:
                    self.appels.append(maintenant)
                    return
                attente = 60 - (maintenant - self.appels[0]) + 0.1
            time.sleep(attente)

    def utilises(self):
        with self.verrou:
            return sum(1 for t in self.appels if time.time() - t <= 60)


LIMITEUR = Limiteur(config.LIMITE_APPELS_MINUTE)


# routes qui répondent parfois très lentement : on n'attend pas 2 x 30 s, on passe au plan B
ROUTES_LENTES = {"/public/chart": 12, "/public/macro": 12}


def appel(route, **params):
    """GET sur une route FreeFlow, avec 2 essais si le serveur est lent (1 seul pour les routes lentes)."""
    delai = ROUTES_LENTES.get(route, 30)
    essais = 1 if route in ROUTES_LENTES else 2
    for essai in range(essais):
        LIMITEUR.attendre()
        try:
            r = requests.get(BASE_URL + route, params=params,
                             headers={"X-API-Key": config.FREEFLOW_API_KEY}, timeout=delai)
            break
        except requests.exceptions.RequestException as erreur:
            if essai == essais - 1:
                raise ErreurFreeFlow(f"{route} : pas de réponse ({erreur.__class__.__name__})")
            time.sleep(2)

    if r.status_code != 200:
        raise ErreurFreeFlow(f"{route} : HTTP {r.status_code} {MESSAGES.get(r.status_code, '')}")
    return r.json()


def flux(route, **params):
    """
    Flux SSE : renvoie les messages un par un, au fur et à mesure qu'ils arrivent.
    La connexion compte pour UN appel ; les messages suivants sont gratuits.
    """
    LIMITEUR.attendre()
    with requests.get(BASE_URL + route, params=params, stream=True,
                      headers={"X-API-Key": config.FREEFLOW_API_KEY, "Accept": "text/event-stream"},
                      timeout=(10, 120)) as r:
        if r.status_code != 200:
            raise ErreurFreeFlow(f"{route} : HTTP {r.status_code} {MESSAGES.get(r.status_code, '')}")
        for ligne in r.iter_lines(decode_unicode=True):
            if ligne and ligne.startswith("data:"):     # les lignes ": keepalive" sont ignorées
                yield json.loads(ligne[5:].strip())


# ------------------------------------------------------------------
# Routes utilisées
# ------------------------------------------------------------------
_cache_echeances = {}


def echeances(symbole):
    """Échéances à venir (la liste ne change qu'une fois par jour : on la garde en mémoire)."""
    aujourd_hui = datetime.now(NY).strftime("%Y-%m-%d")
    cache = _cache_echeances.get(symbole)
    if not cache or cache["jour"] != aujourd_hui:
        liste = appel("/public/expirations", symbol=symbole)["expirations"]
        _cache_echeances[symbole] = {"jour": aujourd_hui, "liste": liste}
    return [e for e in _cache_echeances[symbole]["liste"] if e >= aujourd_hui]


def snapshot(symbole, echeance):
    return appel("/public/snapshot/oi-gex", symbol=symbole, exp=echeance)


def flux_snapshot(symbole, echeance):
    return flux("/public/stream/oi-gex", symbol=symbole, exp=echeance)


def bougies(symbole):
    donnees = appel("/public/chart", symbol=symbole, interval="1m")
    return [{"time": int(b["time"]), "open": b["open"], "high": b["high"],
             "low": b["low"], "close": b["close"], "volume": b.get("volume", 0)}
            for b in donnees.get("candles", [])]


def macro():
    """{'nq': {'prix': ..., 'variation': ...}, 'es': ..., 'vix': ...}"""
    return {i["key"]: {"prix": i.get("price"), "variation": i.get("change_pct")}
            for i in appel("/public/macro")["indicators"]}


def net_drift(symbole, echeance):
    return appel("/public/net-drift", symbol=symbole, exp=echeance)


def gex_topo(symbole):
    return appel("/public/gex-topo", symbol=symbole)


def metriques(symbole, echeance):
    return appel("/public/metrics", symbol=symbole, exp=echeance)


# Certaines routes refusent (HTTP 422) des paramètres hors limites. On essaie des variantes
# de plus en plus simples, et on retient celle que FreeFlow accepte pour les appels suivants.
_variante_ok = {}


def appel_adaptatif(route, variantes):
    depart = _variante_ok.get(route, 0)
    derniere_erreur = None
    for i in range(depart, len(variantes)):
        try:
            resultat = appel(route, **variantes[i])
            if _variante_ok.get(route) != i:
                _variante_ok[route] = i
                print(f"[freeflow] {route} : paramètres acceptés = {variantes[i]}", flush=True)
            return resultat
        except ErreurFreeFlow as e:
            if "422" not in str(e):
                raise
            derniere_erreur = e
    _variante_ok.pop(route, None)
    raise derniere_erreur


def sweeps(symbole, echeance, fenetre_min, prime_min, top=40):
    """Sweeps et blocks : les gros ordres agressifs sur les options (un ordre par ligne)."""
    base = {"symbol": symbole, "window_min": max(1, min(240, int(fenetre_min)))}
    variantes = [
        {**base, "exp": echeance, "min_prem": int(prime_min), "top": min(int(top), 50)},
        {**base, "exp": echeance, "min_prem": int(prime_min)},
        {**base, "exp": echeance},
        {**base, "min_prem": int(prime_min)},
        base,
        {"symbol": symbole},
    ]
    donnees = appel_adaptatif("/public/sweeps", variantes)
    if isinstance(donnees, list):
        return donnees
    return donnees.get("sweeps") or donnees.get("data") or donnees.get("items") or []


def flux_par_strike(symbole, echeance):
    """Prime nette achetée / vendue par strike, sur la plus longue fenêtre acceptée (idéalement toute la séance)."""
    base = {"symbol": symbole, "exp": echeance}
    return appel_adaptatif("/public/flow", [{**base, "window_min": 390}, {**base, "window_min": 240},
                                           {**base, "window_min": 120}, base])


def news():
    return appel("/public/news").get("articles", [])