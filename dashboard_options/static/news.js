// ============================================================
// Section NEWS : fil d'actualités (FreeFlow + flux RSS), interrogé toutes les 15 s
// ============================================================

const News = {
  articles: [],
  dejaVus: new Set(),
  filtre: "tout",
  recherche: "",
  ecouteurs: [],

  surMaj(fn) { this.ecouteurs.push(fn); },

  relatif(ts) {
    const s = Math.max(0, Date.now() / 1000 - ts);
    if (s < 60) return "à l'instant";
    if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
    if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
    return `il y a ${Math.floor(s / 86400)} j`;
  },

  async charger() {
    try {
      const r = await (await fetch("/api/news")).json();
      const premier = this.articles.length === 0;
      this.articles = r.articles || [];
      this.nouveaux = new Set(premier ? [] : this.articles.filter((a) => !this.dejaVus.has(a.id)).map((a) => a.id));
      this.articles.forEach((a) => this.dejaVus.add(a.id));
      $("news-info").textContent = `${this.articles.length} articles · mis à jour ${r.maj ? new Date(r.maj * 1000).toLocaleTimeString("fr-FR") : "–"}`;
      this.dessiner();
      this.ecouteurs.forEach((fn) => fn());
    } catch { /* on réessaie au prochain tour */ }
  },

  dessiner() {
    const q = this.recherche.toLowerCase();
    const liste = this.articles.filter((a) =>
      (this.filtre === "tout" || (this.filtre === "macro" && a.macro) || (this.filtre === "important" && a.important)) &&
      (!q || `${a.titre} ${a.resume}`.toLowerCase().includes(q)));
    const jour = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" });
    $("news-liste").innerHTML = liste.length ? liste.map((a) => {
      const s = a.sentiment;
      const tagS = s === null || s === undefined ? "" : s > 0.15 ? `<span class="tag s-pos">positif</span>` : s < -0.15 ? `<span class="tag s-neg">négatif</span>` : `<span class="tag">neutre</span>`;
      return `<article class="news-ligne ${this.nouveaux && this.nouveaux.has(a.id) ? "nouveau" : ""}">
        <div class="heure">${jour.format(new Date(a.ts * 1000))}<small>${this.relatif(a.ts)}</small></div>
        <div><h3><a href="${echapper(a.url)}" target="_blank" rel="noopener">${echapper(a.titre)}</a></h3>
          ${a.resume ? `<p>${echapper(a.resume)}</p>` : ""}
          <div class="tags"><span class="tag">${echapper(a.source)}</span>${a.macro ? `<span class="tag macro">macro</span>` : ""}
          ${a.important ? `<span class="tag fort">important</span>` : ""}${tagS}</div></div></article>`;
    }).join("") : `<div class="vide">aucun article</div>`;
  },

  init() {
    $("news-recherche").addEventListener("input", (ev) => { this.recherche = ev.target.value; this.dessiner(); });
    document.querySelectorAll(".news-filtres .tg").forEach((b) => (b.onclick = () => {
      this.filtre = b.dataset.filtre;
      document.querySelectorAll(".news-filtres .tg").forEach((x) => x.classList.toggle("on", x === b));
      this.dessiner();
    }));
    this.charger();
    setInterval(() => this.charger(), 15000);
    setInterval(() => { if (App.section === "news") this.dessiner(); }, 30000);   // « il y a X min »
  },
};

News.init();
