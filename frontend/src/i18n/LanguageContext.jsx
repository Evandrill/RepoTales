/**
 * REPO TALES — LanguageContext
 *
 * Persisted EN/FR UI language. Kept tiny on purpose: components call
 * `const { t, lang, toggleLang, formatNumber } = useLanguage()` and never
 * touch localStorage themselves. The saga *content* language is handled by the
 * backend (`POST /saga/generate { language }`), because Qwen writes it.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { DEFAULT_LANGUAGE, LANGUAGES, translate } from "./translations.js";

const STORAGE_KEY = "repotales:lang";

function readStoredLanguage() {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return LANGUAGES.includes(value) ? value : DEFAULT_LANGUAGE;
  } catch {
    // Private mode / blocked storage: English is a safe, complete default.
    return DEFAULT_LANGUAGE;
  }
}

function persist(lang) {
  try {
    window.localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // Preferences are best-effort; the session still works without storage.
  }
}

const fallback = {
  lang: DEFAULT_LANGUAGE,
  locale: "en-US",
  setLang: () => {},
  toggleLang: () => {},
  t: (key, vars) => translate(DEFAULT_LANGUAGE, key, vars),
  formatNumber: (value) => String(value),
};

const LanguageContext = createContext(fallback);

export function LanguageProvider({ children }) {
  const [lang, setLangState] = useState(readStoredLanguage);

  const setLang = useCallback((next) => {
    const safe = LANGUAGES.includes(next) ? next : DEFAULT_LANGUAGE;
    setLangState(safe);
    persist(safe);
  }, []);

  const toggleLang = useCallback(() => {
    setLangState((prev) => {
      const next = prev === "fr" ? "en" : "fr";
      persist(next);
      return next;
    });
  }, []);

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.lang = lang;
    }
  }, [lang]);

  const locale = lang === "fr" ? "fr-FR" : "en-US";

  const t = useCallback(
    (key, vars) => translate(lang, key, vars),
    [lang],
  );

  const formatNumber = useCallback(
    (value) => {
      const number = Number(value);
      return Number.isFinite(number)
        ? number.toLocaleString(locale)
        : String(value);
    },
    [locale],
  );

  const value = useMemo(
    () => ({ lang, locale, setLang, toggleLang, t, formatNumber }),
    [lang, locale, setLang, toggleLang, t, formatNumber],
  );

  return (
    <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>
  );
}

export function useLanguage() {
  return useContext(LanguageContext);
}
