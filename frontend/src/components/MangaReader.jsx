/**
 * REPO TALES — MangaReader.jsx
 * Écran 3 « Lecteur de planches rétro » — Design Bible v1.0 (B.3)
 *   Paper #F2F0F5 (seule surface claire), panneaux bordure 4px #0A0A14,
 *   bulles LTR VT323, SFX Press Start 2P + contour blanc, offset 2px alterné,
 *   nav Game Boy (D-pad, SELECT/START, B/A), flash 1 frame au tournage.
 *
 * Le boss surgit automatiquement quand le joueur atteint la dernière page du
 * dernier chapitre (une page = un chapitre), ou via le bouton !! BOSS.
 * Data-driven : props.chapter (fallback = planches validées du CH.3).
 */
import { useEffect, useRef, useState } from "react";
import PixelImage from "./PixelImage.jsx";
import { FOCUS } from "./Chrome.jsx";
import { sound } from "../services/soundService.js";
import { useLanguage } from "../i18n/LanguageContext.jsx";

const DEMO_CHAPTER = {
  number: 3,
  title: "LE KRAKEN DU MERGE",
  total: 12,
  issue: "#03",
  page: 3,
  panels: [
    { span: "wide", art: null, bubble: "« Le build est stable... trop stable. »", sfx: { text: "MERGE!!", color: "text-neon-magenta" }, caption: "[SYS.ALERT: CORRUPTED OCTOPUS OCCURRENCE]" },
    { span: "half", art: null, bubble: "« DERNIER PUSH AVANT LA PROD ! »", sfx: { text: "PUSH!!!", color: "text-neon-green" } },
    { span: "half", art: null, sfx: { text: "CONFLICT!", color: "text-alert" }, terminal: { line: "> FATAL: automatic merge failed; fix conflicts and commit.", stage: "STAGE: HEAD DETACHED", code: "CODE 128" } },
  ],
  footer: { left: "REPO TALES SAGA // ISSUE #03 // SHONEN JUMP COMPILER", right: "[PROD PIPELINE DISRUPTED]" },
};

/* Contour blanc épais pour les SFX (Bible B.3 : Press Start 2P + outline) */
const SFX_OUTLINE =
  "[text-shadow:2px_0_0_#F2F0F5,-2px_0_0_#F2F0F5,0_2px_0_#F2F0F5,0_-2px_0_#F2F0F5," +
  "3px_3px_0_#F2F0F5,-3px_3px_0_#F2F0F5,3px_-3px_0_#F2F0F5,-3px_-3px_0_#F2F0F5]";

/* ── Une case de manga ──────────────────────────────────────────────────── */
function Panel({ panel }) {
  const wide = panel.span === "wide";
  const { t } = useLanguage();

  return (
    <figure className={`relative min-w-0 ${wide ? "col-span-full aspect-[16/8]" : "aspect-square"}`}>
      {/* overflow-hidden : aucun SFX incliné, légende ou bulle ne peut sortir de la case */}
      <div className="relative h-full w-full overflow-hidden border-4 border-void bg-void">
        <PixelImage
          src={panel.art}
          alt={
            panel.caption
              ? t("reader.panelAltCaption", { caption: panel.caption })
              : t("reader.panelAlt")
          }
          fallbackIcon="skull"
          fallbackLabel={t("reader.noSignal")}
          loadingLabel={t("reader.inking")}
        />

        {/* Bulle LTR — VT323 16px, plafonnée à 35% de la case, fond sombre translucide */}
        {panel.bubble && (
          <blockquote className="absolute left-2 top-2 right-2 max-h-[35%] overflow-hidden
                                 border-4 border-void bg-void/90 px-2 py-1.5 sm:left-3 sm:top-3 sm:right-8">
            <p className="font-dialogue text-[16px] leading-tight text-paper">{panel.bubble}</p>
            <span aria-hidden="true" className="absolute -bottom-[10px] left-5 h-2 w-2 border-b-4 border-l-4 border-void bg-void/90" />
          </blockquote>
        )}

        {/* SFX néon incliné ±8° — largeur bornée pour ne jamais déborder */}
        {panel.sfx && (
          <span
            aria-hidden="true"
            className={`absolute bottom-3 right-2 max-w-[46%] truncate font-display text-pixel-lg leading-none
                        ${panel.sfx.color} ${SFX_OUTLINE} ${wide ? "-rotate-6" : "rotate-6"}`}
          >
            {panel.sfx.text}
          </span>
        )}

        {/* Légende système : chip verte clippée, au-dessus du terminal s'il existe */}
        {panel.caption && (
          <span
            className={`absolute left-2 max-w-[45%] truncate border border-neon-green/50 bg-void/85
                        px-1.5 py-0.5 font-data text-[8px] text-neon-green
                        ${panel.terminal ? "bottom-12" : "bottom-2"}`}
            title={panel.caption}
          >
            {panel.caption}
          </span>
        )}

        {/* Encart terminal (erreur Git dans la case) */}
        {panel.terminal && (
          <div className="absolute inset-x-0 bottom-0 bg-void/85 p-2">
            <p className="truncate font-data text-[9px] text-alert">{panel.terminal.line}</p>
            <p className="mt-1 flex justify-between gap-2 font-data text-[8px] text-paper/60">
              <span className="truncate">{panel.terminal.stage}</span>
              <span className="shrink-0 text-alert">{panel.terminal.code}</span>
            </p>
          </div>
        )}
      </div>
    </figure>
  );
}

/* ── Écran complet ──────────────────────────────────────────────────────── */
export default function MangaReader({
  chapter,
  chapters,
  onPageChange,
  onStartList,
  onBossEncounter,
  bossDefeated = false,
  bossOpen = false,
}) {
  // Le lecteur peut recevoir une seule planche (`chapter`, fallback design) ou
  // la saga complète (`chapters`, fournie par le mapper). Une page = un chapitre,
  // ce qui rend la navigation D-pad/A-B réellement fonctionnelle.
  const list = chapters?.length ? chapters : chapter ? [chapter] : [DEMO_CHAPTER];
  const [page, setPage] = useState(1);
  const [turning, setTurning] = useState(false);
  const { t } = useLanguage();
  const total = list.length;
  const current = list[Math.min(page, total) - 1] ?? list[0];

  // Le handler passe par une ref : le timer de 450 ms ne doit jamais appeler
  // une closure périmée, et il est annulé si le lecteur est démonté.
  const bossTimer = useRef(null);
  const bossHandler = useRef(onBossEncounter);
  useEffect(() => {
    bossHandler.current = onBossEncounter;
  }, [onBossEncounter]);
  useEffect(() => () => clearTimeout(bossTimer.current), []);

  // Modale déjà ouverte (raccourci !! BOSS ou fermeture Échap) : un timer
  // armé par l'arrivée sur la dernière page ne doit pas la rouvrir.
  useEffect(() => {
    if (bossOpen) clearTimeout(bossTimer.current);
  }, [bossOpen]);

  const armBoss = () => {
    if (bossDefeated || bossOpen) return;
    clearTimeout(bossTimer.current);
    // Laisse la dernière planche s'afficher avant l'alarme du boss.
    bossTimer.current = setTimeout(() => bossHandler.current?.(), 450);
  };

  const go = (dir) => {
    const next = Math.min(total, Math.max(1, page + dir));
    // Toute navigation annule un auto-open en attente : sans ça, quitter la
    // dernière page dans les 450 ms ouvrait le boss sur une autre planche.
    clearTimeout(bossTimer.current);
    if (next === page) {
      // Déjà sur la dernière page : A/NEXT relance l'affrontement.
      if (dir > 0 && page === total) armBoss();
      return;
    }
    sound.pageFlip(); // swish de page
    setTurning(true); // flash 1 frame (Bible A.5 panel-flip)
    setPage(next);
    onPageChange?.(next);
    if (next === total) armBoss();
    setTimeout(() => setTurning(false), 90);
  };

  const segs = 4;
  const filled = Math.ceil((page / total) * segs);
  const onFinalPage = page === total;

  const padBtn = `border-2 border-dim bg-raised px-2 py-1.5 font-data text-[10px] text-ink
                  shadow-pixel-sm transition-none hover:border-neon-green hover:text-neon-green
                  active:translate-x-0.5 active:translate-y-0.5 active:shadow-none ${FOCUS}`;

  return (
    <section className="mx-auto max-w-[720px] px-4 pb-16">
      {/* Barre chapitre (sous le TopHUD) */}
      <div className="sticky top-12 z-20 -mx-4 flex h-12 items-center justify-between gap-3
                      border-b-4 border-dim bg-deep px-4">
        <div className="flex gap-2">
          <button type="button" onClick={() => go(-1)} aria-label={t("reader.prevPage")} className={padBtn}>◀</button>
          <button type="button" onClick={() => go(1)} aria-label={t("reader.nextPage")} className={padBtn}>▶</button>
        </div>
        <p className="truncate font-display text-pixel-sm text-ink">
          <span aria-hidden="true" className="mr-2 text-neon-magenta">■</span>
          CH.{current.number} — {current.title}
        </p>
        <p className="shrink-0 font-data text-[10px] text-neon-green">
          {t("common.page")} {String(page).padStart(2, "0")}/{String(total).padStart(2, "0")}
        </p>
      </div>

      {/* Progression : 4 segments magenta (Bible B.3) */}
      <div className="mt-2 flex gap-[2px]" role="progressbar" aria-label={t("reader.progress")}
           aria-valuenow={page} aria-valuemax={total}>
        {Array.from({ length: segs }, (_, i) => (
          <span key={i} className={`h-1 flex-1 ${i < filled ? "bg-neon-magenta" : "bg-raised"}`} />
        ))}
      </div>

      {onFinalPage && !bossDefeated && (
        <p className="mt-2 animate-blink text-center font-data text-[9px] tracking-widest text-alert">
          ⚠ {t("reader.finalChapter")} — {t("reader.finalBoss")}
        </p>
      )}

      {/* La planche — key={page} relance animate-slam au tournage */}
      <div key={page} className="relative mt-8 bg-paper p-4 shadow-pixel-lg md:p-8">
        <div className="relative animate-slam">
          {/* En-tête magazine */}
          <div className="flex items-center justify-between border-b-4 border-void pb-3">
            <div className="flex items-center gap-2">
              <span className="bg-void px-2 py-1 font-data text-[10px] text-paper">{t("reader.raw")}</span>
              <span className="hidden font-data text-[8px] text-void/60 sm:inline">{t("reader.protocol")}</span>
            </div>
            <span className="font-data text-[8px] text-void/60">{t("reader.volume")}</span>
          </div>

          {/* Grille de cases : 1 large + 2 demi (template shōnen Bible B.3) */}
          <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {current.panels.map((p, i) => (
              <div key={i} style={i % 2 === 1 ? { transform: "translateY(2px)" } : undefined}>
                <Panel panel={p} />
              </div>
            ))}
          </div>

          {/* Pied de planche */}
          <div className="mt-6 flex items-center justify-between border-t-4 border-void pt-3">
            <p className="font-data text-[8px] text-void/60">{t("reader.footer", { issue: current.issue })}</p>
            <p className="font-data text-[8px] text-alert">{current.footer?.right}</p>
          </div>
        </div>

        {/* Flash blanc 1 frame au tournage de page */}
        {turning && <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-paper" />}
      </div>

      {/* Barre de navigation Game Boy */}
      <div className="mt-8 flex items-center justify-between gap-4 border-4 border-dim bg-panel p-4 shadow-pixel">
        {/* D-pad */}
        <div className="hidden w-20 shrink-0 grid-cols-3 sm:grid" aria-hidden="true">
          <span /><span className="flex h-6 items-center justify-center border border-dim bg-raised font-data text-[8px] text-muted">▲</span><span />
          <span className="flex h-6 items-center justify-center border border-dim bg-raised font-data text-[8px] text-muted">◀</span>
          <span className="flex h-6 items-center justify-center border border-dim bg-deep" />
          <span className="flex h-6 items-center justify-center border border-dim bg-raised font-data text-[8px] text-muted">▶</span>
          <span /><span className="flex h-6 items-center justify-center border border-dim bg-raised font-data text-[8px] text-muted">▼</span><span />
        </div>

        <div className="hidden sm:block">
          <p className="font-display text-pixel-sm text-ink">{t("reader.navMatrix")}</p>
          <p className="mt-1 font-data text-[8px] text-neon-green">{t("reader.dpadReady")}</p>
        </div>

        <div className="hidden items-center gap-3 md:flex">
          <button type="button" onClick={() => sound.click()}
                  className={`border-2 border-dim px-3 py-1 font-data text-[10px] text-muted transition-none ${FOCUS}`}>
            {t("reader.select")}
          </button>
          <button type="button" onClick={() => { sound.click(); onStartList?.(); }}
                  className={`-skew-x-12 bg-neon-violet px-3 py-1 font-data text-[10px] text-black
                              shadow-pixel-sm transition-none active:translate-y-0.5 active:shadow-none ${FOCUS}`}>
            {t("reader.start")}
          </button>
        </div>

        <div className="flex items-center gap-2 sm:gap-3">
          {onFinalPage && !bossDefeated && (
            <button type="button" onClick={() => bossHandler.current?.()}
                    aria-label={t("reader.finalBoss")}
                    className={`border-2 border-alert bg-deep px-2 py-2 font-display text-[8px] text-alert
                                shadow-pixel-sm transition-none hover:bg-alert hover:text-black ${FOCUS}`}>
              {t("reader.finalBoss")}
            </button>
          )}
          <button type="button" onClick={() => go(-1)} aria-label={t("reader.prevPage")}
                  className={`border-2 border-neon-green bg-deep px-3 py-2 font-display text-pixel-sm text-neon-green
                              shadow-pixel-sm transition-none active:translate-x-0.5 active:translate-y-0.5 active:shadow-none
                              sm:px-4 ${FOCUS}`}>
            {t("reader.prev")}
          </button>
          <button type="button" onClick={() => go(1)} aria-label={t("reader.nextPage")}
                  className={`border-2 border-neon-magenta bg-deep px-3 py-2 font-display text-pixel-sm text-neon-magenta
                              shadow-pixel-sm transition-none active:translate-x-0.5 active:translate-y-0.5 active:shadow-none
                              sm:px-4 ${FOCUS}`}>
            {t("reader.next")}
          </button>
        </div>
      </div>
    </section>
  );
}
