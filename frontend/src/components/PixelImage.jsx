/**
 * REPO TALES — PixelImage.jsx
 * Image distante (FLUX via /api/image-proxy) avec squelette rétro 16-bit.
 *
 * Les illustrations FLUX mettent plusieurs secondes à arriver : un <img> nu
 * laisse un trou noir. Ce composant affiche pendant le chargement une trame
 * dither + une ligne de balayage `animate-scan` (steps), puis révèle l'image
 * avec `animate-slam`.
 *
 * Résilience : le proxy renvoie parfois un 500/502/503 transitoire (GPU qui
 * démarre, job concurrent, timeout). On retente donc jusqu'à 3 fois, à 1,5 s
 * d'intervalle, avec un paramètre anti-cache avant d'afficher « SIGNAL LOST ».
 */
import { useEffect, useRef, useState } from "react";
import PixelIcon from "./PixelIcon.jsx";
import { useLanguage } from "../i18n/LanguageContext.jsx";

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1500;

/** Ajoute `_retry=n` sans casser une query string déjà présente. */
function withRetry(url, attempt) {
  if (!attempt) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}_retry=${attempt}`;
}

/**
 * @param {{
 *   src?: string | null,
 *   alt: string,
 *   className?: string,
 *   imgClassName?: string,
 *   fallbackIcon?: string,
 *   fallbackLabel?: string,
 *   loadingLabel?: string,
 *   eager?: boolean,
 *   reveal?: boolean,
 * }} props
 */
export default function PixelImage({
  src,
  alt,
  className = "",
  imgClassName = "",
  fallbackIcon = "skull",
  fallbackLabel = "NO ARTWORK",
  loadingLabel = "DECODING FLUX…",
  eager = false,
  reveal = true,
}) {
  const { t } = useLanguage();

  /* L'état mémorise la src à laquelle il se rapporte : dès qu'une nouvelle
     image arrive, le rendu dérive `loading` immédiatement (pas de frame où
     l'ancienne image « loaded » resterait visible sur la nouvelle src). */
  /** @type {[({src: string|null, status: "loading"|"loaded"|"error"|"empty", attempt: number}), Function]} */
  const [state, setState] = useState(() => ({
    src: src ?? null,
    status: src ? "loading" : "empty",
    attempt: 0,
  }));
  const imgRef = useRef(/** @type {HTMLImageElement | null} */ (null));
  const retryTimer = useRef(null);
  const alive = useRef(true);

  const current = src ?? null;
  const status =
    state.src === current ? state.status : current ? "loading" : "empty";
  const attempt = state.src === current ? state.attempt : 0;
  const requestSrc = current ? withRetry(current, attempt) : null;
  const retrying = status === "loading" && attempt > 0;

  const settle = (next) =>
    setState((prev) =>
      prev.src === current
        ? { ...prev, status: next }
        : { src: current, status: next, attempt: 0 },
    );

  /* Nouvelle src (ou changement de route) : on remet les tentatives à zéro. */
  useEffect(() => {
    clearTimeout(retryTimer.current);
    setState({
      src: current,
      status: current ? "loading" : "empty",
      attempt: 0,
    });
  }, [current]);

  useEffect(
    () => () => {
      alive.current = false;
      clearTimeout(retryTimer.current);
    },
    [],
  );

  /* Une image déjà dans le cache HTTP peut avoir fini avant que React
     n'attache onLoad : on vérifie `complete` après chaque tentative. */
  useEffect(() => {
    const node = imgRef.current;
    if (node?.complete) {
      if (node.naturalWidth > 0) settle("loaded");
      else if (attempt >= MAX_RETRIES) settle("error");
      else scheduleRetry();
    }
    // `settle`/`scheduleRetry` dépendent de `current` ; le re-rendu est idempotent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestSrc]);

  function scheduleRetry() {
    clearTimeout(retryTimer.current);
    if (attempt >= MAX_RETRIES) {
      setState({ src: current, status: "error", attempt });
      return;
    }
    // Pendant l'attente, on garde le squelette de chargement.
    setState({ src: current, status: "loading", attempt });
    retryTimer.current = setTimeout(() => {
      if (!alive.current) return;
      setState({ src: current, status: "loading", attempt: attempt + 1 });
    }, RETRY_DELAY_MS);
  }

  return (
    <div className={`relative h-full w-full overflow-hidden ${className}`}>
      {requestSrc && status !== "error" && (
        <img
          ref={imgRef}
          key={requestSrc}
          src={requestSrc}
          alt={alt}
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          draggable={false}
          onLoad={() => settle("loaded")}
          onError={scheduleRetry}
          className={`h-full w-full object-cover [image-rendering:pixelated] ${
            status === "loaded" ? (reveal ? "animate-slam" : "") : "opacity-0"
          } ${imgClassName}`}
        />
      )}

      {status === "loading" && (
        <div
          aria-hidden="true"
          className="absolute inset-0 flex flex-col items-center justify-center gap-2 overflow-hidden bg-dither bg-dither-size"
        >
          {/* Ligne de balayage CRT (steps, Bible A.5) */}
          <span className="pointer-events-none absolute inset-x-0 top-0 h-1/3 animate-scan bg-gradient-to-b from-transparent via-neon-cyan/25 to-transparent" />
          <PixelIcon type="bolt" className="h-6 w-6 animate-blink text-neon-cyan" />
          <span className="animate-flicker font-data text-[8px] tracking-widest text-muted">
            {retrying
              ? t("image.retry", { n: attempt, max: MAX_RETRIES })
              : loadingLabel}
          </span>
          <span className="font-data text-[7px] text-dim">FLUX::SCHNELL // 16-BIT LINK</span>
        </div>
      )}

      {(status === "empty" || status === "error") && (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-dither bg-dither-size">
          <PixelIcon type={fallbackIcon} className="h-8 w-8 text-alert/70" />
          <span className="px-2 text-center font-data text-[8px] text-muted">
            {fallbackLabel}
          </span>
          {status === "error" && (
            <span className="animate-blink font-data text-[7px] text-alert">
              {t("image.signalLost")}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
