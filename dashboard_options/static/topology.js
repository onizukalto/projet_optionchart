// ============================================================
// Section TOPOLOGY : surface de gamma complète
//   strike (x) × échéance (y) × GEX (z) — vert = γ positif, rouge = γ négatif
// Plotly (≈1,7 Mo) n'est chargé qu'à la première ouverture de la section.
// ============================================================

const Topology = {
  vue: "3d",
  signature: "",
  plotlyPret: null,

  chargerPlotly() {
    if (!this.plotlyPret) {
      this.plotlyPret = new Promise((ok, ko) => {
        const s = document.createElement("script");
        s.src = "/static/vendor/plotly-gl3d.min.js";
        s.onload = ok; s.onerror = ko;
        document.head.appendChild(s);
      });
    }
    return this.plotlyPret;
  },

  async dessiner(force) {
    const e = App.etat;
    if (App.section !== "topology") return;
    if (!e || !e.topo || !e.topo.strikes || !e.topo.strikes.length) {
      $("topo-info").textContent = "topologie en cours de chargement…";
      return;
    }
    const t = e.topo;
    const sig = `${e.symbole}|${t.exps.join()}|${t.strikes.length}|${t.grid.flat().slice(0, 50).join()}|${this.vue}`;
    if (sig === this.signature && !force) return;
    this.signature = sig;

    const max = Math.max(...t.grid.flat().map((v) => Math.abs(v || 0))) || 1;
    const etiquettes = t.exps.map((x, i) => `${t.dtes ? t.dtes[i] : i}DTE · ${x.slice(5)}`);
    $("topo-info").textContent = `${e.symbole} · ${t.exps.length} échéances · strikes ${t.strikes[0]} → ${t.strikes[t.strikes.length - 1]}`;
    this.dessinerParts();

    if (this.vue === "2d") return this.dessiner2d(t, max, etiquettes);

    await this.chargerPlotly();
    const echelle = [[0, "#e5484d"], [0.35, "#5a1d20"], [0.5, "#1c1c20"], [0.65, "#123b32"], [1, "#3aa98f"]];
    const surface = {
      type: "surface", x: t.strikes, y: t.exps.map((_, i) => i), z: t.grid.map((l) => l.map((v) => v || 0)),
      colorscale: echelle, cmin: -max, cmax: max, showscale: true,
      colorbar: { tickfont: { color: "#8d8e96", family: "JetBrains Mono", size: 10 }, thickness: 10, len: 0.6, outlinewidth: 0,
                  tickformat: "~s", title: { text: "GEX", font: { color: "#8d8e96", size: 10 } } },
      contours: { z: { show: true, usecolormap: true, highlightcolor: "#ffffff", project: { z: true } } },
      hovertemplate: "strike %{x}<br>%{customdata}<br>GEX %{z:.3s}<extra></extra>",
      customdata: t.grid.map((l, i) => l.map(() => etiquettes[i])),
      lighting: { ambient: 0.75, diffuse: 0.6, specular: 0.15, roughness: 0.6 },
    };
    const spot = {
      type: "scatter3d", mode: "lines", x: t.exps.map(() => t.spot), y: t.exps.map((_, i) => i), z: t.exps.map(() => 0),
      line: { color: "#ffffff", width: 4 }, name: "spot", hoverinfo: "skip",
    };
    const axe = (titre, extra = {}) => ({
      title: { text: titre, font: { color: "#8d8e96", size: 11 } }, color: "#55565e", gridcolor: "#17181c",
      zerolinecolor: "#2a2b31", backgroundcolor: "#050506", showbackground: true, tickfont: { size: 10, color: "#8d8e96" }, ...extra,
    });
    const layout = {
      paper_bgcolor: "#050506", plot_bgcolor: "#050506", margin: { l: 0, r: 0, t: 0, b: 0 },
      font: { family: "JetBrains Mono, monospace", color: "#8d8e96" }, showlegend: false, uirevision: e.symbole,
      scene: {
        xaxis: axe("strike"), yaxis: axe("échéance", { tickvals: t.exps.map((_, i) => i), ticktext: etiquettes }),
        zaxis: axe("GEX", { tickformat: "~s" }), camera: { eye: { x: 1.5, y: -1.6, z: 0.9 } }, aspectmode: "manual",
        aspectratio: { x: 1.6, y: 1, z: 0.6 },
      },
    };
    $("topo-3d").hidden = false;
    $("topo-2d").hidden = true;
    Plotly.react($("topo-3d"), [surface, spot], layout, { displaylogo: false, responsive: true, modeBarButtonsToRemove: ["toImage"] });
  },

  dessiner2d(t, max, etiquettes) {
    $("topo-3d").hidden = true;
    const zone = $("topo-2d");
    zone.hidden = false;
    const W = zone.clientWidth, H = zone.clientHeight;
    const g = 110, b = 22, h = 6;
    const cw = (W - g - 8) / t.strikes.length, ch = (H - b - h) / t.exps.length;
    const couleur = (v) => {
      const a = Math.min(1, Math.abs(v) / max) ** 0.6;
      return v >= 0 ? `rgba(58,169,143,${a})` : `rgba(229,72,77,${a})`;
    };
    let svg = `<svg viewBox="0 0 ${W} ${H}">`;
    t.grid.forEach((ligne, i) => {
      svg += `<text x="${g - 8}" y="${h + i * ch + ch / 2 + 3}" fill="#8d8e96" font-size="10" text-anchor="end">${etiquettes[i]}</text>`;
      ligne.forEach((v, j) => {
        svg += `<rect class="c" data-i="${i}" data-j="${j}" x="${g + j * cw}" y="${h + i * ch}" width="${Math.max(cw - 1, 0.5)}" height="${ch - 2}" rx="1" fill="${v ? couleur(v) : "#0b0b0d"}"/>`;
      });
    });
    const tous = Math.ceil(46 / cw);
    t.strikes.forEach((s, j) => { if (j % tous === 0) svg += `<text x="${g + j * cw + cw / 2}" y="${H - 6}" fill="#55565e" font-size="10" text-anchor="middle">${s}</text>`; });
    const jSpot = t.strikes.findIndex((s) => s >= t.spot);
    if (jSpot >= 0) svg += `<line x1="${g + jSpot * cw}" x2="${g + jSpot * cw}" y1="${h}" y2="${H - b}" stroke="#fff" stroke-dasharray="3 3"/>`;
    zone.innerHTML = svg + `</svg>`;
    zone.querySelectorAll("rect.c").forEach((r) => {
      r.addEventListener("mousemove", (ev) => {
        const i = +r.dataset.i, j = +r.dataset.j;
        montrerTip(`<b>Strike ${t.strikes[j]}</b><br>${etiquettes[i]}<br>GEX ${fmtMontant(t.grid[i][j])}`, ev.clientX, ev.clientY);
      });
      r.addEventListener("mouseleave", cacherTip);
    });
  },

  dessinerParts() {
    const parts = App.etat.parts_echeances || [];
    $("parts").innerHTML = parts.map((p) => `<div class="part">
      <span>${p.dte ?? "?"}DTE · ${p.exp.slice(5)}</span>
      <span class="barre"><i style="width:${(p.part * 100).toFixed(1)}%;background:${p.net >= 0 ? COULEURS.pos : COULEURS.neg}"></i></span>
      <span class="num">${fmtPct(p.part, 0)}</span></div>`).join("") || `<div class="vide">–</div>`;
  },

  init() {
    document.querySelectorAll("#onglets-topo button").forEach((b) => (b.onclick = () => {
      this.vue = b.dataset.topo;
      document.querySelectorAll("#onglets-topo button").forEach((x) => x.classList.toggle("actif", x === b));
      this.dessiner(true);
    }));
    App.surDonnees((etat, changement) => {
      if (changement === "reset") { this.signature = ""; return; }
      this.dessiner(changement === "section");
    });
    window.addEventListener("resize", () => { if (App.section === "topology" && this.vue === "2d") this.dessiner(true); });
  },
};

Topology.init();
