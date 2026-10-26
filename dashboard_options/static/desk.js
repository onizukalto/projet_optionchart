// ============================================================
// Section DESK
//   - tuiles de métriques
//   - chart 1 min (sous-jacent ou micro-future) avec niveaux, grille MNQ/MES,
//     nuages de gamma et bulles de flux d'options
//   - Tape options : les mêmes bulles sur une chart à part, plus lisible
//   - panneau latéral : niveaux / métriques / news
//   - smile, profils par strike, flux par strike, net drift, VIX, IV vs réalisée
// ============================================================

// ---------- calques dessinés par-dessus les charts ----------
const Calque = {
  // Fixe la taille CSS ET la taille réelle en pixels (× devicePixelRatio).
  // Sans la taille CSS, un écran Retina affiche le canvas 2x trop grand : c'était le bug des nuages.
  preparer(canvas, largeur, hauteur) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(largeur * dpr), h = Math.round(hauteur * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    canvas.style.width = largeur + "px";
    canvas.style.height = hauteur + "px";
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, largeur, hauteur);
    return { ctx, dpr };
  },
  // Position horizontale d'un instant t, même s'il ne tombe pas pile sur une bougie
  x(chart, temps, t) {
    if (!temps.length) return null;
    let logique;
    const n = temps.length;
    if (t <= temps[0]) logique = (t - temps[0]) / 60;
    else if (t >= temps[n - 1]) logique = n - 1 + (t - temps[n - 1]) / 60;
    else {
      let a = 0, b = n - 1;
      while (b - a > 1) { const m = (a + b) >> 1; if (temps[m] <= t) a = m; else b = m; }
      logique = a + Math.min(1, (t - temps[a]) / Math.min(60, temps[b] - temps[a]));
    }
    return chart.timeScale().logicalToCoordinate(logique);
  },
};

// ---------- bulles de flux d'options (sweeps / blocks) ----------
const heureNYsec = new Intl.DateTimeFormat("fr-FR", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const Flux = {
  // les ordres d'une même minute, d'un même strike, d'un même type et d'un même sens forment une bulle
  agreger(liste, primeMin) {
    const groupes = new Map();
    for (const s of liste || []) {
      const minute = Math.floor(s.t / 60) * 60;
      const cle = `${minute}|${s.k}|${s.d}|${s.s}`;
      let g = groupes.get(cle);
      if (!g) groupes.set(cle, (g = { t: minute, debut: s.t, k: s.k, d: s.d, s: s.s, p: 0, q: 0, n: 0, achats: 0, ventes: 0, blocks: 0 }));
      g.p += s.p; g.q += s.q; g.n += 1;
      if (s.c > 0) g.achats += 1; else if (s.c < 0) g.ventes += 1;
      if (s.g === "block") g.blocks += 1;
      g.debut = Math.min(g.debut, s.t);
    }
    return [...groupes.values()].filter((g) => g.p >= primeMin).sort((a, b) => b.p - a.p);
  },
  // taille absolue : même rayon = même prime, quel que soit le moment
  rayon(p) { return Math.max(3, Math.min(24, 2.2 * Math.sqrt(p / 10000))); },
  couleur(s, a) { return s > 0 ? `rgba(58,169,143,${a})` : s < 0 ? `rgba(229,72,77,${a})` : `rgba(141,142,150,${a})`; },

  dessiner(ctx, { chart, serie, temps, groupes, ratio, W, H }) {
    const dessinees = [];
    let horsEcran = 0;
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.clip();
    for (const g of groupes) {                 // les plus grosses d'abord : les petites restent visibles dessus
      const x = Calque.x(chart, temps, g.t);
      const y = serie.priceToCoordinate(g.k * ratio);
      if (x === null || y === null || x < -30 || x > W + 30) continue;
      if (y < 0 || y > H) {
        // strike en dehors de l'écran : petit triangle sur le bord
        horsEcran += 1;
        const yb = y < 0 ? 5 : H - 5, sens = y < 0 ? -1 : 1;
        ctx.beginPath(); ctx.moveTo(x - 4, yb - 2 * sens); ctx.lineTo(x + 4, yb - 2 * sens); ctx.lineTo(x, yb + 3 * sens); ctx.closePath();
        ctx.fillStyle = this.couleur(g.s, 0.85); ctx.fill();
        dessinees.push({ x, y: yb, r: 5, g });
        continue;
      }
      const r = this.rayon(g.p);
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = this.couleur(g.s, 0.4); ctx.fill();
      ctx.lineWidth = g.blocks ? 2 : 1; ctx.strokeStyle = this.couleur(g.s, 0.95); ctx.stroke();
      if (r >= 9) {
        ctx.fillStyle = "rgba(255,255,255,0.92)"; ctx.font = "500 9px JetBrains Mono, monospace";
        ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(g.d, x, y + 0.5);
      }
      dessinees.push({ x, y, r, g });
    }
    ctx.restore();
    dessinees.horsEcran = horsEcran;
    return dessinees;
  },
  survol(dessinees, x, y) {
    let meilleur = null;
    for (const b of dessinees || []) {
      if (Math.hypot(b.x - x, b.y - y) <= b.r + 3 && (!meilleur || b.r < meilleur.r)) meilleur = b;
    }
    return meilleur;
  },
  texte(g, e) {
    const cote = g.achats && !g.ventes ? "Achat" : g.ventes && !g.achats ? "Vente" : g.achats || g.ventes ? "Achats + ventes" : "Côté inconnu";
    const sens = g.s > 0 ? `<span class="pos">haussier</span>` : g.s < 0 ? `<span class="neg">baissier</span>` : "neutre";
    const genre = g.blocks ? (g.blocks === g.n ? "BLOCK" : "SWEEPS + BLOCK") : "SWEEP";
    const fut = e.future.ratio ? `<br><span style="color:#8d8e96">strike ≈ ${e.future.code} ${fmtPrix(Math.round(g.k * e.future.ratio * 4) / 4)}</span>` : "";
    return `<b>${heureNYsec.format(new Date(g.debut * 1000))} NY · ${genre}${g.n > 1 ? ` ×${g.n}` : ""}</b><br>
      ${cote} ${g.k} ${g.d === "C" ? "call" : "put"} · ${g.q.toLocaleString("fr-FR")} contrats<br>
      Prime ${fmtMontant(g.p).replace("+", "")} · ${sens}${fut}`;
  },
};

// ============================================================
const Desk = {
  vue: "sj",                                   // "sj" (QQQ, SPX...) ou "future" (MNQ, MES)
  typeChart: lire("type-chart", "bougies"),
  familles: new Set(lire("familles", FAMILLES_PAR_DEFAUT)),
  nuages: lire("nuages", true),
  fluxChart: lire("flux-chart", true),
  grille: lire("grille", true),
  primeMin: lire("prime-min", 50000),
  cote: lire("cote", "niveaux"),
  derniereBougie: null,
  premiereBougie: null,
  temps: [],
  lignes: [],
  lignesTape: [],
  memos: {},
  signatureNuages: "",
  signatureTape: "",
  bullesChart: [],
  bullesTape: [],
  synchro: false,

  // ----------------------------------------------------------
  init() {
    const theme = {
      layout: { background: { color: "#050506" }, textColor: "#6b6c74", fontSize: 11, fontFamily: "JetBrains Mono, monospace" },
      grid: { vertLines: { visible: false }, horzLines: { color: "#0e0f12" } },
      rightPriceScale: { borderColor: "#17181c", scaleMargins: { top: 0.08, bottom: 0.08 } },
      timeScale: { borderColor: "#17181c", timeVisible: true, secondsVisible: false, rightOffset: 40,
                   tickMarkFormatter: (t) => heureNY.format(new Date(t * 1000)) },
      localization: { timeFormatter: (t) => heureNY.format(new Date(t * 1000)) + " NY" },
      crosshair: { mode: 0, vertLine: { color: "#3a3b42", labelBackgroundColor: "#24252b" },
                   horzLine: { color: "#3a3b42", labelBackgroundColor: "#24252b" } },
    };
    const petit = (id, formatter) => LightweightCharts.createChart($(id), {
      ...theme, timeScale: { ...theme.timeScale, rightOffset: 2 },
      localization: { ...theme.localization, priceFormatter: formatter },
    });
    // la chart principale et la tape ont la même largeur d'axe : leurs bougies tombent pile l'une sous l'autre
    const axe = { ...theme.rightPriceScale, minimumWidth: 96 };

    this.chart = LightweightCharts.createChart($("chart-prix"), { ...theme, rightPriceScale: axe });
    this.serieBougies = this.chart.addCandlestickSeries({
      upColor: "rgba(0,0,0,0)", downColor: "#5b5c64", borderUpColor: "#e6e6e9", borderDownColor: "#5b5c64",
      wickUpColor: "#b5b6bc", wickDownColor: "#5b5c64", priceLineColor: "#e6e6e9",
    });
    this.serieLigne = this.chart.addLineSeries({ color: "#e6e6e9", lineWidth: 1.5, visible: false, priceLineColor: "#e6e6e9" });

    this.chartTape = LightweightCharts.createChart($("chart-tape"), { ...theme, rightPriceScale: axe });
    this.tapeLigne = this.chartTape.addLineSeries({
      color: "#e6e6e9", lineWidth: 1.5, priceLineColor: "#e6e6e9",
      // l'échelle inclut aussi les strikes des grosses bulles proches du prix
      autoscaleInfoProvider: (original) => {
        const r = original();
        if (!r || !r.priceRange || !this.bornesTape) return r;
        return { ...r, priceRange: { minValue: Math.min(r.priceRange.minValue, this.bornesTape.min),
                                     maxValue: Math.max(r.priceRange.maxValue, this.bornesTape.max) } };
      },
    });
    const lier = (a, b) => a.timeScale().subscribeVisibleLogicalRangeChange((r) => {
      if (this.synchro || !r) return;
      this.synchro = true;
      b.timeScale().setVisibleLogicalRange(r);
      this.synchro = false;
    });
    lier(this.chart, this.chartTape);
    lier(this.chartTape, this.chart);

    this.chartDrift = petit("chart-drift", (v) => fmtMontant(v));
    this.driftCalls = this.chartDrift.addLineSeries({ color: COULEURS.call, lineWidth: 1.5, title: "calls" });
    this.driftPuts = this.chartDrift.addLineSeries({ color: COULEURS.put, lineWidth: 1.5, title: "puts" });

    this.chartVix = petit("chart-vix", (v) => v.toFixed(2));
    this.serieVix = this.chartVix.addLineSeries({ color: COULEURS.vix, lineWidth: 1.5,
      // l'échelle inclut la clôture de la veille, pour que sa ligne reste visible
      autoscaleInfoProvider: (original) => {
        const r = original();
        if (!r || !r.priceRange || !this.vixVeille) return r;
        return { ...r, priceRange: { minValue: Math.min(r.priceRange.minValue, this.vixVeille),
                                     maxValue: Math.max(r.priceRange.maxValue, this.vixVeille) } };
      },
    });

    this.chartIv = petit("chart-iv", (v) => `${(v * 100).toFixed(1)} %`);
    this.serieIv = this.chartIv.addLineSeries({ color: COULEURS.iv, lineWidth: 1.5, title: "IV" });
    this.serieRv = this.chartIv.addLineSeries({ color: COULEURS.rv, lineWidth: 1.2, title: "réalisée" });

    new ResizeObserver(() => this.redimensionner()).observe(document.querySelector(".desk"));
    window.addEventListener("resize", () => this.redimensionner());

    document.querySelectorAll("#onglets-chart button").forEach((b) => (b.onclick = () => {
      this.vue = b.dataset.vue;
      document.querySelectorAll("#onglets-chart button").forEach((x) => x.classList.toggle("actif", x === b));
      this.majChart(true);
    }));
    document.querySelectorAll("#onglets-cote button").forEach((b) => {
      b.classList.toggle("actif", b.dataset.cote === this.cote);
      b.onclick = () => {
        this.cote = b.dataset.cote;
        ecrire("cote", this.cote);
        document.querySelectorAll("#onglets-cote button").forEach((x) => x.classList.toggle("actif", x === b));
        this.dessinerCote();
      };
    });
    this.dessinerToggles();
    this.dessinerFiltresPrime();
    this.survols();
    this.boucleCalques();

    App.surDonnees((etat, changement) => {
      if (changement === "reset") return this.vider();
      if (changement === "section") { if (App.section === "desk") setTimeout(() => this.redimensionner(), 0); return; }
      if (!etat || App.section !== "desk") { this.aJour = false; return; }
      this.toutDessiner(changement === "premier");
    });
    App.surDonnees((etat, changement) => {
      if (changement === "section" && App.section === "desk" && App.etat && !this.aJour) this.toutDessiner(false);
    });
    News.surMaj(() => { if (this.cote === "news") this.dessinerCote(); });
  },

  redimensionner() {
    [[this.chart, "chart-prix"], [this.chartTape, "chart-tape"], [this.chartDrift, "chart-drift"],
     [this.chartVix, "chart-vix"], [this.chartIv, "chart-iv"]].forEach(([c, id]) => {
      const z = $(id);
      if (z.clientWidth) c.applyOptions({ width: z.clientWidth, height: z.clientHeight });
    });
    if (App.etat && App.section === "desk") { this.dessinerProfils(); this.dessinerSmile(); }
    this.signatureNuages = this.signatureTape = "";
  },

  vider() {
    [this.serieBougies, this.serieLigne, this.tapeLigne, this.driftCalls, this.driftPuts, this.serieVix, this.serieIv, this.serieRv]
      .forEach((s) => s.setData([]));
    this.lignes.concat(this.lignesTape).forEach(({ serie, ligne }) => serie.removePriceLine(ligne));
    this.lignes = []; this.lignesTape = [];
    if (this.ligneVeille) { this.serieVix.removePriceLine(this.ligneVeille); this.ligneVeille = null; }
    this.memos = {};
    this.derniereBougie = null;
    this.temps = [];
    this.bullesChart = []; this.bullesTape = [];
    this.signatureNuages = this.signatureTape = "";
    $("kpis").innerHTML = "";
  },

  toutDessiner(premier) {
    this.aJour = true;
    const e = App.etat;
    $("onglet-sj").textContent = `${e.symbole} · int map`;
    $("onglet-future").textContent = e.future.code;
    this.dessinerKpis();
    this.majChart(premier);
    this.dessinerCote();
    this.dessinerProfils();
    this.dessinerSmile();
    this.dessinerSeries();
    this.dessinerInfosTape();
  },

  // ----------------------------------------------------------
  // Tuiles
  // ----------------------------------------------------------
  dessinerKpis() {
    const e = App.etat;
    $("kpis").innerHTML = METRIQUES.filter((m) => m.kpi).map((m) => {
      const v = m.valeur(e);
      const classe = m.classe ? m.classe(e) : /^[+]/.test(v) || v === "Long γ" ? "pos" : /^[−-]/.test(v) || v === "Short γ" ? "neg" : "";
      return `<div class="kpi" title="${echapper(m.nom + " : " + m.desc)}"><div class="k-lbl">${m.court || m.nom}</div>
        <div class="k-val ${classe}">${v}</div><div class="k-sub">${m.sous ? m.sous(e) : ""}</div></div>`;
    }).join("");
  },

  // ----------------------------------------------------------
  // Boutons au-dessus de la chart et de la tape
  // ----------------------------------------------------------
  dessinerToggles() {
    const t = $("toggles");
    const bouton = (texte, actif, action, classe = "") => {
      const b = document.createElement("button");
      b.className = `tg ${actif ? "on" : ""} ${classe}`;
      b.textContent = texte;
      b.onclick = action;
      t.appendChild(b);
    };
    t.innerHTML = "";
    bouton(this.typeChart === "bougies" ? "Bougies" : "Ligne", true, () => {
      this.typeChart = this.typeChart === "bougies" ? "ligne" : "bougies";
      ecrire("type-chart", this.typeChart);
      this.dessinerToggles();
      this.majChart(true);
    });
    bouton("Nuages γ", this.nuages, () => { this.nuages = !this.nuages; ecrire("nuages", this.nuages); this.dessinerToggles(); this.signatureNuages = ""; });
    bouton("Bulles flux", this.fluxChart, () => { this.fluxChart = !this.fluxChart; ecrire("flux-chart", this.fluxChart); this.dessinerToggles(); this.signatureNuages = ""; });
    bouton(`Grille ${App.etat ? App.etat.future.racine : "future"}`, this.grille, () => {
      this.grille = !this.grille; ecrire("grille", this.grille); this.dessinerToggles(); this.majLignes();
    });
    FAMILLES.forEach((f, i) => bouton(f, this.familles.has(f), () => {
      this.familles.has(f) ? this.familles.delete(f) : this.familles.add(f);
      ecrire("familles", [...this.familles]);
      this.dessinerToggles();
      this.majLignes();
    }, i === 0 ? "sep" : ""));
  },

  dessinerFiltresPrime() {
    const z = $("filtres-prime");
    z.innerHTML = [25000, 50000, 100000, 250000, 1000000].map((p) =>
      `<button class="tg ${p === this.primeMin ? "on" : ""}" data-p="${p}" title="N'afficher que les ordres d'au moins ${fmtMontant(p).replace("+", "")}">≥ ${fmtMontant(p).replace("+", "").replace(".0", "")}</button>`).join("");
    z.querySelectorAll("button").forEach((b) => (b.onclick = () => {
      this.primeMin = Number(b.dataset.p);
      ecrire("prime-min", this.primeMin);
      this.dessinerFiltresPrime();
      this.majBornesTape();
      this.dessinerInfosTape();
      this.signatureNuages = this.signatureTape = "";
    }));
  },

  // ----------------------------------------------------------
  // Chart de prix + tape
  // ----------------------------------------------------------
  serieActive() { return this.typeChart === "bougies" ? this.serieBougies : this.serieLigne; },
  bougiesVue() { const e = App.etat; return this.vue === "future" ? e.bougies_future : e.bougies; },
  ratioVue() { return this.vue === "future" ? (App.etat.future.ratio || 1) : 1; },

  majChart(reset) {
    const e = App.etat;
    if (!e) return;
    const bougies = this.bougiesVue();
    const serie = this.serieActive();
    this.serieBougies.applyOptions({ visible: this.typeChart === "bougies" });
    this.serieLigne.applyOptions({ visible: this.typeChart === "ligne" });
    const donnees = this.typeChart === "bougies" ? bougies : bougies.map((b) => ({ time: b.time, value: b.close }));
    const lignes = bougies.map((b) => ({ time: b.time, value: b.close }));

    const decimales = this.vue === "future" ? 2 : decimalesSj(e.symbole);
    const format = { priceFormat: { type: "price", precision: decimales, minMove: 1 / 10 ** decimales } };
    serie.applyOptions(format);
    this.tapeLigne.applyOptions(format);

    if (!bougies.length) {
      serie.setData([]);
      this.tapeLigne.setData([]);
    } else if (reset || this.derniereBougie === null || bougies[0].time !== this.premiereBougie) {
      (this.typeChart === "bougies" ? this.serieLigne : this.serieBougies).setData([]);
      serie.setData(donnees);
      this.tapeLigne.setData(lignes);
      if (reset) { this.chart.timeScale().scrollToRealTime(); this.chartTape.timeScale().scrollToRealTime(); }
    } else {
      // mise à jour incrémentale : le zoom et la position de l'utilisateur sont conservés
      donnees.filter((b) => b.time >= this.derniereBougie).forEach((b) => serie.update(b));
      lignes.filter((b) => b.time >= this.derniereBougie).forEach((b) => this.tapeLigne.update(b));
    }
    this.temps = bougies.map((b) => b.time);
    this.derniereBougie = bougies.length ? bougies[bougies.length - 1].time : null;
    this.premiereBougie = bougies.length ? bougies[0].time : null;
    this.majLignes();
    this.majLignesTape();
    this.majBornesTape();

    const fut = e.future, info = fut.ratio_info || {};
    const source = (SOURCES_RATIO[info.source] || ["?"])[0];
    $("chart-info").textContent = this.vue === "future"
      ? `${fut.code} ${fmtPrix(fut.prix)}`
      : `${e.symbole} ${fmtPrix(e.spot, decimales)} · ${e.echeance}`;
    $("note-chart").textContent = this.vue === "future"
      ? `${fut.code} : bougies Yahoo (~10 min de retard). Niveaux convertis depuis le ${e.symbole} avec le ratio ${fut.ratio ? fut.ratio.toFixed(4) : "–"} (${source}).`
      : `${e.symbole} : bougies ${e.mode === "demo" ? "de démonstration" : "FreeFlow"}. Lignes blanches : niveaux ronds du ${fut.code} (ratio ${fut.ratio ? fut.ratio.toFixed(4) : "–"}, ${source}). Nuages : GEX net par strike au fil de la séance. Bulles : gros ordres d'options.`;
    this.signatureNuages = this.signatureTape = "";
  },

  majLignes() {
    const e = App.etat;
    if (!e) return;
    this.lignes.forEach(({ serie, ligne }) => serie.removePriceLine(ligne));
    this.lignes = [];
    const serie = this.serieActive();
    const futur = this.vue === "future";
    const niveaux = futur ? e.niveaux_future : e.niveaux;
    const style = LightweightCharts.LineStyle;

    // niveaux d'options
    Object.entries(niveaux || {}).forEach(([cle, prix]) => {
      const n = NIVEAUX[cle];
      if (!n || !this.familles.has(n.famille)) return;
      const titre = futur || !e.niveaux_future[cle]
        ? majuscules(n.nom)
        : `${majuscules(n.nom)} · ${fmtPrix(e.niveaux_future[cle])}`;
      const ligne = serie.createPriceLine({
        price: prix, color: n.couleur, lineWidth: cle.startsWith("major") ? 2 : 1,
        lineStyle: cle.startsWith("major") ? style.Dashed : style.Dotted,
        axisLabelVisible: true, title: titre,
      });
      this.lignes.push({ serie, ligne });
    });

    // grille du micro-future (MNQ tous les 100 pts, MES tous les 25 pts)
    if (this.grille && e.future.ratio) {
      const bougies = this.bougiesVue();
      if (bougies.length) {
        const bas = Math.min(...bougies.map((b) => b.low)), haut = Math.max(...bougies.map((b) => b.high));
        const ratio = futur ? 1 : e.future.ratio;
        const marge = (haut - bas) * 0.6 + bas * 0.003;
        let pas = e.future.pas_grille;
        const debutF = (bas - marge) * ratio, finF = (haut + marge) * ratio;
        while ((finF - debutF) / pas > 14) pas *= 2;
        for (let p = Math.ceil(debutF / pas) * pas; p <= finF; p += pas) {
          const ligne = serie.createPriceLine({
            price: p / ratio, color: "rgba(230,230,233,0.28)", lineWidth: 1, lineStyle: style.SparseDotted,
            axisLabelVisible: true, axisLabelColor: "#141519", axisLabelTextColor: "#c8c8cc",
            title: `${e.future.code} ${p.toLocaleString("fr-FR")}`,
          });
          this.lignes.push({ serie, ligne });
        }
      }
    }
    this.signatureNuages = "";
  },

  majLignesTape() {
    const e = App.etat;
    this.lignesTape.forEach(({ serie, ligne }) => serie.removePriceLine(ligne));
    this.lignesTape = [];
    const niveaux = this.vue === "future" ? e.niveaux_future : e.niveaux;
    ["call_wall", "put_wall", "gamma_flip", "major_long_gamma", "major_short_gamma", "plus_1_sigma", "moins_1_sigma"].forEach((cle) => {
      if (niveaux[cle] === undefined) return;
      const ligne = this.tapeLigne.createPriceLine({
        price: niveaux[cle], color: NIVEAUX[cle].couleur, lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dotted, axisLabelVisible: true, title: majuscules(NIVEAUX[cle].nom),
      });
      this.lignesTape.push({ serie: this.tapeLigne, ligne });
    });
  },

  // la tape montre aussi les strikes des grosses bulles proches du prix (±1,5 %)
  majBornesTape() {
    const e = App.etat;
    if (!e) return;
    const ratio = this.ratioVue(), spot = e.spot;
    const ks = Flux.agreger(e.flux_options, this.primeMin).map((g) => g.k).filter((k) => Math.abs(k - spot) / spot < 0.015);
    this.bornesTape = ks.length ? { min: Math.min(...ks) * ratio, max: Math.max(...ks) * ratio } : null;
  },

  dessinerInfosTape() {
    const e = App.etat;
    if (!e) return;
    const m = e.metriques;
    const groupes = Flux.agreger(e.flux_options, this.primeMin);
    $("tape-info").textContent = (e.flux_options || []).length
      ? `${groupes.length} bulles ≥ ${fmtMontant(this.primeMin).replace("+", "").replace(".0", "")} · ↑ ${fmtMontant(m.flux_haussier).replace("+", "")} · ↓ ${fmtMontant(m.flux_baissier).replace("+", "")}`
      : "aucun sweep pour l'instant";
  },

  // ----------------------------------------------------------
  // Calques : nuages de gamma + bulles (chart), bulles (tape)
  // ----------------------------------------------------------
  boucleCalques() {
    const dessiner = () => {
      try {
        if (App.section === "desk") { this.dessinerCalqueChart(); this.dessinerCalqueTape(); }
      } catch (err) { console.error(err); }
      requestAnimationFrame(dessiner);
    };
    requestAnimationFrame(dessiner);
  },

  signature(chart, serie, zone, extra) {
    const e = App.etat, ts = chart.timeScale(), r = ts.getVisibleLogicalRange();
    return [zone.clientWidth, zone.clientHeight, ts.width(), window.devicePixelRatio, r && r.from.toFixed(2), r && r.to.toFixed(2),
      serie.priceToCoordinate(e ? e.spot * this.ratioVue() : 0), serie.priceToCoordinate(e ? e.spot * this.ratioVue() * 1.01 : 1),
      App.version, this.vue, this.typeChart, this.primeMin, ...extra].join("|");
  },

  dessinerCalqueChart() {
    const canvas = $("nuages"), zone = canvas.parentElement, e = App.etat;
    const serie = this.serieActive(), ts = this.chart.timeScale();
    const sig = this.signature(this.chart, serie, zone, [this.nuages, this.fluxChart]);
    if (sig === this.signatureNuages) return;
    this.signatureNuages = sig;
    const { ctx, dpr } = Calque.preparer(canvas, zone.clientWidth, zone.clientHeight);
    this.bullesChart = [];
    const W = ts.width(), H = zone.clientHeight - ts.height();
    if (!e || W <= 0 || H <= 0 || !this.temps.length) return;
    if (this.nuages) this.dessinerNuages(ctx, dpr, W, H, zone);
    if (this.fluxChart) {
      this.bullesChart = Flux.dessiner(ctx, { chart: this.chart, serie, temps: this.temps,
        groupes: Flux.agreger(e.flux_options, this.primeMin), ratio: this.ratioVue(), W, H });
    }
  },

  dessinerCalqueTape() {
    const canvas = $("bulles-tape"), zone = canvas.parentElement, e = App.etat;
    const ts = this.chartTape.timeScale();
    const sig = this.signature(this.chartTape, this.tapeLigne, zone, []);
    if (sig === this.signatureTape) return;
    this.signatureTape = sig;
    const { ctx } = Calque.preparer(canvas, zone.clientWidth, zone.clientHeight);
    this.bullesTape = [];
    const W = ts.width(), H = zone.clientHeight - ts.height();
    if (!e || W <= 0 || H <= 0 || !this.temps.length) return;
    this.bullesTape = Flux.dessiner(ctx, { chart: this.chartTape, serie: this.tapeLigne, temps: this.temps,
      groupes: Flux.agreger(e.flux_options, this.primeMin), ratio: this.ratioVue(), W, H });
    const hors = this.bullesTape.horsEcran;
    $("note-tape").textContent = `Chaque bulle = les gros ordres agressifs d'une minute sur un strike (échéance ${e.echeance}), placée au prix du strike. ` +
      `Vert : achat de calls ou vente de puts. Rouge : achat de puts ou vente de calls. Contour épais : block. Survole une bulle pour le détail.` +
      (hors ? ` ${hors} bulle${hors > 1 ? "s" : ""} hors écran (▲▼ sur les bords).` : "");
  },

  dessinerNuages(ctx, dpr, W, H, zone) {
    const e = App.etat, h = e.historique || { t: [], strikes: [], v: [] };
    const serie = this.serieActive(), ratio = this.ratioVue();
    const profil = e.profil || [];
    // échelle commune : 97e percentile (un seul strike énorme n'écrase pas tout le reste)
    const valeurs = h.v.flat().concat(profil.map((l) => l.net_gex)).map(Math.abs).filter((v) => v > 0).sort((a, b) => a - b);
    if (!valeurs.length) return;
    const max = valeurs[Math.floor(valeurs.length * 0.97)] || valeurs[valeurs.length - 1];

    const flou = this.calqueFlou || (this.calqueFlou = document.createElement("canvas"));
    flou.width = Math.round(zone.clientWidth * dpr); flou.height = Math.round(zone.clientHeight * dpr);
    const f = flou.getContext("2d");
    f.setTransform(dpr, 0, 0, dpr, 0, 0);
    f.save();
    f.beginPath(); f.rect(0, 0, W, H); f.clip();

    // une « colonne » = les strikes d'une minute, chacun à SON prix sur l'axe
    const colonne = (x, largeur, strikes, vals, attenuation = 1) => {
      const pas = strikes.length > 1 ? Math.min(...strikes.slice(1).map((s, i) => s - strikes[i]).filter((d) => d > 0)) : 1;
      strikes.forEach((k, j) => {
        const v = vals[j];
        const a = Math.min(1, Math.abs(v) / max);
        if (!v || a < 0.12) return;
        const y = serie.priceToCoordinate(k * ratio), y2 = serie.priceToCoordinate((k + pas) * ratio);
        if (y === null || y2 === null || y < -20 || y > H + 20) return;
        // bande continue centrée sur le prix du strike (le flou la transforme en nuage)
        // épaisseur : l'écart entre deux strikes, plafonnée quand on zoome (sinon la bande cache les bougies)
        const hauteur = Math.max(2, Math.min(Math.abs(y2 - y) * (0.75 + 0.25 * a), 6 + 16 * a));
        const alpha = (0.04 + 0.6 * a ** 1.8) * attenuation;
        f.fillStyle = v > 0 ? `rgba(58,169,143,${alpha})` : `rgba(229,72,77,${alpha})`;
        f.fillRect(x, y - hauteur / 2, largeur, hauteur);
      });
    };

    // l'historique de la séance
    const xs = h.t.map((t) => Calque.x(this.chart, this.temps, t));
    for (let i = 0; i < h.t.length; i++) {
      const x = xs[i];
      if (x === null || x < -40 || x > W + 40) continue;
      const xSuivant = i + 1 < h.t.length && xs[i + 1] !== null ? xs[i + 1] : x + 6;
      colonne(x, Math.max(2, Math.min(xSuivant - x, 60)) + 0.5, h.strikes, h.v[i]);
    }
    // le profil actuel, prolongé à droite de la dernière bougie : là où sont les murs MAINTENANT
    const xDernier = Calque.x(this.chart, this.temps, this.temps[this.temps.length - 1]);
    if (xDernier !== null && xDernier < W && profil.length) {
      const strikes = profil.map((l) => l.strike), vals = profil.map((l) => l.net_gex);
      for (let x = xDernier + 3; x < W; x += 8) colonne(x, 8.5, strikes, vals, 0.85 * (1 - (x - xDernier) / (W - xDernier + 40)));
    }
    f.restore();
    ctx.save();
    ctx.filter = `blur(${4 * dpr}px)`;          // le flou se compte en pixels réels de l'écran
    ctx.drawImage(flou, 0, 0, zone.clientWidth, zone.clientHeight);
    ctx.restore();

    // étiquettes des plus gros strikes actuels, à droite de la dernière bougie
    if (xDernier === null || !profil.length) return;
    const yNiveaux = this.lignes.map(({ ligne }) => serie.priceToCoordinate(ligne.options().price)).filter((y) => y !== null);
    const xTexte = Math.min(W - 170, xDernier + 14);
    let dernierY = -Infinity;
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.clip();
    ctx.font = "10px JetBrains Mono, monospace";
    profil.map((l) => ({ k: l.strike, v: l.net_gex, y: serie.priceToCoordinate(l.strike * ratio) }))
      .filter((p) => p.v && p.y !== null && p.y > 8 && p.y < H - 4 && !yNiveaux.some((y) => Math.abs(y - p.y) < 9))
      .sort((a, b) => Math.abs(b.v) - Math.abs(a.v)).slice(0, 5)
      .sort((a, b) => a.y - b.y)
      .forEach((p) => {
        const y = Math.max(p.y + 3, dernierY + 13);
        dernierY = y;
        const prix = ratio === 1 ? p.k : fmtPrix(Math.round(p.k * ratio * 4) / 4);
        const texte = `${prix} · ${fmtMontant(p.v)}`;
        const largeur = ctx.measureText(texte).width;
        ctx.fillStyle = "rgba(5,5,6,0.85)";
        ctx.fillRect(xTexte - 4, y - 10, largeur + 8, 14);
        ctx.fillStyle = p.v > 0 ? "#6cc9b1" : "#f07b7f";
        ctx.fillText(texte, xTexte, y);
      });
    ctx.restore();
  },

  // survol des bulles : détail de l'ordre dans l'infobulle
  survols() {
    const brancher = (zone, cle) => {
      zone.addEventListener("mousemove", (ev) => {
        if (!App.etat) return;
        const r = zone.getBoundingClientRect();
        const b = Flux.survol(this[cle], ev.clientX - r.left, ev.clientY - r.top);
        if (b) { montrerTip(Flux.texte(b.g, App.etat), ev.clientX, ev.clientY); this.tipBulle = true; }
        else if (this.tipBulle) { cacherTip(); this.tipBulle = false; }
      });
      zone.addEventListener("mouseleave", () => { cacherTip(); this.tipBulle = false; });
    };
    brancher($("nuages").parentElement, "bullesChart");
    brancher($("zone-tape"), "bullesTape");
  },

  // ----------------------------------------------------------
  // Panneau latéral
  // ----------------------------------------------------------
  dessinerCote() {
    const e = App.etat, corps = $("cote-corps");
    if (this.cote === "news") return this.dessinerNewsMini();
    if (!e) { corps.innerHTML = `<div class="vide">chargement…</div>`; return; }

    if (this.cote === "metriques") {
      corps.innerHTML = METRIQUES.map((m) => `<div class="metr-ligne"><div><div class="m-nom">${m.nom}</div>
        <div class="m-desc">${m.desc}</div></div><div class="m-val">${m.valeur(e)}${m.sous && m.sous(e) ? `<div class="m-desc">${m.sous(e)}</div>` : ""}</div></div>`).join("");
      return;
    }

    let html = `<table class="table"><thead><tr><th>Niveau</th><th class="num">${e.symbole}</th><th class="num">${e.future.code}</th><th class="num">Dist.</th></tr></thead><tbody>`;
    FAMILLES.forEach((fam) => {
      const cles = Object.keys(NIVEAUX).filter((c) => NIVEAUX[c].famille === fam && e.niveaux[c] !== undefined);
      if (!cles.length) return;
      html += `<tr class="famille"><td colspan="4">${fam}</td></tr>`;
      cles.forEach((c) => {
        const d = dist(e, c);
        html += `<tr><td><span class="trait" style="border-color:${NIVEAUX[c].couleur}"></span>${NIVEAUX[c].nom}</td>
          <td class="num">${fmtPrix(e.niveaux[c], decimalesSj(e.symbole))}</td>
          <td class="num">${fmtPrix(e.niveaux_future[c])}</td>
          <td class="num ${d >= 0 ? "pos" : "neg"}">${fmtSigne(d)}%</td></tr>`;
      });
    });
    corps.innerHTML = html + `</tbody></table>`;
  },

  dessinerNewsMini() {
    const articles = News.articles.slice(0, 25);
    $("cote-corps").innerHTML = articles.length
      ? articles.map((a) => `<div class="news-mini"><div class="n-meta">${News.relatif(a.ts)} · ${echapper(a.source)}${a.important ? ` · <span class="neg">important</span>` : ""}</div>
          <a href="${echapper(a.url)}" target="_blank" rel="noopener">${echapper(a.titre)}</a></div>`).join("")
        + `<div class="news-mini"><a href="#news">Tout le fil d'actualités →</a></div>`
      : `<div class="vide">pas encore de news</div>`;
  },

  // ----------------------------------------------------------
  // Profils par strike
  // ----------------------------------------------------------
  dessinerProfils() {
    const e = App.etat;
    if (!e) return;
    const rep = (cles) => [{ prix: e.spot, couleur: "#e6e6e9", texte: "SPOT " + fmtPrix(e.spot, decimalesSj(e.symbole)) }]
      .concat(cles.filter((c) => e.niveaux[c] !== undefined).map((c) => ({ prix: e.niveaux[c], couleur: NIVEAUX[c].couleur, texte: majuscules(NIVEAUX[c].nom) })));
    const versFuture = e.future.ratio ? (k) => `${e.future.code} ≈ ${fmtPrix(Math.round(k * e.future.ratio * 4) / 4)}` : null;
    Graph.barres($("p-gex"), e.profil, [{ cle: "net_gex", nom: "GEX net", signe: true }],
      { reperes: rep(["call_wall", "put_wall", "gamma_flip"]), versFuture });
    Graph.barres($("p-oi"), e.profil, [
      { cle: "call_oi", nom: "OI calls", couleur: COULEURS.call },
      { cle: "put_oi", nom: "OI puts", couleur: COULEURS.put, inverser: true },
    ], { reperes: rep(["max_call_oi", "max_put_oi"]), brut: true, versFuture });
    const flux = this.grilleComplete(e.flux_strike || []);
    if (flux.length) {
      Graph.barres($("p-flux"), flux, [
        { cle: "call_net", nom: "Calls (prime nette)", couleur: COULEURS.call },
        { cle: "put_net", nom: "Puts (prime nette)", couleur: COULEURS.put },
      ], { coteACote: true, reperes: rep(["call_wall", "put_wall"]), versFuture });
    } else {
      $("p-flux").innerHTML = `<div class="vide">aucun ordre sur cette échéance pour l'instant<br><small>(normal hors séance ou juste après l'ouverture)</small></div>`;
    }
    Graph.barres($("p-dex"), e.profil, [{ cle: "dex", nom: "DEX", signe: true }], { reperes: rep(["delta_wall", "delta_flip"]), versFuture });
    Graph.barres($("p-vex"), e.profil, [{ cle: "vex", nom: "Vanna", signe: true }], { reperes: rep(["vanna_wall", "vanna_flip"]), versFuture });
    Graph.barres($("p-charm"), e.profil, [{ cle: "charmex", nom: "Charm", signe: true }], { reperes: rep(["charm_zone"]), versFuture });
  },

  // strikes manquants remplis par des zéros : chaque ligne du graphique = le même écart de prix
  grilleComplete(lignes) {
    if (lignes.length < 2) return lignes;
    const ks = lignes.map((l) => l.strike);
    const pas = Math.min(...ks.slice(1).map((k, i) => k - ks[i]).filter((d) => d > 0));
    if (!(pas > 0) || (ks[ks.length - 1] - ks[0]) / pas > 400) return lignes;
    const parK = new Map(lignes.map((l) => [l.strike, l]));
    const sortie = [];
    for (let k = ks[0]; k <= ks[ks.length - 1] + 1e-9; k = Math.round((k + pas) * 1e6) / 1e6) sortie.push(parK.get(k) || { strike: k, call_net: 0, put_net: 0 });
    return sortie;
  },

  // ----------------------------------------------------------
  // Smile de volatilité
  // ----------------------------------------------------------
  dessinerSmile() {
    const e = App.etat;
    if (!e) return;
    const s = e.smile || {}, sk = s.skew && s.skew.skew !== undefined ? s.skew : null;
    const sigma = e.metriques.mouvement_attendu;
    const largeur = Math.max(sigma ? 2.5 * sigma : 0, e.spot * 0.015);
    const garder = (p) => Math.abs(p.strike - e.spot) <= largeur;
    const pts = (s.points || []).filter(garder).map((p) => ({ x: p.strike, y: p.iv * 100 }));
    if (pts.length < 3) {
      $("p-smile").innerHTML = `<div class="vide">IV par strike non fournie par la source pour cette échéance</div>`;
      $("note-smile").textContent = "";
      return;
    }
    const ref = (s.reference || []).filter(garder).map((p) => ({ x: p.strike, y: p.iv * 100 }));
    Graph.courbe($("p-smile"), pts, {
      couleur: COULEURS.iv, formatX: (v) => v, formatY: (v) => `${v.toFixed(1)}%`,
      autres: ref.length > 2 ? [{ points: ref, couleur: "#6b6c74", tirets: "3 3" }] : [],
      marqueurs: [{ x: e.spot, couleur: "#e6e6e9", texte: "spot" }],
      points: sk ? [{ x: sk.k_put, y: sk.iv_put * 100, couleur: COULEURS.put, texte: "put −1σ" },
                    { x: sk.k_call, y: sk.iv_call * 100, couleur: COULEURS.call, texte: "call +1σ" }] : [],
    });
    $("smile-ref").textContent = s.minute_reference && ref.length > 2 ? `à ${heureNY.format(new Date(s.minute_reference * 1000))}` : "(dans 15 min)";
    $("note-smile").textContent = sk
      ? `Skew ${fmtSigne(sk.skew * 100, 1)} pts : ${sk.skew > 0.005 ? "les puts (protections) coûtent plus cher que les calls, situation normale." : sk.skew < -0.005 ? "les calls coûtent plus cher que les puts : appétit pour la hausse (rare)." : "puts et calls au même prix."} Courbe qui monte en bloc = la peur augmente.`
      : "";
  },

  // ----------------------------------------------------------
  // Séries temporelles : net drift, VIX, IV vs réalisée
  // ----------------------------------------------------------
  // données triées, sans doublon ; mise à jour incrémentale pour garder le zoom
  poserSerie(serie, points, memo) {
    const tries = points.filter((p) => p.time && p.value !== null && p.value !== undefined && !isNaN(p.value)).sort((a, b) => a.time - b.time)
      .filter((p, i, t) => i === 0 || p.time !== t[i - 1].time);
    const m = this.memos[memo];
    if (!tries.length) { serie.setData([]); this.memos[memo] = null; return; }
    if (m && m.premier === tries[0].time && tries.length >= m.n) tries.filter((p) => p.time >= m.dernier).forEach((p) => serie.update(p));
    else serie.setData(tries);
    this.memos[memo] = { premier: tries[0].time, dernier: tries[tries.length - 1].time, n: tries.length };
  },

  dessinerSeries() {
    const e = App.etat;
    const drift = e.drift || [];
    this.poserSerie(this.driftCalls, drift.map((p) => ({ time: p.ts, value: p.call_cum })), "calls");
    this.poserSerie(this.driftPuts, drift.map((p) => ({ time: p.ts, value: p.put_cum })), "puts");

    const vix = e.vix || {};
    this.vixVeille = vix.veille || null;
    this.poserSerie(this.serieVix, (vix.serie || []).map((p) => ({ time: p.t, value: p.v })), "vix");
    if (this.ligneVeille) { this.serieVix.removePriceLine(this.ligneVeille); this.ligneVeille = null; }
    if (vix.veille) {
      this.ligneVeille = this.serieVix.createPriceLine({ price: vix.veille, color: "#55565e", lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: "veille" });
    }
    $("vix-info").textContent = vix.prix ? `${fmtPrix(vix.prix)} · ${fmtSigne(vix.variation)} %` : "en attente";

    const v = e.volatilite || {};
    this.poserSerie(this.serieIv, (v.serie_iv || []).map((p) => ({ time: p.t, value: p.v })), "iv");
    this.poserSerie(this.serieRv, (v.serie_rv || []).map((p) => ({ time: p.t, value: p.v })), "rv");
    $("iv-info").innerHTML = v.ecart === null || v.ecart === undefined ? ""
      : `<span class="${{ chere: "neg", bon_marche: "pos" }[v.verdict] || ""}">${VERDICT_IV[v.verdict]}</span> · écart ${fmtSigne(v.ecart * 100, 1)} pts`;
  },
};

Desk.init();
