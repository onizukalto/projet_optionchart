"""
Fil d'actualités : FreeFlow /public/news + quelques flux RSS rapides (optionnels).
Tout est normalisé au même format, dédoublonné, et trié du plus récent au plus ancien.
"""

import calendar
import hashlib
import re
import threading
import time

from . import config, demo, freeflow

try:
    import feedparser
except ImportError:          # le dashboard fonctionne aussi sans
    feedparser = None

MOTS_MACRO = r"\b(fed|fomc|powell|waller|williams|cpi|ppi|pce|inflation|payrolls?|nfp|jobless|claims|gdp|" \
             r"treasury|yields?|rates?|ecb|lagarde|boj|tariffs?|recession|retail sales|ism|pmi|jobs)\b"
MOTS_FORTS = r"\b(fed|fomc|powell|cpi|nfp|payrolls|rate (cut|hike)|emergency|tariffs?|default|halt)\b"

_articles = {}
_verrou = threading.Lock()
_info = {"maj": None, "erreurs": []}


def _normaliser(titre, resume, url, source, ts, sentiment=None, categorie=None):
    titre = (titre or "").strip()
    cle = hashlib.md5(re.sub(r"\W+", "", titre.lower())[:80].encode()).hexdigest()
    texte = f"{titre} {resume or ''}".lower()
    return cle, {
        "id": cle, "titre": titre, "resume": (resume or "")[:400], "url": url, "source": source,
        "ts": int(ts or time.time()), "sentiment": sentiment, "categorie": categorie,
        "macro": bool(re.search(MOTS_MACRO, texte)),
        "important": bool(re.search(MOTS_FORTS, texte)),
    }


def _collecter():
    nouveaux, erreurs = [], []
    try:
        brut = demo.news() if config.MODE == "demo" else freeflow.news()
        for a in brut:
            nouveaux.append(_normaliser(a.get("headline"), a.get("description"), a.get("url"),
                                        a.get("source") or "FreeFlow", a.get("datetime"),
                                        a.get("sentiment"), a.get("category")))
    except Exception as e:
        erreurs.append(f"FreeFlow : {e}")

    if feedparser and config.MODE != "demo":
        for url in config.NEWS_RSS:
            try:
                flux = feedparser.parse(url, request_headers={"User-Agent": "Mozilla/5.0"})
                source = flux.feed.get("title", url.split("/")[2])
                for e in flux.entries[:30]:
                    t = e.get("published_parsed") or e.get("updated_parsed")
                    ts = calendar.timegm(t) if t else time.time()
                    nouveaux.append(_normaliser(e.get("title"), re.sub("<[^>]+>", "", e.get("summary", "")),
                                                e.get("link"), source, ts))
            except Exception as err:
                erreurs.append(f"{url[:40]} : {err}")

    with _verrou:
        for cle, article in nouveaux:
            if cle not in _articles:
                article["vu_a"] = int(time.time())
                _articles[cle] = article
        # on garde les 300 plus récents
        for cle in sorted(_articles, key=lambda c: _articles[c]["ts"])[:-300]:
            del _articles[cle]
        _info["maj"] = int(time.time())
        _info["erreurs"] = erreurs


def boucle():
    while True:
        try:
            _collecter()
        except Exception as e:
            _info["erreurs"] = [str(e)]
        time.sleep(30 if config.MODE == "demo" else 60)


def demarrer():
    threading.Thread(target=boucle, daemon=True).start()


def lire():
    with _verrou:
        articles = sorted(_articles.values(), key=lambda a: a["ts"], reverse=True)
    return {"articles": articles, "maj": _info["maj"], "erreurs": _info["erreurs"]}
