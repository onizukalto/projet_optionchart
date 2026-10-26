"""
niveaux.py — Calcule les niveaux d'options du QQQ (gamma, delta, vanna, vega,
charm, open interest, max pain), les convertit en prix NQ et copie la ligne
à coller dans l'indicateur Pine "Options Levels".

Usage :  python niveaux.py
Source : yfinance (gratuit, ~15 min de retard). Pour passer à Freeflow,
         il suffira de remplacer get_chaine() et get_prix_nq().

Attention : chaque outil (Vexity, SpotGamma, Freeflow...) a ses propres
définitions. Celles-ci sont des approximations standard et transparentes.
"""

import subprocess
from datetime import datetime
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
import yfinance as yf
from scipy.stats import norm

NY = ZoneInfo("America/New_York")
NB_ECHEANCES = 3      # nombre d'échéances d'options prises en compte
TAUX = 0.04           # taux sans risque (approximation)
ZONE_WALLS = 0.10     # on cherche les walls à +/- 10 % du prix
ZONE_FLIPS = 0.15     # on cherche les flips à +/- 15 % du prix


# ---------------------------------------------------------------
# 1. Récupération des données (seule partie à changer pour Freeflow)
# ---------------------------------------------------------------
def get_chaine(ticker="QQQ", nb_echeances=NB_ECHEANCES):
    t = yf.Ticker(ticker)
    spot = t.history(period="1d")["Close"].iloc[-1]

    morceaux = []
    for echeance in t.options[:nb_echeances]:
        chaine = t.option_chain(echeance)
        morceaux.append(chaine.calls.assign(type="call", expiration=echeance))
        morceaux.append(chaine.puts.assign(type="put", expiration=echeance))

    df = pd.concat(morceaux)
    df = df[["type", "expiration", "strike", "openInterest", "impliedVolatility", "volume"]]
    return spot, df.fillna(0)


def get_prix_nq():
    return yf.Ticker("MNQ=F").history(period="1d", interval="1m")["Close"].iloc[-1]


# ---------------------------------------------------------------
# 2. Black-Scholes : tous les greeks d'un coup
# ---------------------------------------------------------------
def greeks_bs(S, K, T, sigma, est_call, r=TAUX):
    racine_T = np.sqrt(T)
    d1 = (np.log(S / K) + (r + 0.5 * sigma**2) * T) / (sigma * racine_T)
    d2 = d1 - sigma * racine_T
    densite = norm.pdf(d1)

    delta_call = norm.cdf(d1)
    return {
        "delta": np.where(est_call, delta_call, delta_call - 1),
        "gamma": densite / (S * sigma * racine_T),
        "vega": S * densite * racine_T,
        "vanna": -densite * d2 / sigma,
        "charm": -densite * (2 * r * T - d2 * sigma * racine_T) / (2 * T * sigma * racine_T),
    }


def temps_restant(echeance):
    fin = datetime.strptime(echeance, "%Y-%m-%d").replace(hour=16, tzinfo=NY)
    secondes = (fin - datetime.now(NY)).total_seconds()
    return max(secondes, 3600) / (365 * 24 * 3600)


def preparer_options(options):
    opts = options[(options["openInterest"] > 0) & (options["impliedVolatility"] > 0.01)].copy()
    opts["T"] = opts["expiration"].apply(temps_restant)
    opts["est_call"] = opts["type"] == "call"
    # Convention "teneurs de marché" : + sur les calls, - sur les puts
    opts["signe"] = np.where(opts["est_call"], 1, -1)
    return opts


def expositions(opts, S):
    """Exposition des teneurs de marché, option par option, si le sous-jacent valait S."""
    g = greeks_bs(S, opts["strike"], opts["T"], opts["impliedVolatility"], opts["est_call"])
    contrats = opts["openInterest"] * 100
    return pd.DataFrame({
        "strike": opts["strike"],
        "type": opts["type"],
        "gex": g["gamma"] * contrats * S**2 * 0.01 * opts["signe"],   # $ par mouvement de 1 %
        "dex": g["delta"] * contrats * S,                              # $ de delta
        "vex": g["vanna"] * contrats * S * 0.01 * opts["signe"],       # $ de delta par point de vol
        "vegax": g["vega"] * contrats * 0.01 * opts["signe"],          # $ par point de vol
        "charmx": g["charm"] * contrats * S / 365 * opts["signe"],     # $ de delta par jour
    })


# ---------------------------------------------------------------
# 3. Les niveaux
# ---------------------------------------------------------------
def trouver_flip(opts, spot, colonne):
    """Prix où l'exposition totale change de signe (le plus proche du prix actuel)."""
    grille = np.linspace(spot * (1 - ZONE_FLIPS), spot * (1 + ZONE_FLIPS), 300)
    totaux = np.array([expositions(opts, p)[colonne].sum() for p in grille])
    idx = np.where(np.diff(np.sign(totaux)) != 0)[0]
    if len(idx) == 0:
        return None
    i = idx[np.argmin(np.abs(grille[idx] - spot))]
    # interpolation linéaire entre les deux points de la grille
    x0, x1, y0, y1 = grille[i], grille[i + 1], totaux[i], totaux[i + 1]
    return x0 - y0 * (x1 - x0) / (y1 - y0)


def max_pain(opts):
    """Strike où les acheteurs d'options perdent le plus à l'expiration (échéance la plus proche)."""
    proche = opts[opts["expiration"] == opts["expiration"].min()]
    calls, puts = proche[proche["est_call"]], proche[~proche["est_call"]]
    strikes = np.sort(proche["strike"].unique())
    pertes = [
        (calls["openInterest"] * np.maximum(p - calls["strike"], 0)).sum()
        + (puts["openInterest"] * np.maximum(puts["strike"] - p, 0)).sum()
        for p in strikes
    ]
    return strikes[int(np.argmin(pertes))]


def calculer_niveaux(opts, spot):
    expo = expositions(opts, spot)
    proches = expo[(expo["strike"] > spot * (1 - ZONE_WALLS)) & (expo["strike"] < spot * (1 + ZONE_WALLS))]
    par_strike = proches.groupby("strike")[["gex", "dex", "vex", "vegax", "charmx"]].sum()
    oi = opts[(opts["strike"] > spot * (1 - ZONE_WALLS)) & (opts["strike"] < spot * (1 + ZONE_WALLS))]

    niveaux = {
        # GEX
        "call_wall": proches[proches["type"] == "call"].groupby("strike")["gex"].sum().idxmax(),
        "put_wall": proches[proches["type"] == "put"].groupby("strike")["gex"].sum().idxmin(),
        "gamma_flip": trouver_flip(opts, spot, "gex"),
        # Settlement
        "vol_trigger": trouver_flip(opts[opts["expiration"] == opts["expiration"].min()], spot, "gex"),
        "max_pain": max_pain(opts),
        # DEX
        "delta_wall": par_strike["dex"].abs().idxmax(),
        "delta_flip": trouver_flip(opts, spot, "dex"),
        # VEX
        "vanna_wall": par_strike["vex"].abs().idxmax(),
        "vanna_flip": trouver_flip(opts, spot, "vex"),
        # VEGA
        "vega_wall": par_strike["vegax"].abs().idxmax(),
        # CHARM
        "charm_zone": par_strike["charmx"].abs().idxmax(),
        # OI
        "max_call_oi": oi[oi["est_call"]].groupby("strike")["openInterest"].sum().idxmax(),
        "max_put_oi": oi[~oi["est_call"]].groupby("strike")["openInterest"].sum().idxmax(),
        # Volume
        "hvl": oi.groupby("strike")["volume"].sum().idxmax(),
    }
    # On retire les flips introuvables
    return {nom: v for nom, v in niveaux.items() if v is not None}


# ---------------------------------------------------------------
# 4. Conversion en NQ et ligne pour TradingView
# ---------------------------------------------------------------
def convertir_en_nq(strike, prix_source, prix_nq):
    return round(strike * (prix_nq / prix_source) * 4) / 4


def generer_ligne(niveaux):
    return ";".join(f"{nom}={prix:.2f}" for nom, prix in niveaux.items())


PINE_MODELE = '''//@version=6
indicator("Options Levels", overlay=true, max_lines_count=100, max_labels_count=100)

// Généré automatiquement par niveaux.py le __DATE__ (heure de New York)
niveaux = "__NIVEAUX__"

couleurDe(nom) =>
    switch nom
        "call_wall"   => #4fc3f7
        "put_wall"    => #ff4fd8
        "gamma_flip"  => #ffc107
        "vol_trigger" => #ffb74d
        "max_pain"    => #bdbdbd
        "delta_wall"  => #66bb6a
        "delta_flip"  => #a5d6a7
        "vanna_wall"  => #ab47bc
        "vanna_flip"  => #ce93d8
        "vega_wall"   => #26c6da
        "charm_zone"  => #ff7043
        "max_call_oi" => #29b6f6
        "max_put_oi"  => #ec407a
        "hvl"         => #ffa726
        => #8a93a6

tracer(nom, prix) =>
    c = couleurDe(nom)
    texte = str.upper(str.replace_all(nom, "_", " ")) + "  " + str.tostring(prix)
    line.new(bar_index - 1, prix, bar_index, prix, extend=extend.both, color=c, style=line.style_dotted, width=1)
    label.new(bar_index + 5, prix, texte, style=label.style_label_left, color=color.new(#000000, 100), textcolor=c, size=size.small)

if barstate.islast
    for l in line.all
        line.delete(l)
    for lb in label.all
        label.delete(lb)

    for morceau in str.split(niveaux, ";")
        paire = str.split(morceau, "=")
        if array.size(paire) == 2
            nom = str.replace_all(array.get(paire, 0), " ", "")
            prix = str.tonumber(array.get(paire, 1))
            if not na(prix)
                tracer(nom, prix)
'''


def generer_pine(niveaux):
    """Renvoie le script Pine complet, avec les niveaux écrits dedans."""
    date = f"{datetime.now(NY):%Y-%m-%d %H:%M}"
    return PINE_MODELE.replace("__NIVEAUX__", generer_ligne(niveaux)).replace("__DATE__", date)


def copier(texte):
    try:
        subprocess.run("pbcopy", input=texte.encode(), check=True)
        return True
    except (FileNotFoundError, subprocess.CalledProcessError):
        return False


def get_niveaux():
    """Renvoie (prix QQQ, prix NQ, niveaux en QQQ, niveaux en NQ)."""
    spot_qqq, options = get_chaine()
    prix_nq = get_prix_nq()
    opts = preparer_options(options)
    niveaux_qqq = calculer_niveaux(opts, spot_qqq)
    niveaux_nq = {nom: convertir_en_nq(v, spot_qqq, prix_nq) for nom, v in niveaux_qqq.items()}
    return spot_qqq, prix_nq, niveaux_qqq, niveaux_nq


# ---------------------------------------------------------------
# Programme principal
# ---------------------------------------------------------------
def main():
    print("Récupération des options QQQ...")
    spot_qqq, prix_nq, niveaux_qqq, niveaux_nq = get_niveaux()

    print(f"\nQQQ : {spot_qqq:.2f}  |  NQ : {prix_nq:.2f}")
    print(f"{datetime.now(NY):%Y-%m-%d %H:%M} (heure de New York)\n")
    print(f"  {'niveau':<12} {'QQQ':>9} {'NQ':>11}")
    for nom in niveaux_nq:
        print(f"  {nom:<12} {niveaux_qqq[nom]:>9.2f} {niveaux_nq[nom]:>11.2f}")

    script_pine = generer_pine(niveaux_nq)
    with open("options_levels.pine", "w") as f:
        f.write(script_pine)

    print("\nScript Pine enregistré dans options_levels.pine")
    if copier(script_pine):
        print("✅ Script Pine copié dans le presse-papiers :")
        print("   Pine Editor → Cmd + A → Cmd + V → Save")


if __name__ == "__main__":
    main()