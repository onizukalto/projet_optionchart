// ============================================================
// Options Desk — cœur de l'application
//   - état partagé (sous-jacent, échéance, données reçues)
//   - interrogation du serveur toutes les 2 s (réponse minuscule si rien n'a changé)
//   - navigation entre les sections, barre du haut
//   - catalogues partagés : niveaux, familles, métriques, formats
// ============================================================

const COULEURS = { pos: "#3aa98f", neg: "#e5484d", call: "#4a90d9", put: "#e5588f", iv: "#e8b84a", rv: "#e6e6e9", ref: "#55565e", vix: "#c9a6ec" };

// ---------- les niveaux affichés sur la chart ----------
const NIVEAUX = {
  call_wall:         { nom: "Call wall",       famille: "GEX",        couleur: "#4a90d9" },
  put_wall:          { nom: "Put wall",        famille: "GEX",        couleur: "#e5588f" },
  gamma_flip:        { nom: "Gamma flip",      famille: "GEX",        couleur: "#e8b84a" },
  major_long_gamma:  { nom: "Major long γ",    famille: "GEX",        couleur: "#3aa98f" },
  major_short_gamma: { nom: "Major short γ",   famille: "GEX",        couleur: "#e5484d" },
  vol_trigger:       { nom: "Vol trigger",     famille: "Settlement", couleur: "#f08c3a" },
  max_pain:          { nom: "Max pain",        famille: "Settlement", couleur: "#9aa3b2" },
  plus_1_sigma:      { nom: "+1σ close",       famille: "Attendu",    couleur: "#c8c8cc" },
  moins_1_sigma:     { nom: "−1σ close",       famille: "Attendu",    couleur: "#c8c8cc" },
  delta_wall:        { nom: "Delta wall",      famille: "DEX",        couleur: "#4fb37a" },
  delta_flip:        { nom: "Delta flip",      famille: "DEX",        couleur: "#8fd1a8" },
  vanna_wall:        { nom: "Vanna wall",      famille: "VEX",        couleur: "#a874d8" },
  vanna_flip:        { nom: "Vanna flip",      famille: "VEX",        couleur: "#c9a6ec" },
  vega_wall:         { nom: "Vega wall",       famille: "Vega",       couleur: "#37b6c9" },
  charm_zone:        { nom: "Charm zone",      famille: "Charm",      couleur: "#e0734f" },
  max_call_oi:       { nom: "Max call OI",     famille: "OI",         couleur: "#7fb2ea" },
  max_put_oi:        { nom: "Max put OI",      famille: "OI",         couleur: "#ef8fb3" },
  hvl:               { nom: "HVL",             famille: "Volume",     couleur: "#d9c25a" },
};
const FAMILLES = ["GEX", "Settlement", "Attendu", "DEX", "VEX", "Vega", "Charm", "OI", "Volume"];
const FAMILLES_PAR_DEFAUT = ["GEX", "Settlement", "Attendu"];

// ---------- formats ----------
function fmtMontant(v, dollar = true) {
  if (v === null || v === undefined || isNaN(v)) return "–";
  const a = Math.abs(v), s = v < 0 ? "−" : v > 0 ? "+" : "", d = dollar ? "$" : "";
  if (a >= 1e9) return `${s}${d}${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${s}${d}${(a / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${s}${d}${(a / 1e3).toFixed(1)}K`;
  return `${s}${d}${a.toFixed(0)}`;
}
function fmtPrix(v, d = 2) {
  if (v === null || v === undefined || isNaN(v)) return "–";
  return Number(v).toLocaleString("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d });
}
const fmtPct = (v, d = 1) => (v === null || v === undefined || isNaN(v) ? "–" : `${(v * 100).toFixed(d)} %`);
const fmtRatio = (v) => (v === null || v === undefined || isNaN(v) ? "–" : v.toFixed(2));
const fmtSigne = (v, d = 2) => (v === null || v === undefined || isNaN(v) ? "–" : `${v >= 0 ? "+" : ""}${v.toFixed(d)}`);
// majuscules qui conservent γ et σ (sinon « Major long γ » devient « MAJOR LONG Γ »)
const majuscules = (t) => t.toUpperCase().replace(/Γ/g, "γ").replace(/Σ/g, "σ");
const decimalesSj = (sym) => (sym === "NDX" || sym === "SPX" ? 1 : 2);

// ---------- les métriques (tuiles, onglet Métriques, section Apprendre) ----------
const METRIQUES = [
  { cle: "regime", nom: "Régime γ", kpi: true,
    valeur: (e) => { const f = e.niveaux.gamma_flip; return f === undefined ? "–" : e.spot >= f ? "Long γ" : "Short γ"; },
    sous: (e) => { const f = e.niveaux.gamma_flip; return f === undefined ? "" : `spot ${fmtSigne(((e.spot - f) / f) * 100)} % vs flip`; },
    desc: "Position du prix par rapport au gamma flip" },
  { cle: "total_gex", nom: "Net GEX", kpi: true, valeur: (e) => fmtMontant(e.metriques.total_gex), sous: () => "$ par mouvement de 1 %",
    desc: "Somme du gamma de toutes les options" },
  { cle: "gex_ratio", nom: "Ratio GEX calls / puts", valeur: (e) => fmtRatio(e.metriques.gex_ratio),
    desc: "Gamma des calls divisé par celui des puts" },
  { cle: "mouvement_attendu", nom: "Mouvement attendu ±1σ", court: "Amplitude ±1σ", kpi: true,
    valeur: (e) => (e.metriques.mouvement_attendu ? `±${fmtPrix(e.metriques.mouvement_attendu, decimalesSj(e.symbole))}` : "–"),
    sous: (e) => (e.metriques.mouvement_attendu_future ? `±${fmtPrix(e.metriques.mouvement_attendu_future, 0)} pts ${e.future.racine}` : ""),
    desc: "Amplitude probable d'ici l'expiration (68 % des cas)" },
  { cle: "iv_rv", nom: "IV vs réalisée", kpi: true,
    valeur: (e) => (e.metriques.iv_rv_ecart === null || e.metriques.iv_rv_ecart === undefined ? "–" : `${fmtSigne(e.metriques.iv_rv_ecart * 100, 1)} pts`),
    sous: (e) => `${VERDICT_IV[e.metriques.iv_verdict] || "IV"} · ${fmtPct(e.metriques.atm_iv)} / ${fmtPct(e.metriques.rv30)}`,
    classe: (e) => ({ chere: "neg", bon_marche: "pos" }[e.metriques.iv_verdict] || ""),
    desc: "IV à la monnaie moins volatilité réalisée sur 30 min" },
  { cle: "atm_iv", nom: "IV à la monnaie", valeur: (e) => fmtPct(e.metriques.atm_iv), sous: () => "volatilité implicite",
    desc: "Volatilité anticipée par le marché" },
  { cle: "rv30", nom: "Volatilité réalisée 30 min", valeur: (e) => fmtPct(e.metriques.rv30),
    sous: (e) => `séance : ${fmtPct(e.metriques.rv_seance)}`, desc: "Ce que le prix bouge vraiment, annualisé" },
  { cle: "vix", nom: "VIX", kpi: true, valeur: (e) => fmtPrix(e.metriques.vix),
    sous: (e) => (e.metriques.vix_variation === null || e.metriques.vix_variation === undefined ? "" : `${fmtSigne(e.metriques.vix_variation)} % vs veille`),
    classe: (e) => (e.metriques.vix_variation > 0 ? "neg" : e.metriques.vix_variation < 0 ? "pos" : ""),
    desc: "Volatilité implicite du S&P 500 à 30 jours (« indice de la peur »)" },
  { cle: "skew", nom: "Skew ±1σ", kpi: true,
    valeur: (e) => (e.metriques.skew === null || e.metriques.skew === undefined ? "–" : `${fmtSigne(e.metriques.skew * 100, 1)} pts`),
    sous: () => "IV put −1σ − IV call +1σ", classe: () => "",
    desc: "Combien les protections coûtent plus cher que les paris haussiers" },
  { cle: "total_dex", nom: "Net DEX", valeur: (e) => fmtMontant(e.metriques.total_dex), desc: "Exposition nette au delta" },
  { cle: "gross_dex", nom: "DEX brut", valeur: (e) => fmtMontant(e.metriques.gross_dex, true).replace("+", ""), desc: "Σ |delta| : volume de couverture directionnelle" },
  { cle: "gross_vex", nom: "Vanna brut", valeur: (e) => fmtMontant(e.metriques.gross_vex).replace("+", ""), desc: "Sensibilité des couvertures à la volatilité" },
  { cle: "gross_charm", nom: "Charm brut", valeur: (e) => fmtMontant(e.metriques.gross_charm).replace("+", ""), desc: "Sensibilité des couvertures au temps" },
  { cle: "gross_vega", nom: "Vega brut", valeur: (e) => fmtMontant(e.metriques.gross_vega).replace("+", ""), desc: "$ par point de volatilité implicite" },
  { cle: "put_call_oi", nom: "Put / Call OI", kpi: true, valeur: (e) => fmtRatio(e.metriques.put_call_oi), sous: () => "contrats ouverts",
    desc: "Puts ouverts ÷ calls ouverts" },
  { cle: "put_call_volume", nom: "Put / Call volume", valeur: (e) => fmtRatio(e.metriques.put_call_volume), desc: "Puts échangés ÷ calls échangés aujourd'hui" },
  { cle: "concentration_1pct", nom: "Concentration γ ±1 %", valeur: (e) => fmtPct(e.metriques.concentration_1pct),
    desc: "Part du gamma située à moins de 1 % du prix" },
  { cle: "part_echeance", nom: "Poids de l'échéance", valeur: (e) => fmtPct(e.metriques.part_echeance),
    desc: "Part de cette échéance dans le gamma total" },
  { cle: "net_premium", nom: "Prime nette", kpi: true, valeur: (e) => fmtMontant(e.metriques.net_premium), sous: () => "achats − ventes agressifs",
    desc: "Flux d'options net depuis l'ouverture" },
  { cle: "flux_net", nom: "Flux sweeps", kpi: true, valeur: (e) => fmtMontant(e.metriques.flux_net),
    sous: (e) => `↑ ${fmtMontant(e.metriques.flux_haussier).replace("+", "")} · ↓ ${fmtMontant(e.metriques.flux_baissier).replace("+", "")}`,
    desc: "Prime des gros ordres haussiers moins baissiers (sweeps et blocks)" },
  { cle: "hedging_pressure", nom: "Hedging pressure",
    valeur: (e) => (e.metriques.hedging_pressure === null || e.metriques.hedging_pressure === undefined ? "–" : `${Math.round(e.metriques.hedging_pressure)} / 100`),
    sous: () => "vs reste de la séance", desc: "Besoin de couverture actuel des teneurs de marché" },
  { cle: "volume", nom: "Volume", valeur: (e) => fmtMontant(e.metriques.volume, false).replace("+", ""), desc: "Contrats échangés aujourd'hui" },
  { cle: "dist_walls", nom: "Distance aux walls", court: "Dist. walls %", kpi: true, classe: () => "",
    valeur: (e) => `${fmtSigne(dist(e, "call_wall"), 1)} / ${fmtSigne(dist(e, "put_wall"), 1)}`, sous: () => "call wall / put wall",
    desc: "Écart en % entre le prix et les deux murs" },
];
const VERDICT_IV = { chere: "IV chère", bon_marche: "IV bon marché", neutre: "neutre" };
const SOURCES_RATIO = {
  calibrage: ["calibré", "Ratio calibré à la main"],
  synchro: ["synchro", "Mesuré sur les bougies du sous-jacent et du future à la même minute"],
  memoire: ["dernier connu", "Dernier ratio mesuré en séance (hors séance, les deux marchés ne bougent plus ensemble)"],
  direct: ["direct", "Prix du future ÷ prix du sous-jacent à l'instant"],
};
// séance régulière des options : 9 h 30 – 16 h à New York, du lundi au vendredi
function seanceOuverte() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  const m = (Number(p.hour) % 24) * 60 + Number(p.minute);
  return !["Sat", "Sun"].includes(p.weekday) && m >= 570 && m < 960;
}
function dist(e, cle) { const v = e.niveaux[cle]; return v === undefined ? NaN : ((v - e.spot) / e.spot) * 100; }

// ---------- utilitaires ----------
const $ = (id) => document.getElementById(id);
const tip = $("tooltip");
function montrerTip(html, x, y) {
  tip.innerHTML = html;
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  tip.style.left = Math.min(x + 14, window.innerWidth - r.width - 8) + "px";
  tip.style.top = Math.min(y + 14, window.innerHeight - r.height - 8) + "px";
}
const cacherTip = () => (tip.hidden = true);
function lire(cle, defaut) { try { const v = localStorage.getItem(cle); return v ? JSON.parse(v) : defaut; } catch { return defaut; } }
function ecrire(cle, v) { try { localStorage.setItem(cle, JSON.stringify(v)); } catch {} }
function echapper(t) { return String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
const heureNY = new Intl.DateTimeFormat("fr-FR", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit" });

// ============================================================
// Application
// ============================================================
const App = {
  etat: null,
  symbole: lire("symbole", null),
  echeance: null,
  echeances: [],
  section: "desk",
  config: null,
  ecouteurs: [],
  version: -1,

  surDonnees(fn) { this.ecouteurs.push(fn); },
  notifier(changement) { this.ecouteurs.forEach((fn) => { try { fn(this.etat, changement); } catch (e) { console.error(e); } }); },

  async demarrer() {
    try {
      this.config = await (await fetch("/api/config")).json();
    } catch {
      this.majLive(false, "serveur injoignable, nouvel essai…");
      return setTimeout(() => this.demarrer(), 3000);
    }
    $("badge-demo").hidden = this.config.mode !== "demo";
    if (!this.config.symboles.includes(this.symbole)) this.symbole = this.config.defaut;
    this.dessinerSymboles();
    await this.chargerEcheances();
    this.navigation();
    $("copier-pine").addEventListener("click", () => this.copierPine());
    Calibrage.init();
    this.boucle();
  },

  // ---------- sous-jacents ----------
  dessinerSymboles() {
    $("symboles").innerHTML = this.config.symboles
      .map((s) => `<button class="${s === this.symbole ? "actif" : ""}" data-s="${s}">${s}</button>`).join("");
    $("symboles").querySelectorAll("button").forEach((b) => (b.onclick = () => this.changerSymbole(b.dataset.s)));
  },
  async changerSymbole(s) {
    if (s === this.symbole) return;
    this.symbole = s;
    ecrire("symbole", s);
    this.dessinerSymboles();
    await this.chargerEcheances();
    this.reinitialiser();
  },

  // ---------- échéances (0DTE, 1DTE...) ----------
  async chargerEcheances() {
    try {
      const r = await fetch(`/api/echeances?symbole=${this.symbole}`);
      const liste = await r.json();
      this.echeances = Array.isArray(liste) ? liste : [];
      if (!Array.isArray(liste)) this.majLive(false, "échéances : " + (liste.erreur || "erreur"));
    } catch { this.echeances = []; }
    const memo = lire("echeance-dte", 0);
    const choisie = this.echeances.find((e) => e.dte === memo) || this.echeances[0];
    this.echeance = choisie ? choisie.date : "";
    this.dessinerEcheances();
  },
  dessinerEcheances() {
    const jours = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", timeZone: "UTC" });
    $("echeances").innerHTML = (this.echeances || []).slice(0, 10).map((e) =>
      `<button class="${e.date === this.echeance ? "actif" : ""}" data-d="${e.date}" data-dte="${e.dte}">
        <b>${e.dte}DTE</b>${jours.format(new Date(e.date + "T12:00:00Z"))}</button>`).join("");
    $("echeances").querySelectorAll("button").forEach((b) => (b.onclick = () => {
      this.echeance = b.dataset.d;
      ecrire("echeance-dte", Number(b.dataset.dte));
      this.dessinerEcheances();
      this.reinitialiser();
    }));
  },

  reinitialiser() {
    this.etat = null;
    this.version = -1;
    this.notifier("reset");
    this.interroger();
  },

  // ---------- interrogation du serveur ----------
  async interroger() {
    const sym = this.symbole, ech = this.echeance;
    try {
      const r = await fetch(`/api/etat?symbole=${sym}&echeance=${ech}&version=${this.version}`);
      const e = await r.json();
      if (sym !== this.symbole || ech !== this.echeance) return;      // l'utilisateur a changé entre-temps
      if (e.inchange) { this.majLive(true); return; }
      if (!e.pret) {
        const err = Object.values(e.erreurs || {})[0];
        this.majLive(false, err ? "erreur : " + err : "premier chargement…");
        return;
      }
      const premier = this.etat === null;
      this.etat = e;
      this.version = e.version;
      this.majEntete();
      this.majLive(true);
      this.notifier(premier ? "premier" : "maj");
    } catch {
      this.majLive(false, "serveur injoignable");
    }
  },
  boucle() {
    this.interroger();
    // toutes les 2 s si la page est visible, toutes les 30 s sinon (garde l'abonnement ouvert côté serveur)
    let tours = 0;
    setInterval(() => { tours += 1; if (!document.hidden || tours % 15 === 0) this.interroger(); }, 2000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) { this.interroger(); this.verifierEcheances(); } });
    // toutes les minutes : après 16 h 15 (NY) le 0DTE expire, on passe tout seul au suivant
    setInterval(() => this.verifierEcheances(), 60000);
  },

  async verifierEcheances() {
    try {
      const liste = await (await fetch(`/api/echeances?symbole=${this.symbole}`)).json();
      if (!Array.isArray(liste) || !liste.length) return;
      const avant = JSON.stringify(this.echeances);
      this.echeances = liste;
      if (JSON.stringify(liste) === avant) return;
      if (!liste.some((e) => e.date === this.echeance)) {
        // l'échéance affichée a expiré : on prend celle qui a le même DTE (0DTE → le nouveau 0DTE)
        const memo = lire("echeance-dte", 0);
        this.echeance = (liste.find((e) => e.dte === memo) || liste[0]).date;
        this.dessinerEcheances();
        this.reinitialiser();
      } else {
        this.dessinerEcheances();             // les DTE ont changé (1DTE devient 0DTE)
      }
    } catch { /* serveur momentanément injoignable : on réessaiera dans une minute */ }
  },

  majEntete() {
    const e = this.etat;
    $("lbl-spot").textContent = e.symbole;
    $("spot").textContent = fmtPrix(e.spot, decimalesSj(e.symbole));
    $("lbl-future").textContent = e.future.code;
    $("future").textContent = fmtPrix(e.future.prix, 2);
    $("ratio").textContent = e.future.ratio ? e.future.ratio.toFixed(4) : "–";
    const info = e.future.ratio_info || {};
    const [court, long] = SOURCES_RATIO[info.source] || ["", ""];
    $("ratio-source").textContent = court + (info.approximatif ? " ≈" : "");
    $("ratio-source").className = info.source === "calibrage" ? "calibre" : info.approximatif ? "approx" : "";
    $("bloc-ratio").title = `${long}${info.detail ? ` (${info.detail})` : ""}${info.minute ? ` · minute ${heureNY.format(new Date(info.minute * 1000))} NY` : ""}\nClique sur la cible dans la barre de gauche pour calibrer.`;
  },
  majLive(ok, texte) {
    const e = this.etat;
    const erreurs = e && e.erreurs ? Object.keys(e.erreurs) : [];
    $("live").className = "live " + (ok && !erreurs.length ? "ok" : ok ? "" : "err");
    if (texte) { $("live-texte").textContent = texte; return; }
    if (!e) return;
    const source = { flux: "flux live", requete: "requêtes", demo: "démo" }[e.source] || "";
    const heure = e.as_of ? new Date(e.as_of).toLocaleTimeString("fr-FR") : "";
    const ferme = e.mode !== "demo" && !seanceOuverte();
    $("live-texte").textContent = ferme
      ? `options fermées · niveaux de la clôture · ${e.future.code} en direct`
      : `${source} · ${heure}${e.mode !== "demo" ? ` · ${e.appels_minute} appels/min` : ""}`
        + (e.source_bougies === "Yahoo" ? " · bougies Yahoo (FreeFlow lent)" : "")
        + (e.retard_bougies_min > 3 ? ` · bougies FreeFlow en retard de ${e.retard_bougies_min} min (complétées en direct)` : "")
        + (e.age_snapshot_s > 180 && !ferme ? ` · niveaux vieux de ${Math.round(e.age_snapshot_s / 60)} min` : "");
    if (ferme) $("live").title = "Les options sur le QQQ / SPY ne se traitent que de 9 h 30 à 16 h (New York). Les niveaux restent ceux de la clôture ; seul le future continue la nuit.";
    $("live").title = erreurs.length ? erreurs.map((k) => `${k} : ${e.erreurs[k]}`).join("\n") : "";
  },

  // ---------- navigation ----------
  navigation() {
    const aller = () => {
      const s = (location.hash || "#desk").slice(1);
      this.section = ["desk", "topology", "news", "apprendre"].includes(s) ? s : "desk";
      document.querySelectorAll(".section").forEach((x) => x.classList.toggle("visible", x.id === "sec-" + this.section));
      document.querySelectorAll(".rail a").forEach((a) => a.classList.toggle("actif", a.dataset.section === this.section));
      this.notifier("section");
    };
    window.addEventListener("hashchange", aller);
    aller();
  },

  async copierPine() {
    const b = $("copier-pine"), bulle = b.querySelector(".bulle-nav");
    try {
      const t = await (await fetch(`/api/pine?symbole=${this.symbole}&echeance=${this.echeance}`)).text();
      await navigator.clipboard.writeText(t);
      bulle.textContent = "Copié ✓ colle-le dans TradingView";
      b.classList.add("ok");
    } catch {
      window.open(`/api/pine?symbole=${this.symbole}&echeance=${this.echeance}`, "_blank");
    }
    setTimeout(() => { bulle.textContent = "Copier le script Pine"; b.classList.remove("ok"); }, 2200);
  },
};

// ============================================================
// Calibrage du ratio future / sous-jacent (« 723 QQQ = 29 940 MNQ »)
// ============================================================
const Calibrage = {
  init() {
    $("ouvrir-calibrage").onclick = () => this.ouvrir();
    $("cal-fermer").onclick = () => this.fermer();
    $("modale-calibrage").addEventListener("click", (ev) => { if (ev.target.id === "modale-calibrage") this.fermer(); });
    document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") this.fermer(); });
    ["cal-prix-sj", "cal-prix-fut"].forEach((id) => ($(id).oninput = () => this.apercu()));
    $("cal-ok").onclick = () => this.enregistrer();
    $("cal-auto").onclick = () => this.effacer();
  },
  ouvrir() {
    const e = App.etat;
    if (!e) return;
    const racine = e.future.racine, info = e.future.ratio_info || {};
    $("cal-titre").textContent = `${e.symbole} → ${racine}`;
    $("cal-sj").textContent = e.symbole;
    $("cal-fut").textContent = e.future.code;
    $("cal-lbl-sj").textContent = `Prix ${e.symbole}`;
    $("cal-lbl-fut").textContent = `Prix ${racine}`;
    $("cal-prix-sj").value = e.spot ? e.spot.toFixed(2) : "";
    $("cal-prix-fut").value = e.spot && e.future.ratio ? (Math.round(e.spot * e.future.ratio * 4) / 4).toFixed(2) : "";
    $("cal-actuel").textContent = `Actuel : ${e.future.ratio ? e.future.ratio.toFixed(4) : "–"} (${(SOURCES_RATIO[info.source] || ["?"])[0]}${info.detail ? ` : ${info.detail}` : ""})`;
    $("cal-auto").hidden = info.source !== "calibrage";
    $("modale-calibrage").hidden = false;
    this.apercu();
    $("cal-prix-sj").focus();
  },
  fermer() { $("modale-calibrage").hidden = true; },
  valeurs() { return [parseFloat($("cal-prix-sj").value), parseFloat($("cal-prix-fut").value)]; },
  apercu() {
    const [sj, fut] = this.valeurs(), e = App.etat;
    if (!(sj > 0 && fut > 0) || !e) { $("cal-apercu").textContent = "Nouveau ratio : –"; return; }
    const r = fut / sj, cw = e.niveaux.call_wall;
    $("cal-apercu").textContent = `Nouveau ratio : ${r.toFixed(4)}` + (cw ? ` · call wall ${fmtPrix(cw, decimalesSj(e.symbole))} → ${fmtPrix(Math.round(cw * r * 4) / 4)}` : "");
  },
  async envoyer(methode, corps) {
    const url = methode === "DELETE" ? `/api/calibrage?symbole=${App.symbole}` : "/api/calibrage";
    const r = await fetch(url, { method: methode, headers: { "Content-Type": "application/json" }, body: corps ? JSON.stringify(corps) : undefined });
    if (!r.ok) throw new Error(await r.text());
    this.fermer();
    App.version = -1;                 // on force le rechargement complet de l'état
    App.interroger();
  },
  async enregistrer() {
    const [sj, fut] = this.valeurs();
    if (!(sj > 0 && fut > 0)) return;
    try { await this.envoyer("POST", { symbole: App.symbole, prix_sj: sj, prix_future: fut }); }
    catch (err) { $("cal-apercu").textContent = "Erreur : " + err.message; }
  },
  async effacer() {
    try { await this.envoyer("DELETE"); } catch (err) { $("cal-apercu").textContent = "Erreur : " + err.message; }
  },
};