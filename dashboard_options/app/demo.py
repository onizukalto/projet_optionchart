"""
Données de démonstration, au même format que FreeFlow, pour les 4 sous-jacents.
Servent à voir le dashboard sans clé API (ou marché fermé). RIEN N'EST RÉEL.
"""

import math
import random
import time
from datetime import datetime, timedelta

from scipy.stats import norm

from .calculs import NY

# prix de départ, pas entre strikes, ratio future / sous-jacent
PARAMS = {
    "QQQ": {"spot": 742.0, "pas": 1, "ratio": 41.25},
    "NDX": {"spot": 30422.0, "pas": 10, "ratio": 41.25 / 41.0},
    "SPY": {"spot": 770.0, "pas": 1, "ratio": 10.05},
    "SPX": {"spot": 7700.0, "pas": 5, "ratio": 10.05 / 10.0},
}
_bougies = {}
_drift = {}
_graine = {}


def _greeks(S, K, T, sigma, est_call, r=0.04):
    racine = math.sqrt(T)
    d1 = (math.log(S / K) + (r + 0.5 * sigma**2) * T) / (sigma * racine)
    d2 = d1 - sigma * racine
    pdf = norm.pdf(d1)
    return {
        "delta": norm.cdf(d1) - (0 if est_call else 1),
        "gamma": pdf / (S * sigma * racine),
        "vega": S * pdf * racine,
        "vanna": -pdf * d2 / sigma,
        "charm": -pdf * (2 * r * T - d2 * sigma * racine) / (2 * T * sigma * racine),
    }


def echeances(symbole):
    jour = datetime.now(NY).date()
    liste = []
    while len(liste) < 8:
        if jour.weekday() < 5:
            liste.append(jour.strftime("%Y-%m-%d"))
        jour += timedelta(days=1)
    return liste


def _oi(symbole, echeance, k, right, S0):
    """Open interest « stable » (même valeur à chaque appel) pour un contrat donné."""
    cle = (symbole, echeance, k, right)
    if cle not in _graine:
        rnd = random.Random(hash(cle))
        p = PARAMS[symbole]
        distance = (k - S0) / S0
        dte_facteur = 1 + 0.6 * echeances(symbole).index(echeance)
        base = 9000 * math.exp(-(distance / (0.02 * math.sqrt(dte_facteur))) ** 2) + rnd.randint(50, 600)
        if round(k / p["pas"]) % 5 == 0:
            base *= 2.2
        if (right == "C" and k > S0) or (right == "P" and k < S0):
            base *= 1.5
        if rnd.random() < 0.04:
            base *= 4                                  # quelques gros murs isolés
        _graine[cle] = int(base / (1 + 0.15 * echeances(symbole).index(echeance)))
    return _graine[cle]


def snapshot(symbole, echeance, spot=None, t=None):
    p = PARAMS[symbole]
    S = spot or spot_actuel(symbole)
    S0 = p["spot"]
    dte = echeances(symbole).index(echeance) if echeance in echeances(symbole) else 0
    T = max(dte, 0.35) / 365
    rows = []
    ecart = p["pas"] * (2 if symbole in ("NDX", "SPX") else 1)
    centre = round(S / ecart) * ecart                 # la chaîne suit le prix (sinon +1σ peut en sortir)
    iv_atm = atm_iv(t)
    for i in range(-45, 46):
        k = centre + i * ecart
        for right in ("C", "P"):
            oi = _oi(symbole, echeance, k, right, S0)
            distance = (k - S) / S
            # smile réaliste : les puts sous le spot plus chers que les calls au-dessus (skew)
            iv = iv_atm - 0.55 * distance + 7 * distance ** 2 + (0.004 if right == "P" else 0)
            g = _greeks(S, k, T, iv, right == "C")
            signe = 1 if right == "C" else -1
            rows.append({
                "strike": k, "right": right, "oi": oi, "iv": round(iv, 4),
                "volume": int(oi * random.uniform(0.3, 2.5)),
                "gex": g["gamma"] * oi * 100 * S**2 * 0.01 * signe,
                "dex": g["delta"] * oi * 100 * S,
                "vex": g["vanna"] * oi * 100 * S * 0.01 * signe,
                "vegaex": g["vega"] * oi * 100 * 0.01 * signe,
                "charmex": g["charm"] * oi * 100 * S / 365 * signe,
            })
    calls = {r["strike"]: r["gex"] for r in rows if r["right"] == "C"}
    puts = {r["strike"]: r["gex"] for r in rows if r["right"] == "P"}
    net = {k: calls.get(k, 0) + puts.get(k, 0) for k in calls}
    gex_calls = sum(v for v in calls.values())
    gex_puts = sum(v for v in puts.values())
    return {
        "symbol": symbole, "exp": echeance, "status": "demo",
        "as_of": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "spot": S,
        "call_wall": max(calls, key=calls.get),
        "put_wall": min(puts, key=puts.get),
        "gamma_flip": _flip(net, S),
        "vol_trigger": round(_flip(net, S) - 0.0015 * S, 2),
        "max_pain": round(S0 / p["pas"]) * p["pas"],
        "ratio": abs(gex_calls / gex_puts) if gex_puts else None,
        "total_gex": sum(r["gex"] for r in rows),
        "total_dex": sum(r["dex"] for r in rows),
        "gross_dex": sum(abs(r["dex"]) for r in rows),
        "gross_vex": sum(abs(r["vex"]) for r in rows),
        "gross_charmex": sum(abs(r["charmex"]) for r in rows),
        "atm_iv": iv_atm,
        "total_vol": sum(r["volume"] for r in rows),
        "rows": rows,
    }


def _flip(net, spot):
    ks = sorted(net)
    meilleurs = [ks[i] + (ks[i + 1] - ks[i]) * net[ks[i]] / (net[ks[i]] - net[ks[i + 1]])
                 for i in range(len(ks) - 1) if net[ks[i]] * net[ks[i + 1]] < 0]
    return round(min(meilleurs, key=lambda x: abs(x - spot)), 2) if meilleurs else round(spot * 0.995, 2)


# NDX et SPX suivent QQQ et SPY (comme en vrai), pour que le ratio avec le future reste cohérent
LIENS = {"NDX": ("QQQ", 41.0), "SPX": ("SPY", 10.0)}


def bougies(symbole):
    if symbole in LIENS:
        base, facteur = LIENS[symbole]
        return [{**b, "open": b["open"] * facteur, "high": b["high"] * facteur,
                 "low": b["low"] * facteur, "close": b["close"] * facteur} for b in bougies(base)]
    p = PARAMS[symbole]
    maintenant = int(time.time()) // 60 * 60
    liste = _bougies.setdefault(symbole, [])
    if not liste:
        prix = p["spot"]
        rnd = random.Random(symbole)
        for i in range(390, 0, -1):
            o = prix
            # marche au hasard qui revient doucement vers le prix de départ (la chaîne d'options y est centrée)
            prix *= 1 + rnd.gauss(0, 0.0006) - 0.01 * (prix / p["spot"] - 1)
            liste.append({"time": maintenant - i * 60, "open": o, "close": prix,
                          "high": max(o, prix) * (1 + abs(rnd.gauss(0, 0.0002))),
                          "low": min(o, prix) * (1 - abs(rnd.gauss(0, 0.0002))),
                          "volume": rnd.randint(20000, 200000)})
    while liste[-1]["time"] < maintenant:
        o = liste[-1]["close"]
        liste.append({"time": liste[-1]["time"] + 60, "open": o, "close": o, "high": o, "low": o,
                      "volume": random.randint(20000, 200000)})
    # la dernière bougie bouge un peu à chaque appel (pour simuler le direct)
    b = liste[-1]
    b["close"] *= 1 + random.gauss(0, 0.00025) - 0.002 * (b["close"] / p["spot"] - 1)
    b["high"], b["low"] = max(b["high"], b["close"]), min(b["low"], b["close"])
    del liste[:-600]
    return [dict(x) for x in liste[-390:]]


def spot_actuel(symbole):
    if symbole in LIENS:
        base, facteur = LIENS[symbole]
        return spot_actuel(base) * facteur
    if symbole not in _bougies:
        bougies(symbole)
    return _bougies[symbole][-1]["close"]


def atm_iv(t=None):
    """IV à la monnaie qui ondule doucement au fil de la séance."""
    t = t or time.time()
    return round(0.19 + 0.012 * math.sin(t / 2400) + 0.005 * math.sin(t / 530), 4)


VIX_VEILLE = 16.0
_vix = []


def vix_serie():
    """VIX minute par minute, qui monte quand le QQQ baisse (comme en vrai)."""
    bq = bougies("QQQ")
    if not _vix:
        rnd = random.Random("vix")
        v = VIX_VEILLE * 1.01
        for a, b in zip(bq, bq[1:]):
            v *= 1 - 4 * math.log(b["close"] / a["close"]) + rnd.gauss(0, 0.0015)
            _vix.append({"t": b["time"], "v": round(v, 2)})
    while _vix[-1]["t"] < bq[-1]["time"]:
        prec = next((b for b in bq if b["time"] == _vix[-1]["t"]), bq[-2])
        suiv = next((b for b in bq if b["time"] > _vix[-1]["t"]), bq[-1])
        v = _vix[-1]["v"] * (1 - 4 * math.log(suiv["close"] / prec["close"]) + random.gauss(0, 0.0015))
        _vix.append({"t": suiv["time"], "v": round(v, 2)})
    del _vix[:-800]
    return list(_vix)


def macro():
    """Même format que freeflow.macro()."""
    vix = vix_serie()[-1]["v"]
    return {"nq": {"prix": spot_actuel("QQQ") * PARAMS["QQQ"]["ratio"], "variation": 0.42},
            "es": {"prix": spot_actuel("SPY") * PARAMS["SPY"]["ratio"], "variation": 0.31},
            "vix": {"prix": vix, "variation": (vix / VIX_VEILLE - 1) * 100}}


# ------------------------------------------------------------------
# Flux d'options (sweeps / blocks), au format FreeFlow
# ------------------------------------------------------------------
_sweeps = {}


def _generer_sweeps(symbole, echeance):
    liste = _sweeps.setdefault((symbole, echeance), [])
    bs = bougies(symbole)
    pas = PARAMS[symbole]["pas"] * (2 if symbole in ("NDX", "SPX") else 1)
    echelle = bs[-1]["close"] / 742                       # prix d'une option ~ proportionnel au sous-jacent
    dernier = liste[-1]["ts"] // 10**9 if liste else bs[0]["time"] - 60
    for b in bs:
        if b["time"] <= dernier:
            continue
        rnd = random.Random(f"{symbole}{echeance}{b['time']}")
        tendance = math.log(b["close"] / b["open"])
        for _ in range(rnd.choice([0, 0, 0, 1, 1, 1, 2, 3])):
            k = round(b["close"] * (1 + rnd.gauss(0, 0.006)) / pas) * pas
            right = "C" if rnd.random() < 0.5 + 300 * tendance else "P"
            cote = "buy" if rnd.random() < 0.62 else "sell"
            prime = min(6e6, math.exp(rnd.gauss(math.log(55000), 1.15)))
            prix_option = rnd.uniform(0.4, 4.5) * echelle
            haussier = (right == "C") == (cote == "buy")
            liste.append({
                "ts": int((b["time"] + rnd.uniform(0, 59)) * 10**9),
                "strike": k, "right": right, "side": cote,
                "sentiment": "bullish" if haussier else "bearish",
                "size": max(1, int(prime / (100 * prix_option))), "prints": rnd.randint(1, 14),
                "premium": round(prime), "kind": "block" if prime > 1.2e6 and rnd.random() < 0.5 else "sweep",
            })
    del liste[:-3000]
    return liste


def sweeps(symbole, echeance, fenetre_min, prime_min, top=500):
    limite = (time.time() - fenetre_min * 60) * 10**9
    choisis = [s for s in _generer_sweeps(symbole, echeance) if s["ts"] >= limite and s["premium"] >= prime_min]
    return sorted(sorted(choisis, key=lambda s: -s["premium"])[:top], key=lambda s: s["ts"])


def flux_par_strike(symbole, echeance):
    par_strike = {}
    for s in _generer_sweeps(symbole, echeance):
        ligne = par_strike.setdefault(s["strike"], {"strike": s["strike"], "call_net": 0.0, "put_net": 0.0})
        signe = 1 if s["side"] == "buy" else -1
        ligne["call_net" if s["right"] == "C" else "put_net"] += signe * s["premium"]
    lignes = sorted(par_strike.values(), key=lambda l: l["strike"])
    return {"net_premium": sum(l["call_net"] - l["put_net"] for l in lignes), "by_strike": lignes}


def bougies_future(symbole):
    ratio = PARAMS[symbole]["ratio"]
    return [{**b, "open": b["open"] * ratio, "high": b["high"] * ratio,
             "low": b["low"] * ratio, "close": b["close"] * ratio} for b in bougies(symbole)]


def net_drift(symbole, echeance):
    t = int(time.time())
    serie = _drift.setdefault((symbole, echeance), [])
    if not serie:
        rnd = random.Random(symbole + echeance)
        c = p = 0.0
        for i in range(300, 0, -1):
            c += rnd.gauss(1e5, 8e5)
            p += rnd.gauss(-5e4, 6e5)
            serie.append({"ts": t - i * 30, "call_cum": c, "put_cum": p})
    if t - serie[-1]["ts"] >= 30:
        serie.append({"ts": t, "call_cum": serie[-1]["call_cum"] + random.gauss(1e5, 8e5),
                      "put_cum": serie[-1]["put_cum"] + random.gauss(-5e4, 6e5)})
    dernier = serie[-1]
    return {"series": serie[-600:], "call_cum": dernier["call_cum"], "put_cum": dernier["put_cum"],
            "net_cum": dernier["call_cum"] + dernier["put_cum"]}


def gex_topo(symbole):
    exps = echeances(symbole)
    snaps = [snapshot(symbole, e) for e in exps]
    spot = snaps[0]["spot"]
    strikes = sorted({r["strike"] for r in snaps[0]["rows"]})
    grid = []
    for s in snaps:
        net = {}
        for r in s["rows"]:
            net[r["strike"]] = net.get(r["strike"], 0) + r["gex"]
        grid.append([net.get(k, 0) for k in strikes])
    return {"symbol": symbole, "spot": spot, "strikes": strikes, "exps": exps,
            "dtes": list(range(len(exps))), "grid": grid}


def metriques(symbole, echeance):
    return {"hedging_pressure": round(random.uniform(35, 80), 1)}


TITRES = [
    ("Fed's Waller says further rate cuts warranted if labor market keeps cooling", 0.3),
    ("US CPI rises 0.3% in September, core inflation steady at 2.9%", -0.1),
    ("Treasury yields climb as traders pare bets on December cut", -0.4),
    ("Nvidia leads chipmakers higher ahead of earnings season", 0.6),
    ("Oil slips as OPEC+ signals output increase", -0.2),
    ("Initial jobless claims fall to 218,000, below estimates", 0.2),
    ("Powell: policy is well positioned, no preset course", 0.0),
    ("Dollar index edges up after strong retail sales data", -0.1),
    ("ECB holds rates steady, Lagarde flags downside growth risks", -0.2),
    ("S&P 500 futures tick higher as tech megacaps rebound", 0.5),
]


def news():
    t = int(time.time())
    return [{"id": i, "headline": h, "description": "Article de démonstration : ce titre est inventé.",
             "url": "#", "category": "market", "datetime": t - i * 420 - 60, "source": "Démo",
             "sentiment": s} for i, (h, s) in enumerate(TITRES)]
