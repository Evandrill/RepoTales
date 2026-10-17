/**
 * REPO TALES — LandingTerminal.jsx
 * Écran 1 « Arcade Terminal » — Design Bible v1.0
 * Audit GO conditionnel (2026-10-17) — corrections intégrées :
 *   P0-1 : « POWERED BY AMD MI300X » (Stitch avait écrit « AND »)
 *   P1-6 : ligne AUDIO + chips EXEMPLES en muted (≤3 teintes néon/écran)
 *   P1-7 : panel borne avec shadow-frame (coins NES + ombre brutaliste 8px)
 *
 * Requiert : tailwind.config.js v1.0 + les 3 fontes Google (voir config).
 * Règles Bible appliquées : radius 0, ombres dures, steps(), caret pixel,
 * focus clavier dashed cyan, contrastes ≥ 4.5:1.
 *
 * @param {{ onStart?: (repoPath: string) => void }} props
 */
import { useState } from "react";
import { BgmToggle, LangToggle } from "./Chrome.jsx";
import { sound } from "../services/soundService.js";
import { useLanguage } from "../i18n/LanguageContext.jsx";

const EXEMPLES = ["TORVALDS/LINUX", "FACEBOOK/REACT", "ASTRAL-SH/UV"];

/** user/repo ou https://github.com/user/repo */
const GITHUB_RE = /^(https?:\/\/(www\.)?github\.com\/)?[\w.-]+\/[\w.-]+\/?$/i;

/* ── Overlay CRT global — à monter UNE fois au niveau <App> ─────────────── */
export function CrtOverlay() {
  // NOTE: deux couches superposées. Mettre `bg-scanlines bg-vignette` sur le
  // même élément ne fonctionne pas en Tailwind : les deux utilitaires écrivent
  // `background-image` et le second écrase le premier.
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-50">
      <div className="absolute inset-0 bg-scanlines" />
      <div className="absolute inset-0 bg-vignette" />
    </div>
  );
}

/* ── Équerres de ciblage (coins du cabinet, cf. capture validée) ────────── */
function CornerBrackets() {
  const base = "pointer-events-none absolute h-4 w-4 border-neon-green";
  return (
    <>
      <span aria-hidden="true" className={`${base} -left-1 -top-1 border-l-4 border-t-4`} />
      <span aria-hidden="true" className={`${base} -right-1 -top-1 border-r-4 border-t-4`} />
      <span aria-hidden="true" className={`${base} -bottom-1 -left-1 border-b-4 border-l-4`} />
      <span aria-hidden="true" className={`${base} -bottom-1 -right-1 border-b-4 border-r-4`} />
    </>
  );
}

/**
 * @param {{
 *   onStart?: (repoPath: string) => void,
 *   onDemo?: () => void,
 *   busy?: boolean,
 *   serverError?: string | null,
 * }} props
 */
export default function LandingTerminal({
  onStart,
  onDemo,
  busy = false,
  serverError = null,
}) {
  const [url, setUrl] = useState("");
  const [focused, setFocused] = useState(false);
  // Store the *key*, not the rendered text: the message must follow a later
  // FR/EN toggle instead of freezing in the language used at submit time.
  const [errorKey, setErrorKey] = useState(null);
  const { t } = useLanguage();

  const shownError = serverError || (errorKey ? t(errorKey) : null);

  const submit = (e) => {
    e.preventDefault();
    if (busy) return;
    const clean = url.trim().replace(/\/$/, "");
    if (!GITHUB_RE.test(clean)) {
      sound.error();
      setErrorKey("landing.invalid");
      return;
    }
    setErrorKey(null);
    const repoPath = clean.replace(/^https?:\/\/(www\.)?github\.com\//i, "");
    sound.insertCoin(); // validation OK → pièce insérée, la saga s'éveille
    onStart?.(repoPath); // → déclenche la génération de saga côté app
  };

  const focusStyle =
    "focus-visible:outline-dashed focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-neon-cyan";

  return (
    <main className="relative flex min-h-screen flex-col items-center bg-void font-data text-ink">
      {/* ── Badge GPU sponsor (correction P0-1 : AMD, pas AND) ── */}
      <div
        className="absolute right-4 top-4 flex items-center gap-2 border-2 border-neon-green
                   bg-panel px-3 py-2 shadow-pixel-sm"
      >
        <span aria-hidden="true" className="h-2 w-2 animate-blink bg-neon-green" />
        <span className="text-[10px] tracking-widest text-neon-green">
          POWERED BY AMD MI300X
        </span>
      </div>
      <div className="absolute right-4 top-16 flex items-center gap-2">
        <BgmToggle />
        <LangToggle />
      </div>

      {/* ── Marquee de la borne ── */}
      <header className="mt-24 flex flex-col items-center gap-6 px-4 text-center">
        <h1
          className="animate-flicker font-display text-pixel-xl text-neon-magenta
                     [text-shadow:0_0_4px_#FF2A6D,0_0_12px_rgba(255,42,109,0.6),0_0_28px_rgba(176,38,255,0.35)]
                     md:text-pixel-2xl"
        >
          REPO&nbsp;TALES
        </h1>
        <p className="font-dialogue text-xl text-neon-green">
          {t("landing.tagline")}
        </p>
      </header>

      {/* ── Borne d'arcade (P1-7 : shadow-frame = coins biseautés + ombre 8px) ── */}
      <section className="mt-16 w-full max-w-[640px] px-4">
        <form onSubmit={submit} noValidate className="relative">
          <div className="relative bg-panel p-6 shadow-frame md:p-8">
            <CornerBrackets />

            <div className="mb-6 flex items-center justify-between">
              <h2 className="font-display text-pixel-sm text-muted">{t("landing.insertRepository")}</h2>
              <span className="text-[10px] text-muted">{t("landing.mode")}</span>
            </div>

            {/* Input CRT : fond inset, texte vert, curseur bloc clignotant */}
            <div className="relative border-2 border-dim bg-void px-4 py-4">
              <input
                type="text"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                aria-label={t("landing.inputAria")}
                disabled={busy}
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  if (errorKey) setErrorKey(null);
                }}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                placeholder={t("landing.placeholder")}
                className={`w-full bg-transparent text-lg text-neon-green caret-neon-green
                            placeholder:text-[#0F7A4C] focus:outline-none ${focusStyle}`}
              />
              {/* Curseur bloc (Bible A.5 cursor-blink) : visible au repos, s'efface à la saisie */}
              {!focused && !url && (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute right-4 top-1/2 h-5 w-2.5
                             -translate-y-1/2 animate-blink bg-neon-green"
                />
              )}
            </div>

            {shownError && (
              <p role="alert" className="mt-3 font-dialogue text-lg text-alert">
                ! {shownError} _
              </p>
            )}

            {/* Chips d'exemples — P1-6 : muted au repos, vert au hover (cyan/violet hors écran) */}
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <span className="text-[10px] text-muted">{t("landing.examples")}</span>
              {EXEMPLES.map((ex) => (
                <button
                  key={ex}
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    sound.click();
                    setUrl(`https://github.com/${ex.toLowerCase()}`);
                    setErrorKey(null);
                  }}
                  className={`border border-dim bg-raised px-2 py-1 text-[10px] text-muted
                              transition-none hover:border-neon-green hover:text-neon-green
                              disabled:cursor-not-allowed disabled:opacity-40
                              ${focusStyle}`}
                >
                  {ex}
                </button>
              ))}
            </div>

            {/* CTA primaire : magenta, texte noir, ombre dure, sweep coin-shine */}
            <button
              type="submit"
              disabled={busy}
              className={`group relative mt-8 w-full overflow-hidden bg-neon-magenta py-5
                          font-display text-pixel-base text-black shadow-pixel-sm
                          transition-none hover:-translate-x-0.5 hover:-translate-y-0.5
                          hover:shadow-pixel active:translate-x-0.5 active:translate-y-0.5
                          active:shadow-none disabled:cursor-wait disabled:opacity-70
                          md:text-pixel-lg ${focusStyle}`}
            >
              {busy ? t("landing.busy") : t("landing.submit")}
              {/* Bible A.5 coin-shine : sweep 600ms toutes les 4s, en steps */}
              <span
                aria-hidden="true"
                className="absolute inset-y-0 -left-1/3 w-1/3 skew-x-[-20deg] bg-white/20
                           animate-shine"
              />
            </button>

            {/* Démo hors-ligne : ni quota GitHub, ni GPU. Utile en soutenance. */}
            {onDemo && (
              <button
                type="button"
                onClick={() => {
                  sound.click();
                  onDemo?.();
                }}
                disabled={busy}
                className={`mt-3 w-full border-2 border-dim bg-raised px-3 py-2
                            font-data text-[10px] text-muted shadow-pixel-sm
                            transition-none hover:border-neon-cyan hover:text-neon-cyan
                            disabled:cursor-wait disabled:opacity-40 ${focusStyle}`}
              >
                {t("landing.demo")}
              </button>
            )}

            {/* Lignes d'ambiance arcade (dans le cabinet, comme la capture validée) */}
            <div className="mt-6 flex items-center justify-between text-[10px]">
              <span className="text-muted">{t("landing.credits")}</span>
              <span className="text-neon-green">{t("landing.difficulty")}</span>
            </div>
          </div>
        </form>
      </section>

      {/* ── Sous le cabinet — P1-6 : AUDIO passe en muted (3 teintes max) ── */}
      <div className="mt-6 flex w-full max-w-[640px] justify-between px-4 text-[10px] text-muted">
        <span>{t("landing.pressEsc")}</span>
        <span>{t("landing.audio")}</span>
      </div>

      {/* ── Footer système + hi-score ── */}
      <footer className="mb-10 mt-auto flex flex-col items-center gap-4 pt-16">
        <p className="text-[10px] tracking-widest text-muted">
          {t("landing.systemReady")}
        </p>
        <p
          className={`border-2 border-dim bg-panel px-4 py-2 text-[10px] text-gold
                      shadow-pixel-sm ${focusStyle}`}
        >
          {t("landing.topSaga")}
        </p>
      </footer>
    </main>
  );
}

/* ── Exemple de montage ────────────────────────────────────────────────────
import LandingTerminal, { CrtOverlay } from "./LandingTerminal";

export default function App() {
  return (
    <>
      <LandingTerminal onStart={(repo) => console.log("Saga lancée pour", repo)} />
      <CrtOverlay />
    </>
  );
}
─────────────────────────────────────────────────────────────────────────── */
