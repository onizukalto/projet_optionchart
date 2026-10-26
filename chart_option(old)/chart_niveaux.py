"""
chart_niveaux.py — Fenêtre de chart façon TradingView (MNQ, 1 minute) avec tous
les niveaux d'options, mise à jour automatiquement.

- Les bougies se rafraîchissent toutes les 30 secondes.
- Les niveaux d'options se recalculent toutes les 5 minutes.

Usage :  python chart_niveaux.py      (Ctrl + C ou fermer la fenêtre pour arrêter)
Prérequis : niveaux.py dans le même dossier, et  pip install lightweight-charts
"""

import time

import yfinance as yf
from lightweight_charts import Chart

from niveaux import get_niveaux

REFRESH_BOUGIES = 30        # secondes
REFRESH_NIVEAUX = 5 * 60    # secondes

COULEURS = {
    "call_wall": "#4fc3f7", "put_wall": "#ff4fd8", "gamma_flip": "#ffc107",
    "vol_trigger": "#ffb74d", "max_pain": "#bdbdbd",
    "delta_wall": "#66bb6a", "delta_flip": "#a5d6a7",
    "vanna_wall": "#ab47bc", "vanna_flip": "#ce93d8",
    "vega_wall": "#26c6da",
    "charm_zone": "#ff7043",
    "max_call_oi": "#29b6f6", "max_put_oi": "#ec407a",
    "hvl": "#ffa726",
}


def get_bougies_mnq():
    df = yf.Ticker("MNQ=F").history(period="2d", interval="1m")
    df.index = df.index.tz_convert("America/New_York").tz_localize(None)
    df = df.reset_index()
    df.columns = [c.lower() for c in df.columns]
    df = df.rename(columns={"datetime": "time"})
    return df[["time", "open", "high", "low", "close", "volume"]]


def creer_chart():
    chart = Chart(width=1400, height=800, toolbox=True, title="MNQ – Options Levels")
    chart.layout(background_color="#0b0e14", text_color="#8a93a6", font_size=12)
    chart.grid(vert_enabled=False, horz_enabled=True, color="#1a1f2b")
    chart.candle_style(
        up_color="#26a69a", down_color="#ef5350",
        wick_up_color="#26a69a", wick_down_color="#ef5350",
        border_up_color="#26a69a", border_down_color="#ef5350",
    )
    chart.volume_config(up_color="rgba(38,166,154,0.25)", down_color="rgba(239,83,80,0.25)")
    chart.legend(visible=True)
    return chart


def tracer_niveaux(chart, lignes):
    """Efface les anciennes lignes, recalcule les niveaux et trace les nouvelles."""
    for ligne in lignes:
        ligne.delete()

    _, _, _, niveaux = get_niveaux()
    nouvelles = []
    for nom, prix in niveaux.items():
        nouvelles.append(chart.horizontal_line(
            prix,
            color=COULEURS.get(nom, "#8a93a6"),
            width=1,
            style="dotted",
            text=nom.replace("_", " ").upper(),
        ))
    print(f"[{time.strftime('%H:%M:%S')}] Niveaux mis à jour : {len(niveaux)} niveaux")
    return nouvelles


def mettre_a_jour_bougies(chart, derniere_heure):
    """Envoie à la chart uniquement les bougies nouvelles ou en cours."""
    df = get_bougies_mnq()
    nouvelles = df[df["time"] >= derniere_heure]
    for _, bougie in nouvelles.iterrows():
        chart.update(bougie)
    return df["time"].iloc[-1]


def main():
    print("Chargement initial...")
    chart = creer_chart()
    bougies = get_bougies_mnq()
    chart.set(bougies)
    derniere_heure = bougies["time"].iloc[-1]

    lignes = tracer_niveaux(chart, [])
    dernier_calcul_niveaux = time.time()

    chart.show()  # non bloquant : le programme continue pendant que la fenêtre est ouverte
    print("Fenêtre ouverte. Ctrl + C pour arrêter.")

    try:
        while chart.is_alive:
            time.sleep(REFRESH_BOUGIES)
            try:
                derniere_heure = mettre_a_jour_bougies(chart, derniere_heure)
                if time.time() - dernier_calcul_niveaux > REFRESH_NIVEAUX:
                    lignes = tracer_niveaux(chart, lignes)
                    dernier_calcul_niveaux = time.time()
            except Exception as erreur:
                # Une erreur réseau passagère ne doit pas fermer la chart
                print(f"[{time.strftime('%H:%M:%S')}] Erreur, nouvel essai au prochain tour : {erreur}")
    except KeyboardInterrupt:
        pass
    finally:
        chart.exit()


if __name__ == "__main__":
    main()