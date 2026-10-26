"""
Calculs à partir des lignes du snapshot FreeFlow : profils par strike, niveaux clés,
métriques supplémentaires et conversion vers le micro-future (MNQ / MES).

Chaque ligne du snapshot est UN contrat (un strike, un call ou un put) avec ses
expositions déjà calculées par FreeFlow : gex, dex, vex (vanna), vegaex, charmex.
"""

import math
import time
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import pandas as pd

from . import config

NY = ZoneInfo("America/New_York")


# ------------------------------------------------------------------
# Profils par strike
# ------------------------------------------------------------------
def profil_par_strike(rows, spot, zone):
    """Additionne les contrats strike par strike, séparément pour les calls et les puts."""
    df = pd.DataFrame(rows)
    if df.empty:
        return df
    for col in ("gex", "dex", "vex", "vegaex", "charmex", "oi", "volume"):
        if col not in df:
            df[col] = 0.0
    df = df[(df["strike"] > spot * (1 - zone)) & (df["strike"] < spot * (1 + zone))]
    est_call = df["right"] == "C"

    def somme(colonne, filtre=None):
        partie = df if filtre is None else df[filtre]
        return partie.groupby("strike")[colonne].sum()

    profil = pd.DataFrame({
        "call_gex": somme("gex", est_call),
        "put_gex": somme("gex", ~est_call),
        "dex": somme("dex"),
        "vex": somme("vex"),
        "vegaex": somme("vegaex"),
        "charmex": somme("charmex"),
        "call_oi": somme("oi", est_call),
        "put_oi": somme("oi", ~est_call),
        "call_vol": somme("volume", est_call),
        "put_vol": somme("volume", ~est_call),
    }).fillna(0)
    profil["net_gex"] = profil["call_gex"] + profil["put_gex"]
    return profil.sort_index()


def flip(serie, spot):
    """Prix où la série par strike change de signe, le plus proche du spot (interpolé)."""
    strikes, valeurs = list(serie.index), list(serie.values)
    candidats = []
    for i in range(len(valeurs) - 1):
        a, b = valeurs[i], valeurs[i + 1]
        if a != 0 and b != 0 and (a > 0) != (b > 0):
            k0, k1 = strikes[i], strikes[i + 1]
            candidats.append(k0 - a * (k1 - k0) / (b - a))
    if not candidats:
        return None
    return min(candidats, key=lambda p: abs(p - spot))


def strike_max(serie, absolu=True):
    if serie.empty:
        return None
    s = serie.abs() if absolu else serie
    if s.max() <= 0:
        return None
    return float(s.idxmax())


# ------------------------------------------------------------------
# Niveaux
# ------------------------------------------------------------------
def niveaux(snap, profil):
    """Les niveaux clés, en prix du sous-jacent."""
    spot = snap["spot"]
    n = {
        "call_wall": snap.get("call_wall"),
        "put_wall": snap.get("put_wall"),
        "gamma_flip": snap.get("gamma_flip"),
        "vol_trigger": snap.get("vol_trigger"),
        "max_pain": snap.get("max_pain"),
    }
    if not profil.empty:
        net = profil["net_gex"]
        n.update({
            "major_long_gamma": float(net.idxmax()) if net.max() > 0 else None,
            "major_short_gamma": float(net.idxmin()) if net.min() < 0 else None,
            "delta_wall": strike_max(profil["dex"]),
            "delta_flip": flip(profil["dex"], spot),
            "vanna_wall": strike_max(profil["vex"]),
            "vanna_flip": flip(profil["vex"], spot),
            "vega_wall": strike_max(profil["vegaex"]),
            "charm_zone": strike_max(profil["charmex"]),
            "max_call_oi": strike_max(profil["call_oi"], absolu=False),
            "max_put_oi": strike_max(profil["put_oi"], absolu=False),
            "hvl": strike_max(profil["call_vol"] + profil["put_vol"], absolu=False),
        })
    return {nom: float(v) for nom, v in n.items() if v is not None}


def iv_decimale(v):
    """FreeFlow peut renvoyer 0.18 ou 18 (%) : on ramène toujours à 0.18."""
    if not v:
        return None
    return v / 100 if v > 1.5 else v


def mouvement_attendu(spot, iv, echeance):
    """
    Mouvement « 1 écart-type » attendu d'ici la clôture de l'échéance, en points.
    On compte le temps de marché restant (390 minutes par séance, 252 séances par an).
    """
    if not iv or not spot:
        return None
    maintenant = datetime.now(NY)
    fin = datetime.strptime(echeance, "%Y-%m-%d").replace(hour=16, tzinfo=NY)
    jours_ouvres = max(0, sum(1 for i in range((fin.date() - maintenant.date()).days)
                              if (maintenant.date() + timedelta(days=i + 1)).weekday() < 5))
    ouverture = maintenant.replace(hour=9, minute=30, second=0, microsecond=0)
    cloture = maintenant.replace(hour=16, minute=0, second=0, microsecond=0)
    if maintenant.weekday() >= 5:
        minutes_aujourdhui = 0                     # week-end : pas de séance aujourd'hui
    elif maintenant < ouverture:
        minutes_aujourdhui = 390
    else:
        minutes_aujourdhui = max(0, (cloture - maintenant).total_seconds() / 60)
    minutes = minutes_aujourdhui + jours_ouvres * 390
    minutes = max(minutes, 15)
    return spot * iv * math.sqrt(minutes / (252 * 390))


def courbe_pain(rows, spot, zone):
    """Pour chaque strike : combien les acheteurs d'options toucheraient si le prix finissait là."""
    df = pd.DataFrame(rows)
    if df.empty or "oi" not in df:
        return []
    strikes = sorted(s for s in df["strike"].unique() if spot * (1 - zone) < s < spot * (1 + zone))
    calls, puts = df[df["right"] == "C"], df[df["right"] == "P"]
    courbe = []
    for p in strikes:
        paiement = ((calls["oi"] * (p - calls["strike"]).clip(lower=0)).sum()
                    + (puts["oi"] * (puts["strike"] - p).clip(lower=0)).sum()) * 100
        courbe.append({"strike": float(p), "pain": float(paiement)})
    return courbe


def metriques_profil(profil, spot):
    """Métriques calculées à partir du profil par strike."""
    if profil.empty:
        return {}
    gex_abs = profil["net_gex"].abs()
    proche = gex_abs[(gex_abs.index > spot * 0.99) & (gex_abs.index < spot * 1.01)]
    call_oi, put_oi = profil["call_oi"].sum(), profil["put_oi"].sum()
    call_vol, put_vol = profil["call_vol"].sum(), profil["put_vol"].sum()
    return {
        "put_call_oi": float(put_oi / call_oi) if call_oi else None,
        "put_call_volume": float(put_vol / call_vol) if call_vol else None,
        "concentration_1pct": float(proche.sum() / gex_abs.sum()) if gex_abs.sum() else None,
        "gross_vega": float(profil["vegaex"].abs().sum()),
    }


def part_par_echeance(topo):
    """Part de chaque échéance dans le gamma total (à partir de la topologie)."""
    if not topo or not topo.get("grid"):
        return []
    totaux = [sum(abs(v or 0) for v in ligne) for ligne in topo["grid"]]
    somme = sum(totaux) or 1
    return [{"exp": e, "dte": d, "part": float(t / somme), "net": float(sum(v or 0 for v in ligne))}
            for e, d, t, ligne in zip(topo["exps"], topo.get("dtes", [None] * len(totaux)), totaux, topo["grid"])]


# ------------------------------------------------------------------
# Future
# ------------------------------------------------------------------
CODES_MOIS = {3: "H", 6: "M", 9: "U", 12: "Z"}


def troisieme_vendredi(annee, mois):
    d = date(annee, mois, 15)
    return d + timedelta(days=(4 - d.weekday()) % 7)


def contrat_front(racine, jour=None):
    """Contrat le plus échangé, ex. 'MNQZ6'. On passe au suivant 8 jours avant l'expiration."""
    jour = jour or datetime.now(NY).date()
    for annee in (jour.year, jour.year + 1):
        for mois in (3, 6, 9, 12):
            if jour <= troisieme_vendredi(annee, mois) - timedelta(days=8):
                return f"{racine}{CODES_MOIS[mois]}{annee % 10}"


def vers_future(prix, ratio):
    """Convertit un prix du sous-jacent en prix du future, au quart de point (pas de cotation MNQ / MES)."""
    return round(prix * ratio * 4) / 4


def ratio_synchronise(bougies_sj, bougies_future, nombre=10):
    """
    Ratio future / sous-jacent mesuré sur des bougies de la MÊME minute, en séance.
    Comparer le QQQ de 16 h avec le MNQ de 21 h donne un ratio faux (le future a bougé
    pendant la nuit, pas le QQQ) : c'est ce qui décalait les niveaux.
    On prend la médiane des `nombre` dernières minutes communes.
    """
    futures = {b["time"]: b["close"] for b in bougies_future if b.get("close")}
    communs = [(b["time"], futures[b["time"]] / b["close"]) for b in bougies_sj
               if b.get("close") and b["time"] in futures and en_seance(b["time"])]
    if len(communs) < 3:
        return None
    derniers = sorted(r for _, r in communs[-nombre:])
    return {"ratio": derniers[len(derniers) // 2], "minute": communs[-1][0]}


# ------------------------------------------------------------------
# Séance et échéances
# ------------------------------------------------------------------
def en_seance(t):
    """True si l'instant t (secondes epoch) est dans la séance régulière 9 h 30 – 16 h de New York."""
    if config.MODE == "demo":
        return True                        # en démo, les bougies inventées sont toujours « en séance »
    d = datetime.fromtimestamp(t, NY)
    return d.weekday() < 5 and 9 * 60 + 30 <= d.hour * 60 + d.minute < 16 * 60


def marche_actif(t=None):
    """
    Plage où les données d'options bougent : 9 h – 16 h 30 à New York, en semaine
    (un peu avant l'ouverture et après la clôture pour les derniers ajustements).
    """
    if config.MODE == "demo":
        return True
    d = datetime.fromtimestamp(t or time.time(), NY)
    return d.weekday() < 5 and 9 * 60 <= d.hour * 60 + d.minute < 16 * 60 + 30


def seance_de_reference(maintenant=None):
    """
    Le jour de bourse « en cours » pour compter les DTE : aujourd'hui pendant la journée,
    le jour ouvré suivant après 16 h 15 ou le week-end (une échéance qui expire à la
    prochaine séance est alors bien un 0DTE).
    """
    m = maintenant or datetime.now(NY)
    jour = m.date()
    if m.weekday() >= 5 or m.hour * 60 + m.minute > 16 * 60 + 15:
        jour += timedelta(days=1)
    while jour.weekday() >= 5:
        jour += timedelta(days=1)
    return jour


def jours_ouvres_entre(debut, fin):
    """Nombre de jours ouvrés dans ]debut, fin] (0 si fin == debut)."""
    return sum(1 for i in range((fin - debut).days) if (debut + timedelta(days=i + 1)).weekday() < 5)


# ------------------------------------------------------------------
# Volatilité : réalisée, smile, skew
# ------------------------------------------------------------------
ANNUALISATION = math.sqrt(252 * 390)          # minutes de bourse dans une année


def vol_realisee(bougies, fenetre=30):
    """
    Volatilité réalisée annualisée, calculée sur les rendements 1 minute de la séance du jour.
    Renvoie la série glissante (fenêtre de `fenetre` minutes) et la valeur sur toute la séance.
    """
    minute_en_cours = int(time.time()) // 60 * 60          # la bougie pas encore finie fausserait le calcul
    seance = [b for b in bougies if en_seance(b["time"]) and b.get("close") and b["time"] < minute_en_cours]
    if not seance:
        return {"serie": [], "rv30": None, "rv_seance": None}
    if config.MODE != "demo":
        jour = datetime.fromtimestamp(seance[-1]["time"], NY).date()
        seance = [b for b in seance if datetime.fromtimestamp(b["time"], NY).date() == jour]
    rendements = []                                   # (minute, rendement log)
    for a, b in zip(seance, seance[1:]):
        if 0 < b["time"] - a["time"] <= 300:
            rendements.append((b["time"], math.log(b["close"] / a["close"])))

    def ecart_type(valeurs):
        if len(valeurs) < 5:
            return None
        moyenne = sum(valeurs) / len(valeurs)
        return math.sqrt(sum((v - moyenne) ** 2 for v in valeurs) / (len(valeurs) - 1)) * ANNUALISATION

    serie = []
    for i in range(len(rendements)):
        fenetre_valeurs = [r for _, r in rendements[max(0, i - fenetre + 1): i + 1]]
        v = ecart_type(fenetre_valeurs)
        if v is not None:
            serie.append({"t": rendements[i][0], "v": v})
    return {"serie": serie, "rv30": serie[-1]["v"] if serie else None,
            "rv_seance": ecart_type([r for _, r in rendements])}


def iv_ligne(row):
    """IV d'un contrat, quel que soit le nom du champ utilisé par la source."""
    for cle in ("iv", "iv_pct", "implied_vol", "impliedVolatility", "mid_iv", "vol"):
        v = row.get(cle)
        if isinstance(v, (int, float)) and v > 0:
            return iv_decimale(v)
    return None


def smile(rows, spot, zone):
    """
    Courbe de volatilité implicite par strike (le « smile »).
    On prend les options HORS de la monnaie, les plus liquides : puts sous le spot, calls au-dessus.
    """
    par_strike = {}
    for r in rows:
        k, iv = r.get("strike"), iv_ligne(r)
        if not k or not iv or not (spot * (1 - zone) < k < spot * (1 + zone)):
            continue
        par_strike.setdefault(float(k), {})[r.get("right")] = iv
    points = []
    bande = spot * 0.005                 # autour du spot, on mélange call et put pour éviter une marche
    for k in sorted(par_strike):
        ivs = par_strike[k]
        if ivs.get("C") and ivs.get("P"):
            poids_call = min(1, max(0, (k - (spot - bande)) / (2 * bande)))
            iv = poids_call * ivs["C"] + (1 - poids_call) * ivs["P"]
        else:
            iv = ivs.get("C") or ivs.get("P")
        if iv and 0.01 < iv < 3:
            points.append({"strike": k, "iv": iv, "iv_call": ivs.get("C"), "iv_put": ivs.get("P")})
    return points


def interpoler_iv(points, k):
    if not points or k < points[0]["strike"] or k > points[-1]["strike"]:
        return None
    for a, b in zip(points, points[1:]):
        if a["strike"] <= k <= b["strike"]:
            poids = (k - a["strike"]) / (b["strike"] - a["strike"] or 1)
            return a["iv"] + poids * (b["iv"] - a["iv"])
    return points[-1]["iv"] if points[-1]["strike"] == k else None


def skew(points, spot, sigma):
    """
    Skew = IV du put à −1σ moins IV du call à +1σ (en points de volatilité).
    Positif (cas normal) : les protections à la baisse coûtent plus cher que les paris à la hausse.
    """
    ecart = sigma if sigma else spot * 0.02
    iv_put, iv_call = interpoler_iv(points, spot - ecart), interpoler_iv(points, spot + ecart)
    if iv_put is None or iv_call is None:
        return None
    return {"skew": iv_put - iv_call, "iv_put": iv_put, "iv_call": iv_call,
            "k_put": spot - ecart, "k_call": spot + ecart}


# ------------------------------------------------------------------
# Flux d'options : sweeps / blocks
# ------------------------------------------------------------------
ACHAT = {"buy", "b", "ask", "at_ask", "above_ask", "bot", "bought", "buyer", "lift", "a", "aa"}
VENTE = {"sell", "s", "bid", "at_bid", "below_bid", "sold", "seller", "hit", "bb"}


def _secondes(ts):
    """Horodatage en secondes, qu'il soit donné en ns, µs, ms ou s."""
    ts = float(ts)
    for seuil, diviseur in ((1e17, 1e9), (1e14, 1e6), (1e11, 1e3)):
        if ts > seuil:
            return ts / diviseur
    return ts


def normaliser_sweep(s):
    """Un ordre de la source → {t, k, d, c, s, p, q, n, g} (format compact envoyé au navigateur)."""
    try:
        t = _secondes(s.get("ts") or s.get("time") or s.get("t") or s.get("timestamp") or s.get("ts_ns"))
        k = float(s["strike"])
    except (TypeError, ValueError, KeyError):
        return None
    droit = str(s.get("right") or s.get("type") or "").upper()[:1]
    if droit not in ("C", "P"):
        return None
    cote_brut = str(s.get("side") or "").lower()
    cote = 1 if cote_brut in ACHAT else -1 if cote_brut in VENTE else 0
    senti = s.get("sentiment")
    if isinstance(senti, (int, float)):
        sens = 1 if senti > 0 else -1 if senti < 0 else 0
    else:
        texte = str(senti or "").lower()
        sens = 1 if "bull" in texte or "hauss" in texte else -1 if "bear" in texte or "baiss" in texte else 0
    if sens == 0 and cote:
        # achat de call / vente de put = haussier ; achat de put / vente de call = baissier
        sens = cote if droit == "C" else -cote
    prime = float(s.get("premium") or s.get("prem") or s.get("notional") or s.get("value") or 0)
    taille = int(float(s.get("size") or s.get("qty") or s.get("contracts") or 0))
    genre = str(s.get("kind") or s.get("type_ordre") or "sweep").lower()
    return {"t": round(t, 3), "k": k, "d": droit, "c": cote, "s": sens, "p": prime, "q": taille,
            "n": int(s.get("prints") or 1), "g": "block" if "block" in genre else "sweep"}


CLES_CALL = ("call_net", "calls_net", "call_net_premium", "net_call", "call", "calls", "call_premium")
CLES_PUT = ("put_net", "puts_net", "put_net_premium", "net_put", "put", "puts", "put_premium")


def _premier(d, cles):
    for c in cles:
        v = d.get(c)
        if isinstance(v, dict):
            v = v.get("net", v.get("premium"))
        if isinstance(v, (int, float, str)) and v != "":
            try:
                return float(v)
            except ValueError:
                pass
    return None


def flux_par_strike(brut, sweeps, spot, zone):
    """
    Prime nette achetée (+) ou vendue (−) par strike, pour les calls et pour les puts.
    Depuis /public/flow si la source la donne, sinon recalculée à partir des sweeps.
    """
    lignes = []
    if isinstance(brut, list):
        brut = {"by_strike": brut}
    brut = brut or {}
    bs = brut.get("by_strike") or brut.get("strikes") or brut.get("byStrike") or (brut.get("data") or {}).get("by_strike") or []
    if isinstance(bs, dict):
        bs = [{"strike": k, **(v if isinstance(v, dict) else {"net": v})} for k, v in bs.items()]
    for it in bs:
        try:
            k = float(it.get("strike"))
        except (TypeError, ValueError):
            continue
        c, p = _premier(it, CLES_CALL), _premier(it, CLES_PUT)
        droit = str(it.get("right") or it.get("type") or "").upper()[:1]
        if c is None and p is None and droit in ("C", "P"):          # une ligne par strike ET par type
            v = _premier(it, ("net", "net_premium", "premium"))
            c, p = (v, None) if droit == "C" else (None, v)
        c, p = c or 0.0, p or 0.0
        if c or p:
            lignes.append({"strike": k, "call_net": c, "put_net": p})
    # plusieurs lignes pour un même strike (calls et puts séparés) : on les additionne
    fusion = {}
    for l in lignes:
        f = fusion.setdefault(l["strike"], {"strike": l["strike"], "call_net": 0.0, "put_net": 0.0})
        f["call_net"] += l["call_net"]; f["put_net"] += l["put_net"]
    lignes = list(fusion.values())
    if not lignes:
        cumul = {}
        for s in sweeps:
            ligne = cumul.setdefault(s["k"], {"strike": s["k"], "call_net": 0.0, "put_net": 0.0})
            signe = s["c"] or (s["s"] if s["d"] == "C" else -s["s"])
            ligne["call_net" if s["d"] == "C" else "put_net"] += signe * s["p"]
        lignes = list(cumul.values())
    return sorted((l for l in lignes if spot * (1 - zone) < l["strike"] < spot * (1 + zone)),
                  key=lambda l: l["strike"])