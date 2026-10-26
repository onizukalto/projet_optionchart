// ============================================================
// Section APPRENDRE : une fiche par niveau / métrique,
// avec un petit graphique tracé sur les données du moment et un exemple concret.
// ============================================================

const Apprendre = {
  // valeur d'un niveau, en sous-jacent et en future : « 742,00 (MNQZ6 30 615,25) »
  n(e, cle) {
    if (e.niveaux[cle] === undefined) return "–";
    const f = e.niveaux_future[cle];
    return `${fmtPrix(e.niveaux[cle], decimalesSj(e.symbole))}${f ? ` (${e.future.code} ${fmtPrix(f)})` : ""}`;
  },
  au_dessus(e, cle) { return e.spot >= e.niveaux[cle] ? "au-dessus" : "en dessous"; },

  // ---------- les petits graphiques ----------
  reperes(e, cles) {
    return [{ prix: e.spot, couleur: "#e6e6e9", texte: "SPOT" }]
      .concat(cles.filter((c) => e.niveaux[c] !== undefined).map((c) => ({ prix: e.niveaux[c], couleur: NIVEAUX[c].couleur, texte: majuscules(NIVEAUX[c].nom) })));
  },
  barres(cleSerie, cleNiveau, series) {
    return (zone, e) => Graph.barres(zone, e.profil, series || [{ cle: cleSerie, nom: cleSerie, signe: true }],
      { compact: true, reperes: this.reperes(e, [cleNiveau]), surligner: e.niveaux[cleNiveau] });
  },
  cumul(cles) {
    return (zone, e) => {
      let somme = 0;
      const pts = [...e.profil].sort((a, b) => a.strike - b.strike).map((l) => ({ x: l.strike, y: (somme += l.net_gex) }));
      Graph.courbe(zone, pts, { zero: true, remplir: true, couleur: "#e6e6e9", formatX: (v) => v,
        marqueurs: [{ x: e.spot, couleur: "#e6e6e9", texte: "spot" }]
          .concat(cles.filter((c) => e.niveaux[c] !== undefined).map((c) => ({ x: e.niveaux[c], couleur: NIVEAUX[c].couleur, texte: NIVEAUX[c].nom }))) });
    };
  },

  // ---------- les fiches ----------
  fiches() {
    const OI = [{ cle: "call_oi", nom: "calls", couleur: COULEURS.call }, { cle: "put_oi", nom: "puts", couleur: COULEURS.put, inverser: true }];
    const VOL = [{ cle: "call_vol", nom: "calls", couleur: COULEURS.call }, { cle: "put_vol", nom: "puts", couleur: COULEURS.put, inverser: true }];
    return [
      { cle: "call_wall", graph: this.barres("net_gex", "call_wall"),
        quoi: "Le strike où les calls concentrent le plus de gamma positif.",
        lire: "Les teneurs de marché y sont fortement long gamma : quand le prix monte vers ce niveau, ils <b>vendent</b> pour se couvrir. Il agit souvent comme une <b>résistance</b>, d'autant plus qu'on approche de l'expiration.",
        exemple: (e) => `Le call wall est à ${this.n(e, "call_wall")}. Si le prix y arrive avec un momentum qui ralentit, c'est une zone classique de prise de profit sur un long, ou de recherche de short avec confirmation (absorption, delta qui se retourne).` },
      { cle: "put_wall", graph: this.barres("net_gex", "put_wall"),
        quoi: "Le strike où les puts concentrent le plus de gamma négatif.",
        lire: "C'est souvent un <b>support</b> : beaucoup de protections y sont achetées, et le marché a tendance à y ralentir. S'il casse, la baisse peut s'accélérer car on passe dans une zone où les couvertures amplifient le mouvement.",
        exemple: (e) => `Le put wall est à ${this.n(e, "put_wall")}. Un test de ce niveau avec absorption acheteuse est un setup de long ; une clôture franche en dessous invalide l'idée.` },
      { cle: "gamma_flip", graph: this.cumul(["gamma_flip"]),
        quoi: "Le prix, près du spot, où le GEX net par strike change de signe.",
        lire: "La courbe montre le GEX cumulé strike par strike. <b>Au-dessus du flip</b>, les teneurs de marché freinent les mouvements (journées plutôt calmes, retours vers la moyenne). <b>En dessous</b>, ils les amplifient (tendances, accélérations).",
        exemple: (e) => `Le spot est ${this.au_dessus(e, "gamma_flip")} du gamma flip (${this.n(e, "gamma_flip")}). ${e.spot >= e.niveaux.gamma_flip ? "On privilégie les rotations entre niveaux." : "On s'attend à des mouvements plus directionnels : les breakouts tiennent mieux."}` },
      { cle: "major_long_gamma", graph: this.barres("net_gex", "major_long_gamma"),
        quoi: "Le strike avec le plus gros GEX net <b>positif</b>.",
        lire: "C'est la zone où l'effet « amortisseur » est le plus fort. Le prix a tendance à y <b>coller</b> (pin) ou à y rebondir.",
        exemple: (e) => `Major long γ à ${this.n(e, "major_long_gamma")} : si le prix tourne autour en fin de séance, attends-toi à un range serré.` },
      { cle: "major_short_gamma", graph: this.barres("net_gex", "major_short_gamma"),
        quoi: "Le strike avec le plus gros GEX net <b>négatif</b>.",
        lire: "Zone où les couvertures <b>accélèrent</b> le prix. Les traversées y sont souvent rapides, avec de la volatilité.",
        exemple: (e) => `Major short γ à ${this.n(e, "major_short_gamma")} : réduis la taille ou élargis le stop quand le prix entre dans cette zone.` },
      { cle: "vol_trigger", graph: this.cumul(["vol_trigger", "gamma_flip"]),
        quoi: "Le niveau où le gamma total de toute la chaîne passe par zéro, recalculé en déplaçant le prix.",
        lire: "Proche du gamma flip mais plus « global ». Sous le vol trigger, la volatilité a tendance à <b>s'accélérer</b> ; au-dessus, à se calmer.",
        exemple: (e) => `Vol trigger à ${this.n(e, "vol_trigger")}. Une cassure sous ce niveau est un signal d'alerte pour les positions longues.` },
      { cle: "max_pain",
        graph: (zone, e) => Graph.courbe(zone, (e.pain || []).map((p) => ({ x: p.strike, y: p.pain })), { couleur: "#9aa3b2", remplir: true,
          formatX: (v) => v, marqueurs: [{ x: e.niveaux.max_pain, couleur: "#9aa3b2", texte: "max pain" }, { x: e.spot, couleur: "#e6e6e9", texte: "spot" }] }),
        quoi: "Le strike où les acheteurs d'options <b>perdent le plus</b> à l'expiration.",
        lire: "La courbe montre ce que les options rapporteraient à leurs acheteurs selon le prix de clôture. Le max pain est son point le plus bas. Le prix a parfois tendance à s'en rapprocher le jour de l'expiration.",
        exemple: (e) => `Max pain à ${this.n(e, "max_pain")}. Utile surtout l'après-midi d'une échéance 0DTE, beaucoup moins en début de semaine.` },
      { cle: "plus_1_sigma",
        graph: (zone, e) => {
          const b = e.bougies.slice(-180);
          const s = e.metriques.mouvement_attendu;
          Graph.courbe(zone, b.map((x) => ({ x: x.time, y: x.close })), { couleur: "#e6e6e9", formatX: (t) => heureNY.format(new Date(t * 1000)),
            bande: s ? { bas: e.spot - s, haut: e.spot + s, couleur: "rgba(200,200,204,0.08)" } : null,
            lignesH: s ? [{ y: e.spot + s, couleur: "#c8c8cc", texte: "+1σ" }, { y: e.spot - s, couleur: "#c8c8cc", texte: "−1σ" }] : [] });
        },
        titre: "±1σ close (mouvement attendu)",
        quoi: "La fourchette où le prix devrait finir l'échéance dans environ <b>68 %</b> des cas, d'après la volatilité implicite.",
        lire: "Calcul : prix × volatilité implicite × √(temps restant). Sortir de la bande est un mouvement « inhabituel » : soit une tendance forte, soit un excès qui a des chances de revenir.",
        exemple: (e) => `Mouvement attendu : ±${fmtPrix(e.metriques.mouvement_attendu, decimalesSj(e.symbole))} sur ${e.symbole}${e.metriques.mouvement_attendu_future ? `, soit ±${fmtPrix(e.metriques.mouvement_attendu_future, 0)} points sur ${e.future.racine}` : ""}. Bande : ${this.n(e, "moins_1_sigma")} → ${this.n(e, "plus_1_sigma")}.` },
      { cle: "delta_wall", graph: this.barres("dex", "delta_wall"),
        quoi: "Le strike avec la plus grosse exposition au <b>delta</b>.",
        lire: "C'est là que la couverture directionnelle des teneurs de marché pèse le plus. Un mouvement autour de ce strike force de gros ajustements.",
        exemple: (e) => `Delta wall à ${this.n(e, "delta_wall")}.` },
      { cle: "delta_flip", graph: this.barres("dex", "delta_flip"),
        quoi: "Le prix où l'exposition au delta change de signe entre deux strikes.",
        lire: "De part et d'autre, les couvertures se font dans des sens opposés : c'est une frontière de comportement.",
        exemple: (e) => `Delta flip à ${this.n(e, "delta_flip")} : spot ${this.au_dessus(e, "delta_flip")}.` },
      { cle: "vanna_wall", graph: this.barres("vex", "vanna_wall"),
        quoi: "Le vanna mesure comment le delta change quand <b>la volatilité implicite</b> bouge. Le vanna wall est le strike qui en concentre le plus.",
        lire: "Quand le VIX/VXN baisse, les couvertures liées au vanna poussent souvent le marché vers le haut (et inversement). Ce strike est là où l'effet est le plus fort.",
        exemple: (e) => `Vanna wall à ${this.n(e, "vanna_wall")}. Un jour de forte baisse de volatilité (après un CPI rassurant, par exemple), le prix a tendance à être « aspiré » vers ce niveau.` },
      { cle: "vanna_flip", graph: this.barres("vex", "vanna_flip"),
        quoi: "Le prix où le vanna change de signe.",
        lire: "Il indique où l'effet d'une baisse (ou d'une hausse) de volatilité <b>s'inverse</b>.",
        exemple: (e) => `Vanna flip à ${this.n(e, "vanna_flip")}.` },
      { cle: "vega_wall", graph: this.barres("vegaex", "vega_wall"),
        quoi: "Le strike le plus sensible au <b>niveau</b> de la volatilité implicite.",
        lire: "Utile les jours d'annonces (CPI, FOMC, NFP) : c'est là que les variations de volatilité déplacent le plus les couvertures.",
        exemple: (e) => `Vega wall à ${this.n(e, "vega_wall")}.` },
      { cle: "charm_zone", graph: this.barres("charmex", "charm_zone"),
        quoi: "Le charm mesure comment le delta change <b>avec le temps qui passe</b>. La charm zone est le strike qui en concentre le plus.",
        lire: "Son effet grandit en fin de séance et le jour de l'expiration : les couvertures se déplacent même si le prix ne bouge pas, ce qui crée un effet « aimant ».",
        exemple: (e) => `Charm zone à ${this.n(e, "charm_zone")} : surveille-la surtout après 14 h (heure de New York).` },
      { cle: "max_call_oi", graph: this.barres("call_oi", "max_call_oi", OI),
        quoi: "Le strike avec le plus de <b>calls ouverts</b>.",
        lire: "Indépendamment des greeks, c'est un niveau que beaucoup de participants surveillent : souvent une cible ou une résistance.",
        exemple: (e) => `Max call OI à ${this.n(e, "max_call_oi")}.` },
      { cle: "max_put_oi", graph: this.barres("put_oi", "max_put_oi", OI),
        quoi: "Le strike avec le plus de <b>puts ouverts</b>.",
        lire: "Souvent un niveau de protection important pour le marché : un support psychologique.",
        exemple: (e) => `Max put OI à ${this.n(e, "max_put_oi")}.` },
      { cle: "hvl", graph: this.barres("call_vol", "hvl", VOL),
        quoi: "<i>High Volume Level</i> : le strike le plus <b>échangé aujourd'hui</b>.",
        lire: "Contrairement à l'open interest (qui reflète la veille), il montre où se concentre l'activité du jour. Les nouveaux flux s'y forment.",
        exemple: (e) => `HVL à ${this.n(e, "hvl")}.` },
      { cle: "put_call_oi", metrique: true,
        graph: (zone, e) => Graph.jauge(zone, e.metriques.put_call_oi, 0.4, 2, { texte: fmtRatio(e.metriques.put_call_oi), texteMin: "0.4 · calls", texteMax: "2 · puts",
          reperes: [{ v: 1, texte: "1" }], gauche: COULEURS.call, droite: COULEURS.put }),
        quoi: "Nombre de puts ouverts divisé par le nombre de calls ouverts (zone affichée).",
        lire: "Au-dessus de 1 : plus de protections que de paris haussiers. Un ratio très élevé peut signaler de la peur… et donc du carburant pour un rebond si elle se dissipe.",
        exemple: (e) => `Put/Call OI = ${fmtRatio(e.metriques.put_call_oi)}, Put/Call volume = ${fmtRatio(e.metriques.put_call_volume)}.` },
      { cle: "hedging_pressure", metrique: true,
        graph: (zone, e) => Graph.jauge(zone, e.metriques.hedging_pressure, 0, 100, { texte: `${Math.round(e.metriques.hedging_pressure ?? 0)}`, reperes: [{ v: 50, texte: "50" }],
          gauche: "#1c1c20", droite: COULEURS.neg }),
        quoi: "Score de 0 à 100 : le besoin de couverture actuel des teneurs de marché, comparé au reste de la séance.",
        lire: "Élevé : les couvertures peuvent créer des mouvements rapides. Faible : le marché est plus libre.",
        exemple: (e) => `Hedging pressure actuelle : ${e.metriques.hedging_pressure !== null && e.metriques.hedging_pressure !== undefined ? Math.round(e.metriques.hedging_pressure) : "–"} / 100.` },
      { cle: "concentration_1pct", metrique: true,
        graph: (zone, e) => Graph.jauge(zone, e.metriques.concentration_1pct, 0, 1, { texte: fmtPct(e.metriques.concentration_1pct, 0), texteMin: "0 %", texteMax: "100 %",
          gauche: "#1c1c20", droite: COULEURS.pos }),
        quoi: "La part du gamma située à moins de 1 % du prix actuel.",
        lire: "Élevée : les niveaux proches sont très « chargés », le prix réagit fort autour d'eux. Faible : le gamma est loin, les mouvements sont plus libres.",
        exemple: (e) => `${fmtPct(e.metriques.concentration_1pct, 0)} du gamma est à ±1 % du spot.` },
      { cle: "net_premium", metrique: true,
        graph: (zone, e) => Graph.courbe(zone, (e.drift || []).map((p) => ({ x: p.ts, y: (p.call_cum || 0) + (p.put_cum || 0) })),
          { zero: true, remplir: true, couleur: "#e6e6e9", formatX: (t) => heureNY.format(new Date(t * 1000)) }),
        quoi: "Prime nette cumulée depuis l'ouverture : achats agressifs moins ventes agressives, calls et puts confondus.",
        lire: "La <b>pente</b> compte plus que le niveau : une courbe qui monte = flux qui devient haussier, qui descend = baissier. Une divergence avec le prix est un signal à surveiller.",
        exemple: (e) => `Prime nette actuelle : ${fmtMontant(e.metriques.net_premium)}.` },
      { cle: "flux_net", metrique: true,
        graph: (zone, e) => {
          let cumul = 0;
          const pts = [...(e.flux_options || [])].sort((a, b) => a.t - b.t).map((s) => ({ x: s.t, y: (cumul += s.s * s.p) }));
          Graph.courbe(zone, pts, { zero: true, remplir: true, couleur: cumul >= 0 ? COULEURS.pos : COULEURS.neg,
            formatX: (t) => heureNY.format(new Date(t * 1000)) });
        },
        titre: "Flux sweeps (bulles de la Tape options)",
        quoi: "Les <b>sweeps</b> sont de gros ordres qui « balaient » plusieurs bourses d'un coup pour être exécutés tout de suite ; les <b>blocks</b> sont de gros ordres négociés en une fois. Ce sont les traces des acteurs pressés et bien informés.",
        lire: "Chaque bulle de la Tape options est placée au <b>strike</b> traité, à l'heure de l'ordre. <b>Vert</b> = haussier (achat de calls, vente de puts), <b>rouge</b> = baissier (achat de puts, vente de calls). Plus la bulle est grosse, plus la prime payée est grande. Une série de grosses bulles vertes sur un strike au-dessus du prix montre où les acheteurs visent. La courbe ci-dessus cumule la prime haussière moins la baissière.",
        exemple: (e) => `Depuis l'ouverture : ${fmtMontant(e.metriques.flux_haussier).replace("+", "")} de flux haussier contre ${fmtMontant(e.metriques.flux_baissier).replace("+", "")} de baissier (${e.metriques.flux_nombre || 0} ordres). Si le prix monte alors que le flux devient rouge, la hausse est moins solide.` },
      { cle: "iv_rv", metrique: true,
        graph: (zone, e) => {
          const v = e.volatilite || {};
          Graph.courbe(zone, (v.serie_iv || []).map((p) => ({ x: p.t, y: p.v * 100 })), { couleur: COULEURS.iv,
            formatX: (t) => heureNY.format(new Date(t * 1000)), formatY: (y) => `${y.toFixed(0)}%`,
            autres: [{ points: (v.serie_rv || []).map((p) => ({ x: p.t, y: p.v * 100 })), couleur: COULEURS.rv }] });
        },
        quoi: "On compare la volatilité <b>implicite</b> (ce que le marché des options <b>prévoit</b>, en jaune) à la volatilité <b>réalisée</b> (ce que le prix <b>bouge vraiment</b>, calculée sur les 30 dernières minutes, en blanc).",
        lire: "IV bien au-dessus de la réalisée (+3 pts ou plus) : les options sont <b>chères</b>, le marché s'attend à plus de mouvement qu'il n'y en a. Souvent un marché qui reste en range, ou qui attend une annonce. IV sous la réalisée : les options sont <b>bon marché</b>, le prix bouge plus que prévu : attention aux accélérations.",
        exemple: (e) => `IV ${fmtPct(e.metriques.atm_iv)}, réalisée 30 min ${fmtPct(e.metriques.rv30)} (séance : ${fmtPct(e.metriques.rv_seance)}) → ${VERDICT_IV[e.metriques.iv_verdict] || "pas encore assez de données"}.` },
      { cle: "vix", metrique: true,
        graph: (zone, e) => {
          const v = e.vix || {};
          Graph.courbe(zone, (v.serie || []).map((p) => ({ x: p.t, y: p.v })), { couleur: COULEURS.vix,
            formatX: (t) => heureNY.format(new Date(t * 1000)), formatY: (y) => y.toFixed(1),
            lignesH: v.veille ? [{ y: v.veille, couleur: "#6b6c74", texte: "veille" }] : [] });
        },
        quoi: "L'indice de volatilité du S&P 500 : la volatilité implicite à 30 jours, calculée par le CBOE. On l'appelle « l'indice de la peur ».",
        lire: "Il monte presque toujours quand les indices baissent. Un VIX qui <b>monte alors que le prix monte aussi</b> est un signal d'alerte (couvertures achetées pendant la hausse). Un VIX qui <b>baisse fort</b> alimente les hausses via le vanna (les teneurs de marché rachètent leurs couvertures).",
        exemple: (e) => `VIX à ${fmtPrix(e.metriques.vix)} (${fmtSigne(e.metriques.vix_variation)} % sur la veille).` },
      { cle: "skew", metrique: true,
        graph: (zone, e) => {
          const s = e.smile || {}, sk = s.skew && s.skew.skew !== undefined ? s.skew : null;
          const pts = (s.points || []).filter((p) => Math.abs(p.strike - e.spot) / e.spot < 0.025).map((p) => ({ x: p.strike, y: p.iv * 100 }));
          Graph.courbe(zone, pts, { couleur: COULEURS.iv, formatX: (v) => v, formatY: (y) => `${y.toFixed(0)}%`,
            marqueurs: [{ x: e.spot, couleur: "#e6e6e9", texte: "spot" }],
            points: sk ? [{ x: sk.k_put, y: sk.iv_put * 100, couleur: COULEURS.put }, { x: sk.k_call, y: sk.iv_call * 100, couleur: COULEURS.call }] : [] });
        },
        titre: "Smile et skew",
        quoi: "Le <b>smile</b> est la volatilité implicite de chaque strike. Le <b>skew</b> compare un put à 1 écart-type sous le prix et un call à 1 écart-type au-dessus.",
        lire: "Normalement les puts sont plus chers (le marché paie pour se protéger) : skew positif, smile qui penche vers la gauche. Si le skew <b>grimpe</b> pendant la séance, la demande de protection augmente : prudence. S'il <b>s'écrase</b>, le marché est serein, parfois trop. Compare la courbe jaune à la pointillée (30 min avant) dans le Desk.",
        exemple: (e) => (e.metriques.skew === null || e.metriques.skew === undefined
          ? "Pas d'IV par strike fournie par la source pour cette échéance."
          : `Skew ±1σ : ${fmtSigne(e.metriques.skew * 100, 1)} pts de volatilité entre le put et le call.`) },
    ];
  },

  dessiner() {
    const e = App.etat;
    if (App.section !== "apprendre") return;
    $("intro-apprendre").innerHTML = e
      ? `Chaque fiche explique un niveau ou une métrique, avec un graphique tracé sur les données actuelles du <b>${e.symbole}</b> (échéance ${e.echeance}) et un exemple concret. Les valeurs entre parenthèses sont converties en <b>${e.future.code}</b>.`
      : "Chargement des données…";
    if (!e) return;
    const fiches = this.fiches();
    const cartes = $("cartes");
    if (cartes.children.length !== fiches.length) {
      cartes.innerHTML = fiches.map((f, i) => {
        const n = NIVEAUX[f.cle];
        const m = METRIQUES.find((x) => x.cle === f.cle);
        const titre = f.titre || (n ? n.nom : m ? m.nom : f.cle);
        return `<div class="carte"><div class="carte-tete">${n ? `<span class="trait" style="border-color:${n.couleur}"></span>` : ""}
            <span class="panel-titre">${titre}</span><span class="famille-tag">${n ? n.famille : "Métrique"}</span></div>
          <div class="carte-valeur" id="fv-${i}"></div><div class="mini" id="fg-${i}"></div>
          <div class="texte"><h4>C'est quoi</h4><p>${f.quoi}</p><h4>Comment le lire</h4><p>${f.lire}</p>
          <h4>Exemple avec les données actuelles</h4><p class="exemple" id="fe-${i}"></p></div></div>`;
      }).join("");
    }
    fiches.forEach((f, i) => {
      const m = METRIQUES.find((x) => x.cle === f.cle);
      $(`fv-${i}`).innerHTML = f.metrique ? (m ? m.valeur(e) : "") : this.n(e, f.cle).replace(" (", " <small>(").replace(/\)$/, ")</small>");
      try { f.graph($(`fg-${i}`), e); } catch (err) { console.error(err); }
      $(`fe-${i}`).innerHTML = f.exemple(e);
    });
  },

  init() {
    App.surDonnees((etat, changement) => {
      if (changement === "reset") { $("cartes").innerHTML = ""; return; }
      this.dessiner();
    });
    window.addEventListener("resize", () => this.dessiner());
  },
};

Apprendre.init();
