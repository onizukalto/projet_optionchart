"""
niveaux_ff.py — Récupère les niveaux d'options via l'API FreeFlow, les convertit
en prix NQ et génère le script Pine "Options Levels" (copié dans le presse-papiers).

Usage :
    python niveaux_ff.py            calcul normal
    python niveaux_ff.py --debug    enregistre aussi les réponses brutes de l'API
                                          dans le dossier debug_freeflow/

Clé API : NE PAS l'écrire dans le code. Dans le terminal :
    export FREEFLOW_API_KEY="ff_ta_cle"
(à ajouter dans ~/.zshrc pour ne pas la retaper à chaque fois)

Ce que FreeFlow fournit directement : call/put wall, gamma flip, vol trigger, max pain,
max call/put OI, vanna wall/flip, charm zone (+ le prix du NQ via /public/macro).
Ce qu'il ne fournit pas (delta wall/flip, vega wall, HVL) : complété avec le calcul
Black-Scholes de niveaux.py (Yahoo, ~15 min de retard), si COMPLETER_AVEC_YAHOO = True.

Appels par lancement : 4 à FreeFlow (limite du plan standard : 15 / minute).
"""

import json
import os
import sys
from datetime import datetime
from pathlib import Path

import requests

import niveaux as calcul_local

# ---------------------------------------------------------------
# Réglages
# ---------------------------------------------------------------
BASE_URL = "https://www.free-flow.site"
SYMBOLE = "QQQ"              # "QQQ" ou "NDX" (NDX : strikes déjà proches du NQ)
COMPLETER_AVEC_YAHOO = True  # compléter les niveaux absents de FreeFlow
DEBUG = "--debug" in sys.argv


# ---------------------------------------------------------------
# 1. Appels à l'API
# ---------------------------------------------------------------
class ErreurFreeFlow(Exception):
    pass


MESSAGES_ERREUR = {
    401: "Clé API invalide ou révoquée.",
    402: "Pas d'abonnement actif sur ce compte.",
    422: "Symbole ou date d'échéance mal formé.",
    429: "Limite d'appels dépassée (15 / minute). Attends une minute.",
    503: "Source de données FreeFlow indisponible. Réessaie dans un instant.",
}


def get_cle():
    cle = os.environ.get("FREEFLOW_API_KEY")
    if not cle:
        raise ErreurFreeFlow(
            "Clé API introuvable. Dans le terminal : export FREEFLOW_API_KEY=\"ff_ta_cle\""
        )
    return cle


def appel(route, **params):
    """Appelle une route FreeFlow et renvoie le JSON (2 essais si le serveur est lent)."""
    for essai in range(2):
        try:
            r = requests.get(
                BASE_URL + route,
                params=params,
                headers={"X-API-Key": get_cle()},
                timeout=30,
            )
            break
        except requests.exceptions.Timeout:
            if essai == 1:
                raise ErreurFreeFlow(f"{route} → le serveur n'a pas répondu à temps (2 essais).")
            print(f"   {route} lent à répondre, nouvel essai...")
    if r.status_code != 200:
        message = MESSAGES_ERREUR.get(r.status_code, "Erreur inattendue.")
        raise ErreurFreeFlow(f"{route} → HTTP {r.status_code} : {message} ({r.text[:200]})")

    donnees = r.json()
    if DEBUG:
        dossier = Path("debug_freeflow")
        dossier.mkdir(exist_ok=True)
        nom = route.strip("/").replace("/", "_") + ".json"
        (dossier / nom).write_text(json.dumps(donnees, indent=2))
    return donnees


def strike_de(point):
    """Les murs sont des objets {strike, ...} ; renvoie le strike, ou None."""
    if isinstance(point, dict):
        return point.get("strike")
    return point


# ---------------------------------------------------------------
# 2. Récupération des niveaux FreeFlow
# ---------------------------------------------------------------
def prochaine_echeance(symbole):
    echeances = appel("/public/expirations", symbol=symbole)["expirations"]
    aujourd_hui = datetime.now(calcul_local.NY).strftime("%Y-%m-%d")
    futures = [e for e in echeances if e >= aujourd_hui]
    return futures[0]


def get_prix_nq_freeflow():
    """Prix du NQ via /public/macro (rafraîchi ~30 s). Repli sur Yahoo si absent."""
    try:
        for indicateur in appel("/public/macro")["indicators"]:
            if indicateur["key"] == "nq" and indicateur.get("price"):
                return indicateur["price"]
    except ErreurFreeFlow as erreur:
        print(f"   (Prix NQ FreeFlow indisponible : {erreur})")
    print("   → prix du NQ pris sur Yahoo (~10 min de retard)")
    return calcul_local.get_prix_nq()


def get_niveaux_freeflow(symbole=SYMBOLE):
    """Renvoie (spot, échéance, niveaux en prix du symbole)."""
    echeance = prochaine_echeance(symbole)

    walls = appel("/public/walls", symbol=symbole, exp=echeance)
    vc = appel("/public/vanna-charm", symbol=symbole, exp=echeance)

    vanna = vc.get("vanna_walls") or {}
    charm = vc.get("charm_zones") or {}

    niveaux = {
        "call_wall": strike_de(walls.get("call_wall")),
        "put_wall": strike_de(walls.get("put_wall")),
        "gamma_flip": walls.get("gamma_flip"),
        "vol_trigger": walls.get("vol_trigger"),
        "max_pain": walls.get("max_pain"),
        "vanna_wall": strike_de(vanna.get("peak")),
        "vanna_flip": vanna.get("flip"),
        "charm_zone": strike_de(charm.get("peak")),
        "max_call_oi": strike_de(walls.get("call_oi_wall")),
        "max_put_oi": strike_de(walls.get("put_oi_wall")),
    }
    niveaux = {nom: float(v) for nom, v in niveaux.items() if v is not None}
    return walls["spot"], echeance, niveaux


# ---------------------------------------------------------------
# 3. Assemblage (même format de sortie que niveaux.get_niveaux)
# ---------------------------------------------------------------
def get_niveaux():
    """Renvoie (spot, prix NQ, niveaux en prix du symbole, niveaux en NQ)."""
    spot, echeance, niveaux_src = get_niveaux_freeflow()
    prix_nq = get_prix_nq_freeflow()
    sources = {nom: "FreeFlow" for nom in niveaux_src}

    if COMPLETER_AVEC_YAHOO:
        try:
            spot_y, options = calcul_local.get_chaine(SYMBOLE)
            opts = calcul_local.preparer_options(options)
            locaux = calcul_local.calculer_niveaux(opts, spot_y)
            for nom, valeur in locaux.items():
                if nom not in niveaux_src:
                    # on recale le niveau Yahoo sur le spot FreeFlow (les deux n'ont pas le même retard)
                    niveaux_src[nom] = valeur * spot / spot_y
                    sources[nom] = "Yahoo"
        except Exception as erreur:
            print(f"(Complément Yahoo impossible : {erreur})")

    niveaux_nq = {nom: calcul_local.convertir_en_nq(v, spot, prix_nq) for nom, v in niveaux_src.items()}
    get_niveaux.derniere_info = {"echeance": echeance, "sources": sources}
    return spot, prix_nq, niveaux_src, niveaux_nq


# ---------------------------------------------------------------
# Programme principal
# ---------------------------------------------------------------
def main():
    print(f"Récupération des niveaux FreeFlow ({SYMBOLE})...")
    try:
        spot, prix_nq, niveaux_src, niveaux_nq = get_niveaux()
    except ErreurFreeFlow as erreur:
        print(f"❌ {erreur}")
        sys.exit(1)

    info = get_niveaux.derniere_info
    print(f"\n{SYMBOLE} : {spot:.2f}  |  NQ : {prix_nq:.2f}  |  échéance : {info['echeance']}")
    print(f"{datetime.now(calcul_local.NY):%Y-%m-%d %H:%M} (heure de New York)\n")
    print(f"  {'niveau':<12} {SYMBOLE:>9} {'NQ':>11}   source")
    for nom in niveaux_nq:
        print(f"  {nom:<12} {niveaux_src[nom]:>9.2f} {niveaux_nq[nom]:>11.2f}   {info['sources'][nom]}")

    script_pine = calcul_local.generer_pine(niveaux_nq)
    with open("options_levels.pine", "w") as f:
        f.write(script_pine)

    print("\nScript Pine enregistré dans options_levels.pine")
    if calcul_local.copier(script_pine):
        print("✅ Script Pine copié dans le presse-papiers :")
        print("   Pine Editor → Cmd + A → Cmd + V → Save")
    if DEBUG:
        print("🔎 Réponses brutes de l'API enregistrées dans debug_freeflow/")


if __name__ == "__main__":
    main()