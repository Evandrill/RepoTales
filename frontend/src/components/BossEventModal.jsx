/**
 * REPO TALES — BossEventModal.jsx
 * Écran 4 « Boss Event Modal » — Design Bible v1.0 (B.4) + corrections audit :
 *   P1-5  : barre HP boss en alert-red #FF3355 (fini le saumon)
 *   P2-10 : icônes pixel 8x8 (PixelIcon) au lieu des emoji
 *   P2-12 : label unique « BOSS HP — 6500 / 10000 » (fini le doublon « HP BOSS HP »)
 *
 * Combat interactif : chaque attaque retire ses DMG, alimente le journal de
 * combat, joue attack/critical, puis bascule immédiatement sur VICTOIRE /
 * QUÊTE ACCOMPLIE à 0 PV (lire la saga, rejouer, nouvelle saga). Ouvert
 * automatiquement à la dernière page du dernier chapitre, ou depuis BOSS RAIDS.
 *
 * Accessibilité : role="dialog" aria-modal, fermeture Escape, focus initial sur
 * la 1ère attaque, journal en aria-live.
 */
import { useEffect, useRef, useState } from "react";
import PixelIcon from "./PixelIcon.jsx";
import PixelImage from "./PixelImage.jsx";
import { FOCUS } from "./Chrome.jsx";
import { sound } from "../services/soundService.js";
import { useLanguage } from "../i18n/LanguageContext.jsx";

const DEMO_BOSS = {
  name: "PRODUCTION OUTAGE",
  level: "LEVEL 99 — FINAL BUG",
  hp: 6500,
  maxHp: 10000,
  threat: "CATACLYSMIC",
  status: "[SEVERITY 1 — UNRESOLVED MERGE]",
  sig: "0xDEADBEEF",
  sprite: null,
};

const DEMO_ATTACKS = [
  { key: "FORCE PUSH", ap: 2, damage: 3200, hint: "PHASE 1 — BREAK THE PRODUCTION OUTAGE", tone: "magenta", icon: "bolt" },
  { key: "ROLLBACK", ap: 1, damage: 1600, hint: "PHASE 2 — ROLLBACK THE FATAL MERGE", tone: "cyan", icon: "rewind" },
  { key: "REFACTOR", ap: 2, damage: 2400, hint: "PHASE 3 — REFACTOR THE CORE", tone: "green", icon: "spark" },
];

/* Classes statiques (Tailwind ne compile pas les noms dynamiques) */
const TONES = {
  magenta: { border: "border-neon-magenta", text: "text-neon-magenta", pop: "text-neon-magenta" },
  cyan: { border: "border-neon-cyan", text: "text-neon-cyan", pop: "text-neon-cyan" },
  green: { border: "border-neon-green", text: "text-neon-green", pop: "text-neon-green" },
};

export default function BossEventModal({
  boss = DEMO_BOSS,
  attacks = DEMO_ATTACKS,
  heroName = "THE HERO",
  defeated = false,
  onAttack,
  onVictory,
  onReplay,
  onNewSaga,
  onClose,
}) {
  const { t, formatNumber } = useLanguage();

  const startHp = Math.max(1, Math.min(Number(boss.hp) || boss.maxHp, boss.maxHp));
  const [flash, setFlash] = useState(true);
  const [popKey, setPopKey] = useState(null);
  const [hp, setHp] = useState(startHp);
  const [log, setLog] = useState([]);
  // Rounds/damage are tracked apart from `log`: the log is capped at 6 lines
  // for display, so deriving stats from it under-counted long fights.
  const [stats, setStats] = useState({ rounds: 0, damage: 0 });
  const [victory, setVictory] = useState(Boolean(defeated));

  // Les clics rapprochés lisent une valeur toujours à jour (pas de closure
  // périmée qui infligerait deux fois les dégâts sur les mêmes PV).
  const hpRef = useRef(startHp);
  const seq = useRef(0);
  const popTimer = useRef(null);

  const moves = attacks?.length ? attacks : DEMO_ATTACKS;

  /* Alarme 8-bit + flash rouge à l'ouverture (une seule fois) */
  useEffect(() => {
    sound.unlock();
    if (!defeated) sound.alarm();
    const timeout = setTimeout(() => setFlash(false), 150);
    return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(
    () => () => {
      clearTimeout(popTimer.current);
    },
    [],
  );

  /* Fermeture Escape */
  useEffect(() => {
    const esc = (e) => e.key === "Escape" && onClose?.();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  const hpPct = Math.max(0, Math.min(100, Math.round((hp / boss.maxHp) * 100)));
  const filled = Math.round((hpPct / 100) * 20); // barre 20 segments (Bible B.4)
  const totalDamage = stats.damage;
  // Reward scales with the boss and with the length of the fight.
  const xpEarned = boss.maxHp + stats.rounds * 250;

  const threatKey = `threat.${boss.threat}`;
  const threatLabel = t(threatKey) === threatKey ? boss.threat : t(threatKey);

  const strike = (attack) => {
    if (victory || hpRef.current <= 0) return;

    const critical = attack.ap >= 2;
    const raw = Math.max(
      1,
      Math.round(Number(attack.damage) || boss.maxHp * 0.2),
    );
    const dmg = Math.min(hpRef.current, raw);
    const next = hpRef.current - dmg;

    if (critical) sound.critical();
    else sound.attack();

    setPopKey(attack.key);
    clearTimeout(popTimer.current);
    popTimer.current = setTimeout(() => setPopKey(null), 400);

    hpRef.current = next;
    setHp(next);
    setStats((prev) => ({
      rounds: prev.rounds + 1,
      damage: prev.damage + dmg,
    }));

    const line = t(critical ? "boss.criticalLine" : "boss.attackLine", {
      hero: heroName,
      move: attack.key,
      dmg: formatNumber(dmg),
    });
    setLog((prev) =>
      [
        ...prev,
        { id: (seq.current += 1), text: line, damage: dmg, critical },
      ].slice(-6),
    );

    onAttack?.(attack.key, attack, dmg, next);

    if (next <= 0) {
      // No delay: the kill blow switches the modal to the victory screen at
      // once, with the quest-clear fanfare. `onVictory` runs synchronously so
      // the win persists even if the modal closes on the same tick.
      setVictory(true);
      sound.victory();
      onVictory?.();
    }
  };

  const replay = () => {
    hpRef.current = startHp;
    setHp(startHp);
    setLog([]);
    setStats({ rounds: 0, damage: 0 });
    setVictory(false);
    sound.click();
    onReplay?.();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("boss.dialogAria", { name: boss.name })}
      className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/70 p-4 sm:items-center"
    >
      {/* Backdrop bandes hazard défilantes (Bible B.4) */}
      <div aria-hidden="true" className="absolute inset-0 bg-hazard animate-hazard" />

      {/* Flash rouge 150ms (P1 d'ambiance boss-slam) */}
      {flash && <div aria-hidden="true" className="absolute inset-0 bg-alert/60" />}

      {/* Screen shake 300ms sur le conteneur, slam sur la fenêtre */}
      <div className="relative my-4 w-full max-w-[560px] animate-shake">
        <div className="animate-slam bg-panel shadow-frame-boss">
          {/* Bandeau d'alerte / de victoire */}
          <div
            className={`flex items-center justify-between gap-2 border-b-4 border-void px-4 py-3 ${
              victory ? "bg-gold" : "bg-alert"
            }`}
          >
            <span className="font-data text-[8px] text-black/70">
              {t(victory ? "boss.sysClear" : "boss.sysAlert")}
            </span>
            <p
              className={`text-center font-display text-pixel-sm ${
                victory ? "text-black" : "animate-blink text-gold"
              }`}
            >
              {t(victory ? "boss.questComplete" : "boss.warning")}
            </p>
            <span className="font-data text-[8px] text-black/70">{t("boss.err")}</span>
          </div>

          {victory ? (
            /* ── Écran VICTORY / QUEST COMPLETED ─────────────────────────── */
            <div className="space-y-6 p-6 text-center md:p-8">
              <div className="mx-auto flex h-20 w-20 items-center justify-center border-4 border-gold bg-deep shadow-pixel-sm">
                <span aria-hidden="true" className="animate-bob text-4xl text-gold">★</span>
              </div>

              <div>
                <h2 className="animate-slam font-display text-pixel-xl text-gold
                               [text-shadow:0_0_4px_#FFD166,0_0_14px_rgba(255,209,102,0.55)]">
                  {t("boss.victory")}
                </h2>
                <p className="mt-3 font-display text-pixel-base text-neon-green">
                  {t("boss.questComplete")}
                </p>
              </div>

              <p className="font-dialogue text-xl leading-tight text-muted">
                {t("boss.eradicated", { boss: boss.name })}
              </p>

              {/* Récompense : badge EXP + nombre de manches jouées */}
              <div className="mx-auto flex max-w-sm flex-col items-center gap-2 border-2 border-gold bg-deep px-4 py-3 shadow-pixel-sm">
                <p className="animate-slam font-display text-pixel-base text-gold [text-shadow:0_0_6px_rgba(255,209,102,0.6)]">
                  {t("boss.xpGained", { xp: formatNumber(xpEarned) })}
                </p>
                <p className="font-data text-[9px] text-muted">
                  {t("boss.rounds", { count: formatNumber(stats.rounds) })}
                </p>
                <p className="font-data text-[9px] text-neon-green">
                  {t("boss.damageDealt", { count: formatNumber(totalDamage) })}
                </p>
              </div>

              {/* Exactement 3 actions : lire, rejouer, repartir de zéro. */}
              <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
                <button
                  type="button"
                  onClick={() => {
                    sound.click();
                    onClose?.();
                  }}
                  className={`border-2 border-gold bg-deep px-3 py-2 font-display text-pixel-sm text-gold
                              shadow-pixel-sm transition-none hover:bg-gold hover:text-black ${FOCUS}`}
                >
                  {t("boss.viewSaga")}
                </button>
                <button
                  type="button"
                  onClick={replay}
                  className={`border-2 border-neon-green bg-deep px-3 py-2 font-display text-pixel-sm text-neon-green
                              shadow-pixel-sm transition-none hover:bg-neon-green hover:text-black ${FOCUS}`}
                >
                  {t("boss.replayCombat")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    sound.click();
                    onNewSaga?.();
                  }}
                  className={`border-2 border-dim bg-raised px-3 py-2 font-display text-pixel-sm text-ink
                              shadow-pixel-sm transition-none hover:border-neon-magenta hover:text-neon-magenta ${FOCUS}`}
                >
                  {t("boss.newSaga")}
                </button>
              </div>
            </div>
          ) : (
            /* ── Combat en cours ─────────────────────────────────────────── */
            <div className="space-y-5 p-6 md:p-8">
              {/* Sprite du boss + signature */}
              <div className="relative mx-auto h-40 w-40 border-2 border-dim bg-void">
                <PixelImage
                  src={boss.sprite}
                  alt={t("boss.spriteAlt", { name: boss.name })}
                  fallbackIcon="skull"
                  fallbackLabel={t("boss.spriteFallback")}
                  loadingLabel={t("boss.awakening")}
                  imgClassName="animate-bob"
                  reveal={false}
                  eager
                />
                <span className="absolute bottom-2 right-2 border border-alert bg-void px-1 py-0.5 font-data text-[8px] text-alert">
                  [{t("boss.sig")}: {boss.sig}]
                </span>
              </div>

              {/* Identité du boss */}
              <div className="text-center">
                <h2 className="break-words font-display text-pixel-lg text-alert
                               [text-shadow:0_0_4px_#FF3355,0_0_12px_rgba(255,51,85,0.6)]">
                  {boss.name}
                </h2>
                <p className="mt-2 font-dialogue text-lg text-muted">
                  {t("boss.daemon", { level: boss.level })}
                </p>
              </div>

              {/* Bloc HP — P1-5 : #FF3355 strict, tremblement 1px (Bible B.4) */}
              <div className="border-2 border-dim bg-deep p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  {/* P2-12 : un seul label, pas de « HP BOSS HP » */}
                  <p className="font-data text-[10px] text-ink">
                    {t("boss.hp", {
                      hp: formatNumber(hp),
                      max: formatNumber(boss.maxHp),
                    })}
                  </p>
                  <span className="bg-alert px-2 py-1 font-data text-[8px] text-black">
                    {t("boss.threat", { threat: threatLabel })}
                  </span>
                </div>
                <div className="mt-3 flex gap-[2px] animate-tremble" role="meter" aria-label={t("boss.hp", { hp, max: boss.maxHp })}
                     aria-valuenow={hp} aria-valuemax={boss.maxHp} aria-valuemin={0}>
                  {Array.from({ length: 20 }, (_, i) => (
                    <span key={i} className={`h-4 flex-1 ${i < filled ? "bg-alert" : "bg-raised/60"}`} />
                  ))}
                </div>
                <p className="mt-2 flex flex-wrap justify-between gap-2 font-data text-[8px] text-muted">
                  <span className="truncate">
                    {t("boss.status")} {boss.status}
                  </span>
                  <span className="shrink-0 text-gold">{t("boss.remaining", { pct: hpPct })}</span>
                </p>
              </div>

              {/* Les 3 attaques — libellés courts, hints tronqués, zéro overflow */}
              <div className="space-y-2">
                {moves.map((a, i) => {
                  const tone = TONES[a.tone] ?? TONES.magenta;
                  return (
                    <button
                      key={a.key}
                      type="button"
                      autoFocus={i === 0}
                      onClick={() => strike(a)}
                      className={`group relative flex w-full items-center gap-2 border-2 ${tone.border}
                                  bg-deep px-3 py-3 text-left transition-none hover:-translate-x-0.5 hover:-translate-y-0.5
                                  hover:shadow-pixel-sm active:translate-x-0 active:translate-y-0 active:shadow-none
                                  sm:gap-3 sm:px-4 sm:py-4 ${FOCUS}`}
                    >
                      <PixelIcon type={a.icon} className={`h-4 w-4 shrink-0 ${tone.text}`} />
                      <span className="min-w-0 flex-1">
                        <span className={`block truncate font-display text-[10px] leading-tight sm:text-pixel-base ${tone.text}`}>
                          {a.key}
                        </span>
                        <span className="mt-1 block truncate font-data text-[8px] text-muted">
                          {a.hint}
                        </span>
                      </span>
                      <span className="shrink-0 border border-dim px-1 py-0.5 font-data text-[8px] text-gold">
                        {t("boss.damageChip", {
                          dmg: formatNumber(
                            Math.max(1, Math.round(Number(a.damage) || boss.maxHp * 0.2)),
                          ),
                        })}
                      </span>
                      <span className="shrink-0 border border-dim px-1 py-0.5 font-data text-[8px] text-muted">
                        {t("boss.ap", { ap: a.ap })}
                      </span>
                      {/* Pop SFX (Bible B.4 « +CRIT! ») */}
                      <span aria-hidden="true"
                            className={`absolute -right-2 -top-3 font-display text-[8px] ${tone.pop} ${
                              popKey === a.key ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                            }`}>
                        {t("boss.crit")}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* Journal de combat — dernière ligne en tête de lecture */}
              <div className="border-2 border-dim bg-void/60 p-3">
                <div className="mb-2 flex items-center justify-between gap-2 font-data text-[8px]">
                  <span className="truncate text-neon-green">▮ {t("boss.logTitle")}</span>
                  <span className="shrink-0 text-muted">
                    {t("boss.round", { n: formatNumber(stats.rounds + 1) })}
                  </span>
                </div>
                <ul aria-live="polite" className="space-y-1 font-data text-[10px] leading-relaxed">
                  {log.length === 0 ? (
                    <li className="text-muted">{t("boss.logEmpty")}</li>
                  ) : (
                    log.slice(-4).map((entry) => (
                      <li
                        key={entry.id}
                        className={entry.critical ? "text-alert" : "text-neon-green"}
                      >
                        » {entry.text}
                      </li>
                    ))
                  )}
                </ul>
              </div>

              {/* Pied : choix du développeur + bloc clignotant vert (cf. capture validée) */}
              <p className="text-center font-dialogue text-lg text-muted">
                {t("boss.choose")}
                <span aria-hidden="true" className="ml-1 inline-block h-3 w-2 translate-y-0.5 animate-blink bg-neon-green" />
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
