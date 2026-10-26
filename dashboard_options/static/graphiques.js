// ============================================================
// Petits moteurs de graphiques en SVG, réutilisés partout :
//   Graph.barres  → profil par strike (barres horizontales)
//   Graph.courbe  → courbe simple (x, y) avec repères
// ============================================================

const Graph = {
  // ----------------------------------------------------------
  // Barres horizontales par strike
  //   series : [{ cle, nom, couleur }] ou [{ cle, nom, signe: true }] (couleur selon le signe)
  //   options : reperes [{prix, couleur, texte}], compact, brut, surligner (strike),
  //             coteACote (une sous-ligne par série au lieu de les superposer)
  // ----------------------------------------------------------
  barres(zone, lignesBrutes, series, options = {}) {
    if (!zone) return;
    const W = zone.clientWidth, H = zone.clientHeight;
    if (W < 100 || H < 80 || !lignesBrutes || !lignesBrutes.length) { zone.innerHTML = ""; return; }

    const compact = !!options.compact;
    const marge = { g: compact ? 38 : 50, d: 8, h: 6, b: compact ? 6 : 18 };
    const lignes = [...lignesBrutes].sort((a, b) => b.strike - a.strike);
    const pas = (H - marge.h - marge.b) / lignes.length;
    const valeur = (l, s) => (l[s.cle] || 0) * (s.inverser ? -1 : 1);
    const max = Math.max(...lignes.flatMap((l) => series.map((s) => Math.abs(valeur(l, s))))) || 1;
    const x0 = marge.g + (W - marge.g - marge.d) / 2;
    const echelle = (W - marge.g - marge.d) / 2 / max;
    const yIndex = (i) => marge.h + (i + 0.5) * pas;
    const haut = lignes[0].strike, bas = lignes[lignes.length - 1].strike;
    const yPrix = (p) => marge.h + ((haut - p) / (haut - bas || 1)) * (lignes.length - 1) * pas + pas / 2;
    const hBarre = Math.max(1, pas - (pas > 4 ? 2 : 0.5));

    let svg = `<svg viewBox="0 0 ${W} ${H}">`;
    svg += `<line x1="${x0}" x2="${x0}" y1="${marge.h}" y2="${H - marge.b}" stroke="#24252b"/>`;

    const tous = Math.ceil(13 / pas);
    lignes.forEach((l, i) => {
      if (i % tous === 0)
        svg += `<text x="${marge.g - 6}" y="${yIndex(i) + 3}" fill="#55565e" font-size="10" text-anchor="end">${l.strike}</text>`;
    });

    lignes.forEach((l, i) => {
      const fort = options.surligner !== undefined && Math.abs(l.strike - options.surligner) < 1e-9;
      const nSous = options.coteACote ? series.length : 1;       // calls et puts sur deux sous-lignes
      const hSous = hBarre / nSous;
      series.forEach((s, si) => {
        const v = valeur(l, s);
        if (!v) return;
        const larg = Math.max(Math.abs(v) * echelle, 0.6);
        const couleur = s.signe ? (v >= 0 ? COULEURS.pos : COULEURS.neg) : s.couleur;
        const opacite = options.surligner === undefined || fort ? 1 : 0.35;
        const y = yIndex(i) - hBarre / 2 + (options.coteACote ? si * hSous : 0);
        svg += `<rect x="${v >= 0 ? x0 : x0 - larg}" y="${y}" width="${larg}" height="${Math.max(0.8, hSous - (nSous > 1 && hSous > 3 ? 0.5 : 0))}"
                 rx="${Math.min(2, hSous / 2)}" fill="${couleur}" opacity="${opacite}"/>`;
      });
      if (!compact)
        svg += `<rect class="hit" data-i="${i}" x="${marge.g}" y="${yIndex(i) - pas / 2}" width="${W - marge.g - marge.d}" height="${pas}" fill="transparent"/>`;
    });

    // repères (spot, niveaux) : étiquettes décalées pour ne pas se chevaucher
    const reperes = (options.reperes || [])
      .filter((r) => r.prix !== undefined && r.prix !== null && r.prix <= haut && r.prix >= bas)
      .map((r) => ({ ...r, y: yPrix(r.prix) }))
      .sort((a, b) => a.y - b.y);
    let dernier = -Infinity;
    reperes.forEach((r) => {
      const yt = Math.max(r.y - 3, dernier + 11);
      dernier = yt;
      svg += `<line x1="${marge.g}" x2="${W - marge.d}" y1="${r.y}" y2="${r.y}" stroke="${r.couleur}" stroke-dasharray="2 3" stroke-width="1"/>
              <text x="${W - marge.d - 2}" y="${yt}" fill="${r.couleur}" font-size="10" text-anchor="end" paint-order="stroke" stroke="#050506" stroke-width="3">${r.texte}</text>`;
    });

    if (!compact) {
      const f = (v) => (options.brut ? Math.round(v).toLocaleString("fr-FR") : fmtMontant(v));
      svg += `<text x="${x0}" y="${H - 5}" fill="#55565e" font-size="10" text-anchor="middle">0</text>
              <text x="${W - marge.d}" y="${H - 5}" fill="#55565e" font-size="10" text-anchor="end">${f(max)}</text>
              <text x="${marge.g}" y="${H - 5}" fill="#55565e" font-size="10">${f(-max)}</text>`;
    }
    svg += `</svg>`;
    zone.innerHTML = svg;

    if (compact) return;
    zone.querySelectorAll(".hit").forEach((r) => {
      r.addEventListener("mousemove", (ev) => {
        const l = lignes[Number(r.dataset.i)];
        const txt = series.map((s) => `${s.nom} : ${options.brut ? Math.round(l[s.cle] || 0).toLocaleString("fr-FR") : fmtMontant(l[s.cle])}`);
        const fut = options.versFuture ? `<br><span style="color:#8d8e96">${options.versFuture(l.strike)}</span>` : "";
        montrerTip(`<b>Strike ${l.strike}</b>${fut}<br>${txt.join("<br>")}`, ev.clientX, ev.clientY);
        r.setAttribute("fill", "rgba(255,255,255,0.04)");
      });
      r.addEventListener("mouseleave", () => { cacherTip(); r.setAttribute("fill", "transparent"); });
    });
  },

  // ----------------------------------------------------------
  // Courbe (x, y)
  //   options : couleur, zero (ligne horizontale à 0), marqueurs [{x, couleur, texte}],
  //             bande {bas, haut, couleur}, formatX, formatY (graduations à gauche),
  //             remplir (aire sous la courbe), autres [{points, couleur, tirets}] (courbes en plus),
  //             points [{x, y, couleur, texte}] (pastilles)
  // ----------------------------------------------------------
  courbe(zone, points, options = {}) {
    if (!zone) return;
    const W = zone.clientWidth, H = zone.clientHeight;
    if (W < 100 || H < 60 || !points || points.length < 2) { zone.innerHTML = `<div class="vide">pas encore de données</div>`; return; }
    const marge = { g: options.formatY ? 40 : 8, d: 8, h: 14, b: 16 };
    const autres = (options.autres || []).filter((a) => a.points && a.points.length > 1);
    const tous = points.concat(...autres.map((a) => a.points));
    const xs = tous.map((p) => p.x), ys = tous.map((p) => p.y);
    let yMin = Math.min(...ys), yMax = Math.max(...ys);
    if (options.zero) { yMin = Math.min(yMin, 0); yMax = Math.max(yMax, 0); }
    if (options.bande) { yMin = Math.min(yMin, options.bande.bas); yMax = Math.max(yMax, options.bande.haut); }
    const pad = (yMax - yMin) * 0.08 || 1;
    yMin -= pad; yMax += pad;
    const xMin = Math.min(...xs), xMax = Math.max(...xs);
    const X = (x) => marge.g + ((x - xMin) / (xMax - xMin || 1)) * (W - marge.g - marge.d);
    const Y = (y) => marge.h + (1 - (y - yMin) / (yMax - yMin || 1)) * (H - marge.h - marge.b);
    const couleur = options.couleur || "#e6e6e9";

    let svg = `<svg viewBox="0 0 ${W} ${H}">`;
    if (options.bande) {
      svg += `<rect x="${marge.g}" y="${Y(options.bande.haut)}" width="${W - marge.g - marge.d}" height="${Y(options.bande.bas) - Y(options.bande.haut)}" fill="${options.bande.couleur || "rgba(255,255,255,0.06)"}"/>`;
    }
    if (options.zero) svg += `<line x1="${marge.g}" x2="${W - marge.d}" y1="${Y(0)}" y2="${Y(0)}" stroke="#24252b"/>`;
    if (options.formatY) {
      [yMax - pad, (yMax + yMin) / 2, yMin + pad].forEach((v) => {
        svg += `<line x1="${marge.g}" x2="${W - marge.d}" y1="${Y(v)}" y2="${Y(v)}" stroke="#101115"/>
                <text x="${marge.g - 5}" y="${Y(v) + 3}" fill="#55565e" font-size="10" text-anchor="end">${options.formatY(v)}</text>`;
      });
    }
    autres.forEach((a) => {
      const c = a.points.map((p, i) => `${i ? "L" : "M"}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join("");
      svg += `<path d="${c}" fill="none" stroke="${a.couleur}" stroke-width="${a.epaisseur || 1.3}" ${a.tirets ? `stroke-dasharray="${a.tirets}"` : ""}/>`;
    });
    const chemin = points.map((p, i) => `${i ? "L" : "M"}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join("");
    if (options.remplir) {
      const base = options.zero ? Y(0) : H - marge.b;
      svg += `<path d="${chemin}L${X(xMax)},${base}L${X(xMin)},${base}Z" fill="${couleur}" opacity="0.12"/>`;
    }
    svg += `<path d="${chemin}" fill="none" stroke="${couleur}" stroke-width="1.6"/>`;

    let dernierX = -Infinity, rang = 0;
    (options.marqueurs || []).filter((m) => m.x >= xMin && m.x <= xMax).sort((a, b) => X(a.x) - X(b.x)).forEach((m) => {
      const x = X(m.x);
      rang = x - dernierX < 70 ? rang + 1 : 0;          // étiquettes trop proches : on les décale vers le bas
      dernierX = x;
      const aGauche = x > W - 80;
      svg += `<line x1="${x}" x2="${x}" y1="${marge.h}" y2="${H - marge.b}" stroke="${m.couleur}" stroke-dasharray="2 3"/>
              <text x="${aGauche ? x - 3 : x + 3}" y="${marge.h - 3 + rang * 11}" fill="${m.couleur}" font-size="10"
                text-anchor="${aGauche ? "end" : "start"}" paint-order="stroke" stroke="#050506" stroke-width="3">${m.texte}</text>`;
    });
    (options.points || []).forEach((p) => {
      svg += `<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="3.5" fill="${p.couleur}" stroke="#050506" stroke-width="1.5"/>`;
      if (p.texte) svg += `<text x="${X(p.x)}" y="${Y(p.y) - 8}" fill="${p.couleur}" font-size="10" text-anchor="middle" paint-order="stroke" stroke="#050506" stroke-width="3">${p.texte}</text>`;
    });
    (options.lignesH || []).forEach((l) => {
      svg += `<line x1="${marge.g}" x2="${W - marge.d}" y1="${Y(l.y)}" y2="${Y(l.y)}" stroke="${l.couleur}" stroke-dasharray="2 3"/>
              <text x="${W - marge.d - 2}" y="${Y(l.y) - 3}" fill="${l.couleur}" font-size="10" text-anchor="end">${l.texte}</text>`;
    });
    const fx = options.formatX || ((v) => v);
    svg += `<text x="${marge.g}" y="${H - 3}" fill="#55565e" font-size="10">${fx(xMin)}</text>
            <text x="${W - marge.d}" y="${H - 3}" fill="#55565e" font-size="10" text-anchor="end">${fx(xMax)}</text>`;
    svg += `</svg>`;
    zone.innerHTML = svg;
  },

  // ----------------------------------------------------------
  // Jauge horizontale (pour un ratio ou un score)
  // ----------------------------------------------------------
  jauge(zone, valeur, min, max, options = {}) {
    if (!zone) return;
    const W = zone.clientWidth, H = zone.clientHeight;
    if (W < 100 || valeur === null || valeur === undefined || isNaN(valeur)) { zone.innerHTML = `<div class="vide">pas encore de données</div>`; return; }
    const x = (v) => 12 + ((Math.min(Math.max(v, min), max) - min) / (max - min)) * (W - 24);
    const y = H / 2;
    let svg = `<svg viewBox="0 0 ${W} ${H}">
      <defs><linearGradient id="gj${zone.id}" x1="0" x2="1"><stop offset="0" stop-color="${options.gauche || COULEURS.pos}"/>
        <stop offset="0.5" stop-color="#2a2b31"/><stop offset="1" stop-color="${options.droite || COULEURS.neg}"/></linearGradient></defs>
      <rect x="12" y="${y - 4}" width="${W - 24}" height="8" rx="4" fill="url(#gj${zone.id})" opacity="0.8"/>`;
    (options.reperes || []).forEach((r) => {
      svg += `<line x1="${x(r.v)}" x2="${x(r.v)}" y1="${y - 10}" y2="${y + 10}" stroke="#55565e"/>
              <text x="${x(r.v)}" y="${y + 24}" fill="#55565e" font-size="10" text-anchor="middle">${r.texte}</text>`;
    });
    svg += `<circle cx="${x(valeur)}" cy="${y}" r="7" fill="#e6e6e9" stroke="#000" stroke-width="2"/>
            <text x="${x(valeur)}" y="${y - 14}" fill="#e6e6e9" font-size="11" text-anchor="middle">${options.texte || valeur.toFixed(2)}</text>
            <text x="12" y="${y + 24}" fill="#55565e" font-size="10">${options.texteMin || min}</text>
            <text x="${W - 12}" y="${y + 24}" fill="#55565e" font-size="10" text-anchor="end">${options.texteMax || max}</text>`;
    zone.innerHTML = svg + `</svg>`;
  },
};
