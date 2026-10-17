/**
 * REPO TALES — Chrome.jsx
 * Habillage commun : TopHUD (barre de navigation), StatusBar (footer système),
 * PixelAvatar (correction audit P0-2 : avatar CARRÉ pixel, cercle interdit).
 * Focus clavier partagé : contour dashed cyan (Bible A.2).
 */
import { useEffect, useState } from "react";
import PixelIcon from "./PixelIcon.jsx";
import { sound } from "../services/soundService.js";
import { useLanguage } from "../i18n/LanguageContext.jsx";

/** Focus clavier Bible — à réutiliser sur tout élément interactif */
export const FOCUS =
  "focus-visible:outline-dashed focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-neon-cyan";

/**
 * Navigation stable du HUD. Les ids ne changent jamais avec la langue ;
 * seuls les libellés sont traduits (SagaApp route sur l'id, pas sur le texte).
 */
export const NAV_ITEMS = [
  { id: "roster", key: "nav.roster" },
  { id: "reader", key: "nav.questLog" },
  { id: "boss", key: "nav.bossRaids" },
  { id: "new", key: "nav.newSaga" },
];

/* ── Bouton d'état BGM : coupe/relance la boucle chiptune ──────────────── */
export function BgmToggle({ className = "" }) {
  const [enabled, setEnabled] = useState(() => sound.isBgmEnabled());
  const { t } = useLanguage();

  useEffect(() => sound.subscribe(setEnabled), []);

  return (
    <button
      type="button"
      onClick={() => sound.toggleBgm()}
      aria-pressed={enabled}
      aria-label={t(enabled ? "hud.bgmAriaOn" : "hud.bgmAriaOff")}
      title={t(enabled ? "hud.bgmOnTitle" : "hud.bgmOffTitle")}
      className={`border-2 border-dim bg-panel px-2 py-1 font-data text-[8px] uppercase
                  tracking-widest transition-none hover:border-neon-cyan hover:text-neon-cyan
                  ${enabled ? "text-neon-cyan" : "text-muted"} ${FOCUS} ${className}`}
    >
      [BGM:<span className="hidden lg:inline"> CHIP-SYNTH 8-BIT</span>{" "}
      {t(enabled ? "common.on" : "common.off")}]
    </button>
  );
}

/* ── Bascule FR / EN : langue d'interface + langue de génération Qwen ───── */
export function LangToggle({ className = "" }) {
  const { lang, toggleLang, t } = useLanguage();

  return (
    <button
      type="button"
      onClick={() => {
        sound.click();
        toggleLang();
      }}
      aria-label={t("hud.langAria")}
      title={t("hud.langTitle")}
      className={`border-2 border-dim bg-panel px-2 py-1 font-data text-[8px] uppercase
                  tracking-widest transition-none hover:border-neon-cyan ${FOCUS} ${className}`}
    >
      [LANG:{" "}
      <span className={lang === "fr" ? "text-neon-cyan" : "text-muted"}>FR</span>
      {" / "}
      <span className={lang === "en" ? "text-neon-cyan" : "text-muted"}>EN</span>]
    </button>
  );
}

/* ── Navigation compacte mobile / tablette ─────────────────────────────────
 * Sur < lg, les menus du HUD sont masqués : sans cette rangée, un joueur
 * mobile ne pouvait plus revenir du lecteur au roster ni lancer un raid boss.
 * La rangée n'est pas sticky : elle défile, le HUD reste seul en haut.
 */
export function MobileNav({ onNavigate }) {
  const { t } = useLanguage();

  return (
    <div className="flex items-stretch gap-1 border-b-4 border-dim bg-panel px-2 py-1.5 lg:hidden">
      {NAV_ITEMS.map(({ id, key }) => (
        <button
          key={id}
          type="button"
          onClick={() => onNavigate?.(id)}
          className={`flex-1 border border-dim bg-raised px-1 py-1.5 font-display text-[7px]
                      leading-tight text-ink transition-none hover:border-neon-violet
                      hover:text-neon-violet ${FOCUS}`}
        >
          {t(key)}
        </button>
      ))}
      <LangToggle className="shrink-0 sm:hidden" />
    </div>
  );
}

/* ── Avatar pixel carré — P0-2 : border-radius interdit, on frame en dur ── */
export function PixelAvatar({ src, alt = "Avatar héros", size = 36 }) {
  return (
    <span
      className="inline-block shrink-0 overflow-hidden border-2 border-neon-violet bg-raised"
      style={{ width: size, height: size }}
    >
      {src ? (
        <img
          src={src}
          alt={alt}
          className="h-full w-full object-cover [image-rendering:pixelated]"
        />
      ) : (
        <span className="flex h-full w-full items-center justify-center bg-dither bg-dither-size">
          <PixelIcon type="diamond" className="h-4 w-4 text-neon-violet" />
        </span>
      )}
    </span>
  );
}

/* ── HUD supérieur : logo, menus, daemon, niveau/EXP, avatar ───────────── */
export function TopHUD({
  menus,
  onNavigate,
  onHome,
  level = "LVL 84",
  title,
  exp = 4820,
  daemonOnline = true,
  avatar,
}) {
  const { t, formatNumber } = useLanguage();

  // `menus` reste accepté (strings ou {id,label}) pour les tests/maquettes ;
  // SagaApp n'en passe plus et récupère les libellés traduits par défaut.
  const items = (menus ?? NAV_ITEMS.map(({ id, key }) => ({ id, label: t(key) })))
    .map((item) => (typeof item === "string" ? { id: item, label: item } : item));

  const LogoTag = onHome ? "button" : "div";

  return (
    <nav
      aria-label={t("hud.aria")}
      className="sticky top-0 z-30 flex h-12 items-center justify-between gap-4
                 border-b-4 border-dim bg-deep px-4"
    >
      {/* Logo + version — cliquable : retour accueil / nouvelle saga */}
      <LogoTag
        {...(onHome ? { type: "button", onClick: onHome, title: t("hud.newSaga") } : {})}
        className={`flex items-center gap-3 text-left ${
          onHome ? `transition-none hover:opacity-80 ${FOCUS}` : ""
        }`}
      >
        <PixelAvatar src={avatar} alt={t("hud.logoAlt")} size={28} />
        <div className="leading-none">
          <p className="font-display text-pixel-sm text-neon-magenta">REPO TALES</p>
          <p className="mt-1 font-data text-[8px] text-muted">{t("hud.version")}</p>
        </div>
      </LogoTag>

      {/* Menus (desktop uniquement) */}
      <div className="hidden items-center gap-4 lg:flex">
        {items.map((item) => {
          const [first, ...rest] = item.label.split(" ");
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onNavigate?.(item.id)}
              className={`w-20 text-left font-display text-[7px] leading-[1.6] text-ink
                          transition-none hover:text-neon-violet xl:w-24 xl:text-[8px] ${FOCUS}`}
            >
              [{first}
              {rest.length > 0 && (
                <>
                  <br />
                  {rest.join(" ")}
                </>
              )}
              ]
            </button>
          );
        })}
      </div>

      {/* BGM + langue + daemon + niveau + EXP + avatar (P0-2 : avatar carré) */}
      <div className="flex items-center gap-3">
        <BgmToggle className="hidden md:inline-flex" />
        <LangToggle className="hidden sm:inline-flex" />
        <span className="hidden items-center gap-2 border-2 border-neon-green bg-panel px-2 py-1 md:flex">
          <span
            aria-hidden="true"
            className={`h-1.5 w-1.5 ${daemonOnline ? "animate-blink bg-neon-green" : "bg-alert"}`}
          />
          <span className="font-data text-[8px] text-neon-green">
            {t("hud.daemon")} {t(daemonOnline ? "hud.online" : "hud.down")}
          </span>
        </span>
        <div className="hidden text-right leading-none xl:block">
          <p className="font-data text-[10px] text-ink">
            {level} <span className="text-muted">{title ?? t("hud.rank")}</span>
          </p>
          <p className="mt-1 flex items-center justify-end gap-1 font-data text-[10px] text-gold">
            <PixelIcon type="coin" className="h-2.5 w-2.5" />
            {formatNumber(exp)} {t("common.exp")}
          </p>
        </div>
        <PixelAvatar src={avatar} alt={t("hud.profileAlt")} />
      </div>
    </nav>
  );
}

/* ── Barre de statut système (footer des écrans internes) ──────────────── */
export function StatusBar({ branch = "MAIN", commit = "#7F3B9A" }) {
  const { t } = useLanguage();

  return (
    <footer
      className="flex h-10 items-center justify-between gap-4 border-t-4 border-dim
                 bg-deep px-4 font-data text-[8px] text-muted"
    >
      <p className="truncate">
        <span aria-hidden="true" className="mr-2 text-neon-green">■</span>
        {t("status.insert")}
      </p>
      <BgmToggle className="shrink-0" />
      <p className="truncate">
        {t("status.branch")} <span className="text-neon-green">[{branch}]</span> //{" "}
        {t("status.commit")} {commit} //{" "}
        <span className="text-neon-green">{t("status.engine")}</span>
      </p>
    </footer>
  );
}
