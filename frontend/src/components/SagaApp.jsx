/**
 * REPO TALES — SagaApp.jsx
 * Composition de référence : branche les 4 écrans sur le backend FastAPI.
 *
 * CONTRAT ATTENDU — vue normalisée produite par `src/api/viewModel.ts` :
 * {
 *   heroes:  [ { id, name, level, rarity, klass, sub, hp, atk, def, commits, prs, streak, sprite? } ],
 *   guild:   { name, xp, xpMax, level, nextTier, nextTierXp, nextTierMax },
 *   chapters:[ { number, title, issue, panels: [ { span, art?, bubble?, sfx?, caption?, terminal? } ],
 *                footer: { left, right } } ],
 *   boss:    { name, level, hp, maxHp, threat, status, sig, sprite?,
 *              attacks: [ { key, ap, damage, hint, tone, icon } ] }
 * }
 *
 * Navigation (ids stables, libellés traduits dans Chrome.jsx) :
 *   roster → guild roster · reader → manga saga · boss → combat · new → landing.
 */
import { useCallback, useEffect, useState } from "react";
import { TopHUD, StatusBar, MobileNav } from "./Chrome.jsx";
import GuildRoster from "./GuildRoster.jsx";
import MangaReader from "./MangaReader.jsx";
import BossEventModal from "./BossEventModal.jsx";
import { CrtOverlay } from "./LandingTerminal.jsx";
import { buildSagaView } from "../api/viewModel";
import { useLanguage } from "../i18n/LanguageContext.jsx";

/**
 * @param {{
 *   apiBase?: string,
 *   initialSaga?: import('../api/viewModel').SagaView | null,
 *   onReset?: () => void,
 * }} props
 */
export default function SagaApp({ apiBase = "/api", initialSaga = null, onReset }) {
  const { lang } = useLanguage();
  const [saga, setSaga] = useState(initialSaga);
  const [view, setView] = useState("roster");
  const [bossOpen, setBossOpen] = useState(false);
  const [bossDefeated, setBossDefeated] = useState(false);

  /* Données externes (génération en cours) : on remplace l'état courant. */
  useEffect(() => {
    if (initialSaga) {
      setSaga(initialSaga);
      setBossDefeated(false);
      setBossOpen(false);
    }
  }, [initialSaga]);

  /* Sans génération explicite : chargement du mock FastAPI dans la langue UI. */
  useEffect(() => {
    if (initialSaga) return undefined;
    let alive = true;
    fetch(`${apiBase}/saga/mock?lang=${lang === "fr" ? "fr" : "en"}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      // /saga/mock returns the raw SagaPayload; the screens expect the mapped
      // SagaView (heroes/guild/chapters/boss), so run it through the adapter.
      .then((data) => alive && setSaga(buildSagaView(data)))
      .catch(() => alive && setSaga(null)); // offline → captures validées
    return () => {
      alive = false;
    };
  }, [apiBase, initialSaga, lang]);

  const navigate = (id) => {
    if (id === "roster" || id === "reader" || id === "boss") {
      if (id === "reader" || id === "boss") setView("reader");
      else setView("roster");
      if (id === "boss") setBossOpen(true);
      else setBossOpen(false);
      window.scrollTo(0, 0);
      return;
    }
    if (id === "new") {
      setBossOpen(false);
      onReset?.();
    }
  };

  /* Le boss surgit à la fin du dernier chapitre (ou via BOSS RAIDS). */
  const handleBossEncounter = useCallback(() => {
    if (!bossDefeated) setBossOpen(true);
  }, [bossDefeated]);

  return (
    <div className="min-h-screen bg-void">
      <TopHUD
        onNavigate={navigate}
        onHome={onReset}
        level={saga?.heroes?.[0] ? `LVL ${saga.heroes[0].level}` : "LVL 84"}
        exp={saga?.guild ? saga.guild.xp : 4820}
      />
      <MobileNav onNavigate={navigate} />

      {view === "roster" && (
        <GuildRoster
          heroes={saga?.heroes}
          guild={saga?.guild}
          onInspect={() => {
            setView("reader");
            setBossOpen(false);
            window.scrollTo(0, 0);
          }}
        />
      )}

      {view === "reader" && (
        <MangaReader
          chapters={saga?.chapters}
          bossDefeated={bossDefeated}
          bossOpen={bossOpen}
          onBossEncounter={handleBossEncounter}
          onStartList={() => setView("roster")}
        />
      )}

      {bossOpen && (
        <BossEventModal
          boss={saga?.boss}
          attacks={saga?.boss?.attacks}
          heroName={saga?.heroes?.[0]?.name}
          defeated={bossDefeated}
          onVictory={() => setBossDefeated(true)}
          onReplay={() => setBossDefeated(false)}
          onNewSaga={onReset}
          onClose={() => setBossOpen(false)}
        />
      )}

      <StatusBar branch="MAIN" commit={saga?.boss?.sig || "#7F3B9A"} />
      <CrtOverlay />
    </div>
  );
}
