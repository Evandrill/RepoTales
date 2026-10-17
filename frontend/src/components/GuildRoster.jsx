/**
 * REPO TALES — GuildRoster.jsx
 * Écran 2 « Guild Roster » — Design Bible v1.0 + corrections audit :
 *   P1-3 : rareté RARE en CYAN #05D9E8 (le vert reste réservé HP/succès)
 *   P1-4 : jauges HP vert / ATK magenta / DEF cyan (fini le violet et le saumon)
 *   P2-8 : sprites à régénérer sans texte incrusté (placeholder prêt à recevoir)
 *   P2-9 : blocs stats alignés via flex + mt-auto (hauteurs de cartes égales)
 *
 * Data-driven : props.heroes (fallback = captures validées). Contrat /saga/mock dans SagaApp.jsx
 * Export : la fiche d'équipe est peinte sur <canvas> et téléchargée en PNG.
 */
import { useState } from "react";
import PixelIcon from "./PixelIcon.jsx";
import PixelImage from "./PixelImage.jsx";
import { FOCUS } from "./Chrome.jsx";
import { sound } from "../services/soundService.js";
import { exportSquadCards } from "../services/exportCards.js";
import { useLanguage } from "../i18n/LanguageContext.jsx";

/* ── Config rareté — P1-3 : RARE passe en cyan ─────────────────────────── */
const RARITY = {
  LEGENDARY: { border: "border-gold", text: "text-gold", chipBg: "bg-gold", glyph: "★", icon: "star" },
  EPIC: { border: "border-neon-violet", text: "text-neon-violet", chipBg: "bg-neon-violet", glyph: "◆", icon: "diamond" },
  RARE: { border: "border-neon-cyan", text: "text-neon-cyan", chipBg: "bg-neon-cyan", glyph: "▲", icon: "triangle" },
};

/* Jauges — P1-4 : couleurs canoniques (HP vert, ATK magenta, DEF cyan) */
const GAUGES = [
  { key: "hp", labelKey: "stats.hp", cls: "bg-neon-green" },
  { key: "atk", labelKey: "stats.atk", cls: "bg-neon-magenta" },
  { key: "def", labelKey: "stats.def", cls: "bg-neon-cyan" },
];

export const DEMO_HEROES = [
  { id: "01", name: "KAI-42", level: 88, rarity: "LEGENDARY", klass: "FRONTEND MAGE", sub: "DOM WEAVER", hp: 10, atk: 9, def: 7, commits: 1024, prs: 87, streak: 14 },
  { id: "02", name: "VALKYR-X", level: 92, rarity: "EPIC", klass: "BACKEND PALADIN", sub: "ACID GUARD", hp: 10, atk: 8, def: 10, commits: 1420, prs: 142, streak: 32 },
  { id: "03", name: "SHADOW-GIT", level: 76, rarity: "RARE", klass: "DEVOPS ROGUE", sub: "CI/CD INFILTRATOR", hp: 8, atk: 9, def: 6, commits: 780, prs: 65, streak: 9 },
  { id: "04", name: "ARCH-BYTE", level: 84, rarity: "EPIC", klass: "DATA SUMMONER", sub: "SQL WRAITH", hp: 7, atk: 10, def: 8, commits: 950, prs: 110, streak: 21 },
];

/* ── Jauge segmentée : remplissage par crans (Bible A.5 gauge-fill steps) ─ */
function Gauge({ label, value, cls }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="font-display text-pixel-sm text-muted">{label}</span>
        <span className="font-data text-[10px] text-ink">
          {String(value).padStart(2, "0")}/10
        </span>
      </div>
      <div className="flex gap-[2px]" role="meter" aria-label={label} aria-valuenow={value} aria-valuemax={10}>
        {Array.from({ length: 10 }, (_, i) => (
          <span
            key={i}
            className={`h-2.5 flex-1 ${i < value ? `animate-slam ${cls}` : "bg-raised"}`}
            style={i < value ? { animationDelay: `${i * 40}ms` } : undefined}
          />
        ))}
      </div>
    </div>
  );
}

/* ── Fiche héros (structure type Yu-Gi-Oh cyberpunk, Bible B.2) ────────── */
function HeroCard({ hero, index }) {
  const r = RARITY[hero.rarity] ?? RARITY.RARE;
  const { t, formatNumber } = useLanguage();

  return (
    <article
      className={`animate-slam relative flex h-full flex-col border-4 ${r.border} bg-panel
                  shadow-pixel transition-none hover:-translate-y-0.5 hover:shadow-pixel-sm`}
      style={{ animationDelay: `${index * 60}ms` }} /* stagger 60ms Bible A.5 */
    >
      {/* Rivets pixel aux 4 coins (Bible B.2) */}
      {["-left-1 -top-1", "-right-1 -top-1", "-left-1 -bottom-1", "-right-1 -bottom-1"].map((pos) => (
        <span key={pos} aria-hidden="true" className={`absolute ${pos} h-2 w-2 ${r.chipBg}`} />
      ))}

      {/* Bandeau : slot + ruban de rareté */}
      <div className="flex items-center justify-between px-3 pt-3">
        <span className="font-data text-[8px] text-muted">#{hero.id}-{hero.sub.split(" ")[0] || t("roster.subSlot")}</span>
        <span className={`flex items-center gap-1 border-2 ${r.border} bg-void px-2 py-1`}>
          <span aria-hidden="true" className={`${r.text} text-[8px]`}>{r.glyph}</span>
          <span className={`font-data text-[8px] tracking-widest ${r.text}`}>{hero.rarity}</span>
        </span>
      </div>

      {/* Cadre sprite — hauteur FIXE (h-48) : toutes les cartes s'alignent,
          même pendant le décodage FLUX ou en fallback SIGNAL LOST. */}
      <div className="mx-3 mt-3 h-48 w-auto overflow-hidden border-2 border-dim bg-void">
        <PixelImage
          src={hero.sprite}
          alt={t("hero.portraitAlt", { name: hero.name })}
          fallbackIcon={r.icon}
          fallbackLabel={t("hero.spriteFallback", { name: hero.name })}
          loadingLabel={t("hero.summoning")}
          imgClassName="animate-bob"
          reveal={false}
          eager
        />
      </div>

      {/* Plaque de nom + niveau */}
      <div className="mt-3 flex items-baseline justify-between px-3">
        <h3 className="font-display text-pixel-base text-ink">{hero.name}</h3>
        <span className="font-data text-[10px] text-muted">
          {t("roster.level")}{hero.level}
        </span>
      </div>

      {/* Badge de classe */}
      <div className="mx-3 mt-2 border-2 border-dim bg-raised px-2 py-2">
        <p className={`font-data text-[10px] ${r.text}`}>{hero.klass}</p>
        <p className="font-data text-[8px] text-muted">// {hero.sub}</p>
      </div>

      {/* Jauges HP / ATK / DEF */}
      <div className="mx-3 mt-4 space-y-3">
        {GAUGES.map((g) => (
          <Gauge key={g.key} label={t(g.labelKey)} value={hero[g.key]} cls={g.cls} />
        ))}
      </div>

      {/* Séparateur pixel + stats Git (mt-auto → P2-9 : alignement vertical) */}
      <div aria-hidden="true" className="mx-3 mt-4 flex gap-1">
        {Array.from({ length: 10 }, (_, i) => (
          <span key={i} className="h-1 w-1 bg-dim" />
        ))}
      </div>
      <div className="mx-3 mb-3 mt-auto space-y-2 border-2 border-dim bg-deep p-2">
        <p className="flex items-center justify-between font-data text-[10px]">
          <span className="flex items-center gap-2 text-muted"><PixelIcon type="branch" className="h-2.5 w-2.5" /> {t("hero.commits")}</span>
          <span className="text-ink">{formatNumber(hero.commits)}</span>
        </p>
        <p className="flex items-center justify-between font-data text-[10px]">
          <span className="flex items-center gap-2 text-muted"><PixelIcon type="merge" className="h-2.5 w-2.5" /> {t("hero.prs")}</span>
          <span className="text-ink">{formatNumber(hero.prs)}</span>
        </p>
        <p className="flex items-center justify-between font-data text-[10px]">
          <span className="flex items-center gap-2 text-muted"><PixelIcon type="flame" className="h-2.5 w-2.5" /> {t("hero.streak")}</span>
          <span className="text-gold">{String(hero.streak).padStart(2, "0")} {t("roster.streakDays")}</span>
        </p>
      </div>
    </article>
  );
}

/* ── Écran complet ──────────────────────────────────────────────────────── */
export default function GuildRoster({
  heroes = DEMO_HEROES,
  guild = { name: "@OCTO-SQUAD", xp: 18450, xpMax: 22000, level: "LV.7 SAGA", nextTier: "TITAN SAGA", nextTierXp: 1240, nextTierMax: 1500 },
  onInspect,
}) {
  const { t, locale, formatNumber } = useLanguage();
  const [exportState, setExportState] = useState(null); // null | busy | done | error

  const pct = Math.round((guild.xp / guild.xpMax) * 100);
  const totalCommits = heroes.reduce((s, h) => s + h.commits, 0);
  const avgStreak = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(heroes.reduce((s, h) => s + h.streak, 0) / heroes.length);
  const filled = Math.round((guild.xp / guild.xpMax) * 20); // barre 20 segments

  async function handleExport() {
    if (exportState === "busy") return;
    sound.click();
    setExportState("busy");
    try {
      await exportSquadCards({
        heroes,
        guild,
        locale,
        labels: {
          title: t("export.title"),
          subtitle: t("export.subtitle", { guild: guild.name }),
          badge: t("export.badge"),
          level: t("export.level"),
          hp: t("stats.hp"),
          atk: t("stats.atk"),
          def: t("stats.def"),
          commits: t("export.commits"),
          prs: t("export.prs"),
          streak: t("export.streak"),
          days: t("roster.streakDays"),
          footer: t("export.footer"),
        },
      });
      setExportState("done");
    } catch (error) {
      console.error("Card export failed:", error);
      setExportState("error");
    } finally {
      setTimeout(() => setExportState(null), 3200);
    }
  }

  return (
    <section className="mx-auto max-w-[1200px] px-4 pb-16">
      {/* En-tête de guilde */}
      <header className="mt-8 border-2 border-dim bg-deep p-6 text-center shadow-pixel-sm">
        <p className="inline-block border border-dim bg-panel px-2 py-1 font-data text-[8px] text-muted">
          {t("roster.manifest")}
        </p>
        <h1 className="mt-4 font-display text-pixel-xl text-neon-violet
                       [text-shadow:0_0_4px_#B026FF,0_0_12px_rgba(176,38,255,0.6)]">
          {t("roster.title")}
        </h1>
        <p className="mt-3 font-dialogue text-lg text-muted">
          {t("roster.team", { name: guild.name, count: heroes.length })}
        </p>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-3 font-data text-[8px]">
          <span className="border-2 border-neon-green bg-panel px-2 py-1 text-neon-green">{t("roster.ready")}</span>
          <span className="border-2 border-neon-magenta bg-panel px-2 py-1 text-neon-magenta">
            {t("roster.avgStreak", { days: avgStreak })}
          </span>
          <span className="border-2 border-neon-violet bg-panel px-2 py-1 text-neon-violet">
            {t("roster.totalCommits", { count: formatNumber(totalCommits) })}
          </span>
        </div>
      </header>

      {/* Grille de cartes — auto-fit 280px, gap 16px (Bible A.6) */}
      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {heroes.map((h, i) => (
          <HeroCard key={h.id} hero={h} index={i} />
        ))}
      </div>

      {/* Barre d'XP de guilde + actions */}
      <div className="mt-8 border-2 border-dim bg-deep p-4 shadow-pixel-sm">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <p className="font-display text-pixel-base text-ink">
            {t("roster.guildXp")}{" "}
            <span className="ml-2 bg-neon-violet px-2 py-1 font-data text-[10px] text-black">{guild.level}</span>
          </p>
          <p className="font-data text-[10px] text-muted">
            {formatNumber(guild.xp)} / {formatNumber(guild.xpMax)} {t("roster.xpUnit")}{" "}
            <span className="text-neon-green">[{pct}%]</span>
          </p>
          <div className="flex gap-3">
            <button type="button" onClick={onInspect}
                    className={`border-2 border-dim bg-raised px-3 py-2 font-display text-pixel-sm text-ink
                                transition-none hover:border-neon-cyan hover:text-neon-cyan ${FOCUS}`}>
              {t("roster.inspect")}
            </button>
            <button type="button" onClick={handleExport} disabled={exportState === "busy"}
                    className={`bg-neon-magenta px-3 py-2 font-display text-pixel-sm text-black
                                shadow-pixel-sm transition-none hover:-translate-y-0.5 active:translate-y-0
                                disabled:cursor-wait disabled:opacity-60 ${FOCUS}`}>
              {exportState === "busy" ? t("roster.exporting") : t("roster.export")}
            </button>
          </div>
        </div>
        {exportState && exportState !== "busy" && (
          <p
            role="status"
            className={`mt-3 text-right font-data text-[9px] ${
              exportState === "done" ? "text-neon-green" : "text-alert"
            }`}
          >
            {t(exportState === "done" ? "roster.exported" : "roster.exportFailed")}
          </p>
        )}
        {/* Barre segmentée violette + shimmer (Bible B.2) */}
        <div className="mt-4 flex gap-[2px] overflow-hidden" role="progressbar" aria-valuenow={pct} aria-valuemax={100}>
          {Array.from({ length: 20 }, (_, i) => (
            <span key={i} className={`h-3 flex-1 ${i < filled ? "bg-neon-violet" : "bg-raised"}`} />
          ))}
        </div>
        <p className="mt-2 font-data text-[8px] text-muted">
          {t("roster.nextTier")} <span className="text-gold">{guild.nextTier}</span> — {formatNumber(guild.nextTierXp)} / {formatNumber(guild.nextTierMax)} {t("roster.xpUnit")}
        </p>
      </div>
    </section>
  );
}
