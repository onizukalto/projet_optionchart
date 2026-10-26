"""
Le serveur web.
    /                 → le dashboard (static/index.html)
    /api/config       → la liste des sous-jacents, le mode (démo ou FreeFlow)
    /api/echeances    → les échéances disponibles pour un sous-jacent (avec leur DTE)
    /api/etat         → toutes les données d'un sous-jacent + échéance (JSON)
    /api/news         → le fil d'actualités
    /api/pine         → le script Pine Script avec les niveaux du micro-future (MNQ / MES)
    /api/calibrage    → lire / enregistrer / effacer le calibrage manuel du ratio future / sous-jacent
"""

import base64
import secrets
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.gzip import GZipMiddleware
from pydantic import BaseModel
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles

from . import config, news, service

STATIC = Path(__file__).resolve().parent.parent / "static"


@asynccontextmanager
async def lifespan(app):
    service.demarrer()       # prix des futures
    news.demarrer()          # fil d'actualités
    yield


app = FastAPI(lifespan=lifespan)
app.add_middleware(GZipMiddleware, minimum_size=2000)     # l'état JSON est ~6x plus léger compressé


@app.middleware("http")
async def mot_de_passe(request: Request, call_next):
    """Protection simple par identifiant / mot de passe, si DASHBOARD_PASSWORD est défini."""
    if config.DASHBOARD_PASSWORD and request.url.path != "/sante":
        attendu = f"{config.DASHBOARD_USER}:{config.DASHBOARD_PASSWORD}"
        recu = request.headers.get("authorization", "")
        ok = False
        if recu.startswith("Basic "):
            try:
                ok = secrets.compare_digest(base64.b64decode(recu[6:]).decode(), attendu)
            except Exception:
                ok = False
        if not ok:
            return Response(status_code=401, headers={"WWW-Authenticate": 'Basic realm="dashboard"'})
    return await call_next(request)


@app.middleware("http")
async def pas_de_cache(request: Request, call_next):
    """Oblige le navigateur à vérifier les fichiers à chaque chargement : une mise à jour se voit tout de suite."""
    reponse = await call_next(request)
    if request.url.path == "/" or request.url.path.startswith("/static"):
        reponse.headers["Cache-Control"] = "no-cache"
    return reponse


@app.get("/")
def accueil():
    return FileResponse(STATIC / "index.html")


@app.get("/sante")
def sante():
    return {"ok": True}


@app.get("/api/config")
def configuration():
    return {"symboles": config.SYMBOLES, "defaut": config.SYMBOLE_DEFAUT, "mode": config.MODE}


@app.get("/api/echeances")
def echeances(symbole: str = config.SYMBOLE_DEFAUT):
    try:
        return service.liste_echeances(symbole)
    except Exception as e:
        return JSONResponse({"erreur": str(e)}, status_code=503)


@app.get("/api/etat")
def etat(symbole: str = config.SYMBOLE_DEFAUT, echeance: str = "", version: int = -1):
    try:
        ab = service.abonnement(symbole, echeance or None)
    except Exception as e:
        return {"pret": False, "erreurs": {"echeances": str(e)}}
    if version == ab.version and ab.snap:
        ab.dernier_acces = time.time()
        return {"inchange": True, "version": version}     # rien de nouveau : réponse minuscule
    return ab.etat()


@app.get("/api/news")
def actualites():
    return news.lire()


SYMBOLES_TV = {"QQQ": "NASDAQ:QQQ", "NDX": "NASDAQ:NDX", "SPY": "AMEX:SPY", "SPX": "SP:SPX"}


@app.get("/api/pine", response_class=PlainTextResponse)
def pine(symbole: str = config.SYMBOLE_DEFAUT, echeance: str = ""):
    """Script Pine : niveaux du sous-jacent, convertis en direct dans TradingView."""
    ab = service.abonnement(symbole, echeance or None)
    for _ in range(30):                       # au démarrage, on attend le premier snapshot (15 s max)
        if ab.snap:
            break
        time.sleep(0.5)
    e = ab.etat()
    ligne = ";".join(f"{nom}={prix:.2f}" for nom, prix in e.get("niveaux", {}).items())
    date = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M")
    ratio = (e.get("future") or {}).get("ratio") or 1
    return ((STATIC / "options_levels.pine").read_text()
            .replace("__NIVEAUX__", ligne).replace("__DATE__", date)
            .replace("__SOUS_JACENT__", e.get("symbole", symbole)).replace("__ECHEANCE__", e.get("echeance", ""))
            .replace("__SYMBOLE_TV__", SYMBOLES_TV.get(e.get("symbole", symbole), symbole))
            .replace("__RATIO__", f"{ratio:.4f}")
            .replace("__CONTRAT__", (e.get("future") or {}).get("code", "")))


@app.get("/api/brut")
def brut(route: str = "flow", symbole: str = config.SYMBOLE_DEFAUT, echeance: str = ""):
    """
    Diagnostic : la réponse FreeFlow telle quelle (raccourcie), pour voir son format exact.
    Ex. : /api/brut?route=flow  ou  /api/brut?route=sweeps
    """
    if route not in ("flow", "sweeps"):
        return JSONResponse({"erreur": "route = flow ou sweeps"}, status_code=422)
    from . import freeflow
    ech = echeance or service.liste_echeances(symbole)[0]["date"]
    try:
        donnees = (freeflow.flux_par_strike(symbole, ech) if route == "flow"
                   else freeflow.appel_adaptatif("/public/sweeps", [
                       {"symbol": symbole, "exp": ech, "window_min": 240, "top": 50},
                       {"symbol": symbole, "exp": ech, "window_min": 240},
                       {"symbol": symbole, "exp": ech}, {"symbol": symbole, "window_min": 240}, {"symbol": symbole}]))
    except Exception as e:
        return JSONResponse({"erreur": str(e)}, status_code=502)

    def raccourcir(x, profondeur=0):
        if isinstance(x, list):
            return [raccourcir(v, profondeur + 1) for v in x[:3]] + ([f"... {len(x)} éléments"] if len(x) > 3 else [])
        if isinstance(x, dict):
            return {k: raccourcir(v, profondeur + 1) for k, v in list(x.items())[:25]}
        return x
    return {"route": route, "echeance": ech, "parametres_acceptes": freeflow._variante_ok.get(f"/public/{route}"),
            "reponse": raccourcir(donnees)}


class Calibrage(BaseModel):
    symbole: str
    prix_sj: float
    prix_future: float


@app.get("/api/calibrage")
def lire_calibrage(symbole: str = config.SYMBOLE_DEFAUT):
    return {"symbole": symbole, "calibrage": service.calibrage(symbole)}


@app.post("/api/calibrage")
def enregistrer_calibrage(c: Calibrage):
    """Ex. : {"symbole": "QQQ", "prix_sj": 723, "prix_future": 29940} → ratio 41,4108."""
    try:
        return {"symbole": c.symbole, "calibrage": service.calibrer(c.symbole, c.prix_sj, c.prix_future)}
    except ValueError as e:
        return JSONResponse({"erreur": str(e)}, status_code=422)


@app.delete("/api/calibrage")
def effacer_calibrage(symbole: str = config.SYMBOLE_DEFAUT):
    service.effacer_calibrage(symbole)
    return {"symbole": symbole, "calibrage": None}


app.mount("/static", StaticFiles(directory=STATIC), name="static")
