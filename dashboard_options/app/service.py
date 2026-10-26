"""
Le « moteur » du dashboard.

- MARCHE : une boucle qui récupère le prix des futures (NQ, ES) et du VIX toutes les 60 s,
  et garde l'historique du VIX minute par minute.
- Un ABONNEMENT par couple (sous-jacent, échéance) affiché dans un navigateur :
    * un flux SSE FreeFlow qui pousse le snapshot (niveaux + greeks) en continu,
      sans consommer de quota après la connexion ;
    * une boucle « lente » pour les bougies, le net drift, les sweeps d'options, la topologie...
  Un abonnement s'arrête tout seul 3 minutes après que plus personne ne le regarde.
- Le RATIO future / sous-jacent (pour convertir les niveaux en MNQ / MES), par ordre de priorité :
    1. un calibrage manuel (« 723 sur le QQQ = 29 940 sur le MNQ ») ;
    2. les bougies du sous-jacent et du future à la MÊME minute, en séance ;
    3. le dernier ratio synchronisé connu (sauvegardé sur le disque) ;
    4. en dernier recours, prix du future / prix du sous-jacent à l'instant (approximatif hors séance).

Le navigateur ne parle jamais à FreeFlow : il lit l'état préparé ici via /api/etat.
"""

import json
import threading
import time
import traceback
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timezone

from . import calculs, config, demo, freeflow

try:
    import yfinance as yf
except ImportError:
    yf = None


def log(message):
    print(f"[{time.strftime('%H:%M:%S')}] {message}", flush=True)


def lire_json(chemin, defaut):
    try:
        return json.loads(chemin.read_text())
    except (FileNotFoundError, ValueError):
        return defaut


def ecrire_json(chemin, donnees):
    try:
        chemin.write_text(json.dumps(donnees))
    except Exception as e:
        log(f"écriture {chemin.name} : {e}")


# ------------------------------------------------------------------
# Prix des futures et VIX (partagés par tous les abonnements)
# ------------------------------------------------------------------
class Marche:
    def __init__(self):
        self.prix = {}                       # "nq" → {"prix": 29940.5, "variation": 0.42}
        self.maj = None
        self.fichier_vix = config.DATA_DIR / "vix.json"
        self.vix = [] if config.MODE == "demo" else lire_json(self.fichier_vix, [])

    def prix_de(self, cle):
        return (self.prix.get(cle) or {}).get("prix")

    def boucle(self):
        if config.MODE != "demo":
            self._remplir_vix_yahoo()
        tour = 0
        while True:
            try:
                self.prix = demo.macro() if config.MODE == "demo" else freeflow.macro()
                self.maj = time.time()
                self._noter_vix()
                if tour % 5 == 0 and config.MODE != "demo":
                    ecrire_json(self.fichier_vix, self.vix)
            except Exception as e:
                log(f"macro : {e}")
            tour += 1
            time.sleep(15 if config.MODE == "demo" else 60)

    def _noter_vix(self):
        if config.MODE == "demo":
            self.vix = demo.vix_serie()
            return
        v = self.prix_de("vix")
        if not v:
            return
        minute = int(time.time()) // 60 * 60
        if self.vix and self.vix[-1]["t"] == minute:
            self.vix[-1]["v"] = v
        else:
            self.vix.append({"t": minute, "v": v})
        del self.vix[:-1500]

    def _remplir_vix_yahoo(self):
        """Au démarrage : récupère le VIX minute par minute de la séance sur Yahoo (s'il répond)."""
        if not yf:
            return
        try:
            df = yf.Ticker("^VIX").history(period="2d", interval="1m")
            connus = {p["t"] for p in self.vix}
            nouveaux = [{"t": int(t.timestamp()), "v": round(float(r.Close), 2)} for t, r in df.iterrows()]
            self.vix = sorted(self.vix + [p for p in nouveaux if p["t"] not in connus], key=lambda p: p["t"])[-1500:]
        except Exception as e:
            log(f"VIX Yahoo : {e}")

    def etat_vix(self):
        info = self.prix.get("vix") or {}
        prix, variation = info.get("prix"), info.get("variation")
        veille = prix / (1 + variation / 100) if prix and variation is not None else None
        return {"prix": prix, "variation": variation, "veille": veille, "serie": self.vix[-600:]}


MARCHE = Marche()


# ------------------------------------------------------------------
# Ratio future / sous-jacent : calibrage manuel et dernier ratio connu
# ------------------------------------------------------------------
FICHIER_CALIBRAGE = config.DATA_DIR / "calibrage.json"
FICHIER_RATIOS = config.DATA_DIR / "ratios.json"
_verrou_fichiers = threading.Lock()


def calibrage(symbole):
    """Le calibrage manuel du sous-jacent, s'il existe et vaut pour le contrat actuel."""
    c = lire_json(FICHIER_CALIBRAGE, {}).get(symbole)
    if c and c.get("contrat") == calculs.contrat_front(config.FUTURES[symbole][0]):
        return c
    return None


def calibrer(symbole, prix_sj, prix_future):
    if symbole not in config.FUTURES or prix_sj <= 0 or prix_future <= 0:
        raise ValueError("prix invalides")
    with _verrou_fichiers:
        donnees = lire_json(FICHIER_CALIBRAGE, {})
        donnees[symbole] = {
            "ratio": prix_future / prix_sj, "prix_sj": prix_sj, "prix_future": prix_future,
            "contrat": calculs.contrat_front(config.FUTURES[symbole][0]),
            "date": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
        ecrire_json(FICHIER_CALIBRAGE, donnees)
    _rafraichir(symbole)
    return donnees[symbole]


def effacer_calibrage(symbole):
    with _verrou_fichiers:
        donnees = lire_json(FICHIER_CALIBRAGE, {})
        donnees.pop(symbole, None)
        ecrire_json(FICHIER_CALIBRAGE, donnees)
    _rafraichir(symbole)


def _memoriser_ratio(symbole, ratio, minute):
    with _verrou_fichiers:
        donnees = lire_json(FICHIER_RATIOS, {})
        if donnees.get(symbole, {}).get("minute") == minute:
            return
        donnees[symbole] = {"ratio": ratio, "minute": minute,
                            "contrat": calculs.contrat_front(config.FUTURES[symbole][0])}
        ecrire_json(FICHIER_RATIOS, donnees)


def _ratio_memorise(symbole):
    r = lire_json(FICHIER_RATIOS, {}).get(symbole)
    if (r and r.get("contrat") == calculs.contrat_front(config.FUTURES[symbole][0])
            and time.time() - r["minute"] < 5 * 86400):
        return r
    return None


def _rafraichir(symbole):
    """Oblige les navigateurs à recharger l'état (après un changement de calibrage)."""
    for (sym, _), ab in list(ABONNEMENTS.items()):
        if sym == symbole:
            ab.version += 1


# ------------------------------------------------------------------
# Un abonnement = un sous-jacent + une échéance
# ------------------------------------------------------------------
class Abonnement:
    def __init__(self, symbole, echeance):
        self.symbole, self.echeance = symbole, echeance
        self.racine, self.cle_macro, self.ticker_yahoo, self.pas_grille = config.FUTURES[symbole]
        self.verrou = threading.Lock()
        self.version = 0
        self.dernier_acces = time.time()
        self.snap = None
        self.calc = {}
        self.bougies, self.bougies_future, self.drift = [], [], {}
        self.topo, self.metriques_ff, self.flux_brut = None, {}, None
        self.historique = {}                 # minute → {strike: net_gex}   (nuages de gamma)
        self.histo_iv = {}                   # minute → IV à la monnaie
        self.sweeps = {}                     # identifiant → ordre (sweep / block) normalisé
        self.sweeps_charges = False
        self.smiles = deque(maxlen=120)      # (minute, smile) : pour comparer avec il y a 30 min
        self.dernier_snapshot = 0
        self.source = None
        self.flux_inutilisable = False
        self.retard_bougies = 0
        self.source_bougies = None
        self.erreurs = {}
        self.fichier_histo = config.DATA_DIR / f"histo_{symbole}_{echeance}.json"
        self._charger_historique()

    # -------- cycle de vie --------
    def actif(self):
        # 10 min : un onglet laissé en arrière-plan ne coupe pas l'abonnement
        return time.time() - self.dernier_acces < 600

    def demarrer(self):
        if config.MODE == "demo":
            self._remplir_historique_demo()
        else:
            threading.Thread(target=self._boucle_flux, daemon=True).start()
        threading.Thread(target=self._boucle_lente, daemon=True).start()
        log(f"abonnement ouvert : {self.symbole} {self.echeance}")

    # -------- réception d'un snapshot --------
    def traiter_snapshot(self, snap, source):
        if isinstance(snap.get("data"), dict) and "rows" not in snap:
            snap = snap["data"]
        if not snap.get("rows") or not snap.get("spot"):
            return False

        spot = snap["spot"]
        profil = calculs.profil_par_strike(snap["rows"], spot, config.ZONE)
        niveaux = calculs.niveaux(snap, profil)
        iv = calculs.iv_decimale(snap.get("atm_iv"))
        sigma = calculs.mouvement_attendu(spot, iv, self.echeance)
        if sigma:
            niveaux["plus_1_sigma"] = spot + sigma
            niveaux["moins_1_sigma"] = spot - sigma
        points_smile = calculs.smile(snap["rows"], spot, config.ZONE)

        calc = {
            "niveaux": niveaux,
            "sigma": sigma,
            "iv": iv,
            "profil": [{"strike": float(k), **{c: float(v) for c, v in ligne.items()}}
                       for k, ligne in profil.iterrows()],
            "pain": calculs.courbe_pain(snap["rows"], spot, config.ZONE),
            "metriques_profil": calculs.metriques_profil(profil, spot),
            "smile": points_smile,
            "skew": calculs.skew(points_smile, spot, sigma),
        }
        minute = int(time.time()) // 60 * 60
        nuage = {float(k): float(v) for k, v in profil["net_gex"].items()
                 if abs(k - spot) / spot < 0.04 and v} if not profil.empty else {}

        with self.verrou:
            self.snap = {k: v for k, v in snap.items() if k != "rows"}
            self.calc = calc
            if calculs.en_seance(minute):
                # hors séance le snapshot ne bouge plus : on n'invente pas d'historique
                self.historique[minute] = nuage
                if iv:
                    self.histo_iv[minute] = iv
                self._bougie_en_direct(spot, minute)
            if points_smile and (not self.smiles or self.smiles[-1][0] != minute):
                self.smiles.append((minute, points_smile))
            self.dernier_snapshot = time.time()
            self.source = source
            self.version += 1
        return True

    def _bougie_en_direct(self, spot, minute):
        """
        Fait vivre le graphique avec le spot du snapshot (appelé seulement en séance).
        Si les bougies FreeFlow sont en retard (ou d'une séance précédente), on démarre quand même
        une nouvelle bougie : le graphique ne reste jamais figé pendant la séance.
        """
        if self.bougies and minute == self.bougies[-1]["time"]:
            b = self.bougies[-1]
            b["close"], b["high"], b["low"] = spot, max(b["high"], spot), min(b["low"], spot)
        elif not self.bougies or minute > self.bougies[-1]["time"]:
            precedent = self.bougies[-1]["close"] if self.bougies and minute - self.bougies[-1]["time"] <= 600 else spot
            self.bougies.append({"time": minute, "open": precedent, "high": max(precedent, spot),
                                 "low": min(precedent, spot), "close": spot, "volume": 0, "direct": True})

    def _fusionner_bougies(self, nouvelles):
        """Bougies FreeFlow + nos bougies « en direct » plus récentes que la dernière bougie FreeFlow."""
        if not nouvelles:
            return self.bougies
        derniere = nouvelles[-1]["time"]
        self.retard_bougies = max(0, int(time.time()) // 60 * 60 - derniere)
        return nouvelles + [b for b in self.bougies if b["time"] > derniere and b.get("direct")]

    # -------- flux SSE (snapshot en continu) --------
    def _boucle_flux(self):
        """
        Flux SSE du snapshot. Tourne tant que l'abonnement est ouvert : il se met en veille quand
        le marché est fermé et se reconnecte TOUT SEUL à l'ouverture, chaque jour.
        """
        jour = None
        while self.actif():
            if not calculs.marche_actif():
                time.sleep(60)                      # marché fermé : rien ne bouge, on n'use pas le quota
                continue
            aujourd_hui = datetime.now(calculs.NY).date()
            if aujourd_hui != jour:                 # nouvelle séance : on redonne sa chance au flux
                jour, self.flux_inutilisable = aujourd_hui, False
            if self.flux_inutilisable:              # le snapshot arrive alors par requêtes (boucle lente)
                time.sleep(60)
                continue
            try:
                for message in freeflow.flux_snapshot(self.symbole, self.echeance):
                    if not self.actif() or not calculs.marche_actif():
                        break
                    if not self.traiter_snapshot(message, "flux"):
                        log(f"{self.symbole} : le flux ne contient pas les contrats, passage en requêtes")
                        self.flux_inutilisable = True
                        break
                    self.erreurs.pop("flux", None)
            except Exception as e:
                self.erreurs["flux"] = str(e)
                log(f"flux {self.symbole} : {e}")
            time.sleep(20)

    # -------- boucle lente --------
    def _boucle_lente(self):
        tour = 0
        while self.actif():
            debut = time.time()
            try:
                if config.MODE == "demo":
                    self._tour_demo(tour)
                else:
                    self._tour_freeflow(tour)
            except Exception as e:
                traceback.print_exc()
                self.erreurs["boucle"] = str(e)
            if tour % 5 == 0:
                self._sauver_historique()
            tour += 1
            pause = 5 if config.MODE == "demo" else config.REFRESH_SECONDES
            time.sleep(max(1, pause - (time.time() - debut)))
        self._sauver_historique()
        log(f"abonnement fermé : {self.symbole} {self.echeance}")

    def _tour_demo(self, tour):
        sweeps = demo.sweeps(self.symbole, self.echeance, 400, config.PRIME_MIN_FLUX)
        with self.verrou:
            self.bougies = demo.bougies(self.symbole)
            self.bougies_future = demo.bougies_future(self.symbole)
            self.sweeps = {}
            self._ajouter_sweeps(sweeps)
            self.flux_brut = demo.flux_par_strike(self.symbole, self.echeance)
            if tour % 6 == 0:
                self.drift = demo.net_drift(self.symbole, self.echeance)
                self.metriques_ff = demo.metriques(self.symbole, self.echeance)
            if tour % 12 == 0:
                self.topo = demo.gex_topo(self.symbole)
            self.version += 1
        self.traiter_snapshot(demo.snapshot(self.symbole, self.echeance), "demo")

    def _tour_freeflow(self, tour):
        """
        Environ 4,5 appels par minute pour un abonnement (+ 1 pour le macro, + 1 pour les news) :
        on reste sous la limite de 15 / min du plan standard, même avec deux sous-jacents ouverts.
        """
        def essayer(nom, fonction):
            try:
                resultat = fonction()
                self.erreurs.pop(nom, None)
                return resultat
            except Exception as e:
                self.erreurs[nom] = str(e)
                log(f"{nom} {self.symbole} : {e}")
                return None

        if tour > 0 and self.snap and not calculs.marche_actif():
            # marché fermé : les options ne bougent plus. On ne rafraîchit que le future (Yahoo, gratuit)
            # et, toutes les 30 min, le reste par sécurité. Tout repart à pleine vitesse à l'ouverture.
            if tour % 30 != 0:
                fut = essayer("future", self._bougies_yahoo) if yf else None
                with self.verrou:
                    if fut:
                        self.bougies_future = fut
                    self.version += 1
                return
        # sweeps : les 4 dernières heures au premier tour, puis seulement les dernières minutes
        fenetre, top = (240, 200) if not self.sweeps_charges else (config.REFRESH_SECONDES // 60 + 4, 80)
        taches = {
            "bougies": lambda: freeflow.bougies(self.symbole),
            "drift": lambda: freeflow.net_drift(self.symbole, self.echeance),
            "sweeps": lambda: freeflow.sweeps(self.symbole, self.echeance, fenetre, config.PRIME_MIN_FLUX, top),
        }
        # premier tour : tout d'un coup ; ensuite on alterne pour ménager le quota
        if tour % 2 == 0:
            taches["topologie"] = lambda: freeflow.gex_topo(self.symbole)
        if tour % 2 == 1 or tour == 0:
            taches["metriques"] = lambda: freeflow.metriques(self.symbole, self.echeance)
            taches["flux_strike"] = lambda: freeflow.flux_par_strike(self.symbole, self.echeance)
        if yf:
            taches["future"] = self._bougies_yahoo
        # pas de snapshot récent (flux coupé, ou démarrage) : on le demande directement
        # (flux SSE coupé : on redemande le snapshot à chaque tour, soit une fois par minute)
        if time.time() - self.dernier_snapshot > (50 if self.flux_inutilisable else 90):
            taches["snapshot"] = lambda: freeflow.snapshot(self.symbole, self.echeance)

        # les appels partent EN MÊME TEMPS (le limiteur reste respecté) : le premier chargement
        # prend le temps de l'appel le plus lent au lieu de la somme de tous
        with ThreadPoolExecutor(max_workers=len(taches)) as pool:
            futurs = {nom: pool.submit(essayer, nom, f) for nom, f in taches.items()}
            r = {nom: f.result() for nom, f in futurs.items()}
        self.sweeps_charges = True
        if r.get("snapshot"):
            self.traiter_snapshot(r["snapshot"], "requete")
        bougies, drift, sweeps = r.get("bougies"), r.get("drift"), r.get("sweeps")
        if not bougies and yf:
            # FreeFlow ne répond pas pour le graphique : mêmes bougies 1 min sur Yahoo
            bougies = essayer("bougies_yahoo", self._bougies_yahoo_sj)
            if bougies:
                self.source_bougies = "Yahoo"
        elif bougies:
            self.source_bougies = "FreeFlow"
        topo, metr, flux, fut = r.get("topologie"), r.get("metriques"), r.get("flux_strike"), r.get("future")

        with self.verrou:
            if bougies:
                self.bougies = self._fusionner_bougies(bougies)
            if drift:
                self.drift = drift
            if sweeps:
                self._ajouter_sweeps(sweeps)
            if topo:
                self.topo = topo
            if metr:
                self.metriques_ff = metr
            if flux:
                self.flux_brut = flux
            if fut:
                self.bougies_future = fut
            self.version += 1

    def _bougies_yahoo_sj(self):
        df = yf.Ticker(config.YAHOO_SOUS_JACENT[self.symbole]).history(period="1d", interval="1m")
        return [{"time": int(t.timestamp()), "open": r.Open, "high": r.High,
                 "low": r.Low, "close": r.Close, "volume": int(r.Volume)} for t, r in df.iterrows()]

    def _bougies_yahoo(self):
        df = yf.Ticker(self.ticker_yahoo).history(period="2d", interval="1m")
        return [{"time": int(t.timestamp()), "open": r.Open, "high": r.High,
                 "low": r.Low, "close": r.Close, "volume": int(r.Volume)} for t, r in df.iterrows()]

    # -------- sweeps / blocks --------
    def _ajouter_sweeps(self, brut):
        for s in brut:
            n = calculs.normaliser_sweep(s)
            if n:
                self.sweeps[f"{n['t']:.3f}|{n['k']}|{n['d']}|{n['q']}|{n['p']:.0f}"] = n
        limite = time.time() - 20 * 3600                   # on garde la dernière séance
        gardes = sorted((s for s in self.sweeps.items() if s[1]["t"] >= limite), key=lambda s: s[1]["t"])[-2500:]
        self.sweeps = dict(gardes)

    # -------- historique (nuages, IV, sweeps) --------
    def _remplir_historique_demo(self):
        bougies = demo.bougies(self.symbole)
        for b in bougies[::3]:
            snap = demo.snapshot(self.symbole, self.echeance, spot=b["close"], t=b["time"])
            profil = calculs.profil_par_strike(snap["rows"], b["close"], config.ZONE)
            self.historique[b["time"]] = {float(k): float(v) for k, v in profil["net_gex"].items()
                                          if abs(k - b["close"]) / b["close"] < 0.04 and v}
            self.histo_iv[b["time"]] = snap["atm_iv"]
            if b["time"] > bougies[-1]["time"] - 3600:
                self.smiles.append((b["time"], calculs.smile(snap["rows"], b["close"], config.ZONE)))

    def _charger_historique(self):
        brut = lire_json(self.fichier_histo, {})
        if "gex" not in brut:                       # ancien format : seulement les nuages
            brut = {"gex": brut}
        try:
            self.historique = {int(t): {float(k): v for k, v in pts.items()} for t, pts in brut.get("gex", {}).items()}
            self.histo_iv = {int(t): v for t, v in brut.get("iv", {}).items()}
            for s in brut.get("sweeps", []):
                if s["t"] > time.time() - 20 * 3600:
                    self.sweeps[f"{s['t']:.3f}|{s['k']}|{s['d']}|{s['q']}|{s['p']:.0f}"] = s
        except (ValueError, AttributeError, KeyError) as e:
            log(f"historique illisible ({e}), on repart de zéro")

    def _sauver_historique(self):
        if config.MODE == "demo":
            return
        with self.verrou:
            copie = {"gex": {str(t): {str(k): v for k, v in pts.items()} for t, pts in self.historique.items()},
                     "iv": {str(t): v for t, v in self.histo_iv.items()},
                     "sweeps": list(self.sweeps.values())}
        ecrire_json(self.fichier_histo, copie)

    def historique_compact(self):
        """{strikes: [...], t: [...], v: [[...]]} : plus léger à envoyer au navigateur."""
        minutes = sorted(self.historique)[-420:]
        strikes = sorted({k for m in minutes for k in self.historique[m]})
        return {"strikes": strikes, "t": minutes,
                "v": [[round(self.historique[m].get(k, 0)) for k in strikes] for m in minutes]}

    # -------- ratio future / sous-jacent --------
    def choisir_ratio(self, spot, prix_future):
        c = calibrage(self.symbole)
        if c:
            return {"ratio": c["ratio"], "source": "calibrage", "date": c["date"],
                    "detail": f"{c['prix_sj']:g} {self.symbole} = {c['prix_future']:g} {self.racine}"}
        synchro = calculs.ratio_synchronise(self.bougies, self.bougies_future)
        if synchro:
            if config.MODE != "demo":
                _memoriser_ratio(self.symbole, synchro["ratio"], synchro["minute"])
            return {"ratio": synchro["ratio"], "source": "synchro", "minute": synchro["minute"]}
        memoire = _ratio_memorise(self.symbole)
        if memoire:
            return {"ratio": memoire["ratio"], "source": "memoire", "minute": memoire["minute"]}
        if prix_future and spot:
            return {"ratio": prix_future / spot, "source": "direct",
                    "approximatif": not calculs.en_seance(time.time())}
        return {"ratio": None, "source": None}

    # -------- volatilité --------
    def etat_volatilite(self, iv):
        rv = calculs.vol_realisee(self.bougies)
        minutes = sorted(self.histo_iv)[-420:]
        ecart = iv - rv["rv30"] if iv and rv["rv30"] else None
        verdict = None
        if ecart is not None:
            verdict = "chere" if ecart > 0.03 else "bon_marche" if ecart < -0.03 else "neutre"
        return {"iv": iv, "rv30": rv["rv30"], "rv_seance": rv["rv_seance"], "ecart": ecart, "verdict": verdict,
                "serie_iv": [{"t": m, "v": self.histo_iv[m]} for m in minutes],
                "serie_rv": rv["serie"][-420:]}

    def smile_reference(self):
        """Le smile d'il y a ~30 minutes (au moins 15), pour voir comment il s'est déformé."""
        if not self.smiles:
            return None, None
        cible = self.smiles[-1][0] - 30 * 60
        candidats = [s for s in self.smiles if s[0] <= self.smiles[-1][0] - 15 * 60]
        if not candidats:
            return None, None
        minute, points = min(candidats, key=lambda s: abs(s[0] - cible))
        return minute, points

    # -------- état envoyé au navigateur --------
    def etat(self):
        self.dernier_acces = time.time()
        with self.verrou:
            if not self.snap:
                return {"pret": False, "version": self.version, "erreurs": self.erreurs,
                        "symbole": self.symbole, "echeance": self.echeance}
            snap, calc = dict(self.snap), dict(self.calc)
            spot = snap["spot"]
            prix_future = MARCHE.prix_de(self.cle_macro)
            if not prix_future and self.bougies_future:
                prix_future = self.bougies_future[-1]["close"]
            infos_ratio = self.choisir_ratio(spot, prix_future)
            ratio = infos_ratio["ratio"]
            niveaux = calc["niveaux"]
            niveaux_future = {k: calculs.vers_future(v, ratio) for k, v in niveaux.items()} if ratio else {}
            drift = self.drift or {}
            serie_drift = drift.get("series", [])
            net_premium = drift.get("net_cum")
            if net_premium is None and serie_drift:
                net_premium = serie_drift[-1].get("call_cum", 0) + serie_drift[-1].get("put_cum", 0)

            sweeps = list(self.sweeps.values())
            haussier = sum(s["p"] for s in sweeps if s["s"] > 0)
            baissier = sum(s["p"] for s in sweeps if s["s"] < 0)
            vol = self.etat_volatilite(calc.get("iv"))
            vix = MARCHE.etat_vix()
            skew = calc.get("skew") or {}
            minute_ref, smile_ref = self.smile_reference()

            metriques = {
                "total_gex": snap.get("total_gex"),
                "gex_ratio": snap.get("ratio"),
                "total_dex": snap.get("total_dex"),
                "gross_dex": snap.get("gross_dex"),
                "gross_vex": snap.get("gross_vex"),
                "gross_charm": snap.get("gross_charmex"),
                "atm_iv": calc.get("iv"),
                "mouvement_attendu": calc.get("sigma"),
                "mouvement_attendu_future": calc["sigma"] * ratio if calc.get("sigma") and ratio else None,
                "volume": snap.get("total_vol"),
                "net_premium": net_premium,
                "hedging_pressure": (self.metriques_ff or {}).get("hedging_pressure"),
                "rv30": vol["rv30"],
                "rv_seance": vol["rv_seance"],
                "iv_rv_ecart": vol["ecart"],
                "iv_verdict": vol["verdict"],
                "skew": skew.get("skew"),
                "vix": vix["prix"],
                "vix_variation": vix["variation"],
                "flux_haussier": haussier,
                "flux_baissier": baissier,
                "flux_net": haussier - baissier if sweeps else None,
                "flux_nombre": len(sweeps),
                **calc.get("metriques_profil", {}),
            }
            parts = calculs.part_par_echeance(self.topo)
            metriques["part_echeance"] = next((p["part"] for p in parts if p["exp"] == self.echeance), None)

            return {
                "pret": True,
                "version": self.version,
                "mode": config.MODE,
                "symbole": self.symbole,
                "echeance": self.echeance,
                "statut": snap.get("status"),
                "as_of": snap.get("as_of"),
                "source": self.source,
                "maj": datetime.now(timezone.utc).isoformat(),
                "erreurs": dict(self.erreurs),
                "appels_minute": freeflow.LIMITEUR.utilises(),
                "retard_bougies_min": round(self.retard_bougies / 60) if calculs.en_seance(time.time()) else 0,
                "age_snapshot_s": int(time.time() - self.dernier_snapshot),
                "source_bougies": self.source_bougies,
                "spot": spot,
                "future": {"code": calculs.contrat_front(self.racine), "racine": self.racine,
                           "prix": prix_future, "ratio": ratio, "ratio_info": infos_ratio,
                           "pas_grille": self.pas_grille},
                "metriques": metriques,
                "niveaux": niveaux,
                "niveaux_future": niveaux_future,
                "profil": calc["profil"],
                "pain": calc["pain"],
                "bougies": list(self.bougies[-600:]),
                "bougies_future": list(self.bougies_future[-600:]),
                "drift": serie_drift,
                "topo": self.topo,
                "parts_echeances": parts,
                "historique": self.historique_compact(),
                "flux_options": sweeps[-1500:],
                "flux_strike": calculs.flux_par_strike(self.flux_brut, sweeps, spot, config.ZONE),
                "volatilite": vol,
                "vix": vix,
                "smile": {"points": calc.get("smile", []), "reference": smile_ref, "minute_reference": minute_ref,
                          "skew": skew},
            }


# ------------------------------------------------------------------
# Registre des abonnements
# ------------------------------------------------------------------
ABONNEMENTS = {}
_verrou_registre = threading.Lock()


def liste_echeances(symbole):
    if config.MODE == "demo":
        liste = demo.echeances(symbole)
    else:
        try:
            liste = freeflow.echeances(symbole)
        except Exception as e:
            # QQQ, SPY, NDX et SPX ont une échéance chaque jour ouvré : on peut les deviner
            log(f"échéances {symbole} indisponibles ({e}), on utilise les jours ouvrés")
            liste = demo.echeances(symbole)
    # après 16 h 15 (ou le week-end), la prochaine séance devient la référence :
    # l'échéance qui expire à cette séance est le 0DTE, la suivante le 1DTE...
    reference = calculs.seance_de_reference()
    liste = [e for e in liste if e >= reference.isoformat()] or liste
    return [{"date": e, "dte": calculs.jours_ouvres_entre(reference, date.fromisoformat(e))} for e in liste]


def abonnement(symbole, echeance=None):
    symbole = symbole if symbole in config.SYMBOLES else config.SYMBOLE_DEFAUT
    if not echeance:
        echeance = liste_echeances(symbole)[0]["date"]
    cle = (symbole, echeance)
    with _verrou_registre:
        ab = ABONNEMENTS.get(cle)
        if ab is None or not ab.actif():
            ab = Abonnement(symbole, echeance)
            ABONNEMENTS[cle] = ab
            ab.demarrer()
        return ab


def demarrer():
    threading.Thread(target=MARCHE.boucle, daemon=True).start()
    # on ouvre tout de suite le sous-jacent par défaut : il est prêt quand le navigateur arrive
    def prechauffer():
        try:
            abonnement(config.SYMBOLE_DEFAUT)
        except Exception as e:
            log(f"préchauffage : {e}")
    threading.Thread(target=prechauffer, daemon=True).start()