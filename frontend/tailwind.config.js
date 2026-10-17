/** @type {import('tailwindcss').Config} */
//
// REPO TALES — tailwind.config.js v1.0 « Neon Cartridge »
// Source de vérité : Design Bible v1.0 (audit GO conditionnel du 2026-10-17)
//
// PRÉ-REQUIS — les 3 fontes Google sont chargées dans index.html :
// Press Start 2P / VT323 / JetBrains Mono.
//
// GARDE-FOUS BIBLE :
//  - borderRadius est ÉCRASÉ (pas étendu) : les classes rounded-* de Tailwind
//    n'existent plus. Seuls `rounded-none` (0px) et `rounded-pixel` (2px) restent.
//  - Tous les timings d'animation passent par steps() — jamais d'easing lisse.
//  - Max 3 teintes néon par écran (magenta/vert/cyan/violet = rôles exclusifs).
//
// NOTE INTÉGRATION : `backgroundSize` utilise les clés `dither-size` et
// `halftone-size`. Avec `dither`/`halftone` elles généraient `bg-dither` et
// `bg-halftone`, qui écrasaient les classes `backgroundImage` du même nom.
// Les composants utilisent `bg-dither bg-dither-size`.
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    // ⚠️ Override volontaire (PAS extend) : tue rounded-lg, rounded-full, etc.
    borderRadius: {
      none: '0px',
      pixel: '2px',
    },
    extend: {
      // ─────────────────────────────────────────────
      // A.2 — PALETTE « NEON CARTRIDGE » (13 slots + paper)
      // ─────────────────────────────────────────────
      colors: {
        // Fonds (échelle froide bleu-violet)
        void: '#0A0A14', // fond global
        deep: '#12121F', // sections, HUD
        panel: '#1A1A2E', // cartes, modals, input
        raised: '#24243E', // hover, header strip
        // Neutres
        dim: '#2E2E4A', // bordures au repos
        ink: '#EAEAF2', // texte principal
        muted: '#8B8BA7', // texte secondaire
        // Néons fonctionnels (rôle exclusif — Bible A.2)
        neon: {
          magenta: '#FF2A6D', // CTA primaire, danger, ATK, boss
          violet: '#B026FF', // titres, lore, XP, épique
          green: '#05FFA1', // succès, HP, terminal, badge GPU
          cyan: '#05D9E8', // info, liens, DEF, focus clavier
        },
        gold: '#FFC857', // XP, pièces, légendaire
        alert: '#FF3355', // HP critique, erreurs, boss HP
        paper: '#F2F0F5', // planches manga (seule surface claire)
      },

      // ─────────────────────────────────────────────
      // A.3 — TYPOGRAPHIE (3 fontes, pas une de plus)
      // ─────────────────────────────────────────────
      fontFamily: {
        display: ['"Press Start 2P"', 'monospace'], // titres, boutons — UPPERCASE, <10px interdit
        dialogue: ['"VT323"', 'monospace'], // dialogues, flavor — 18px minimum
        data: ['"JetBrains Mono"', 'monospace'], // stats Git, compteurs
      },
      // Échelle Press Start 2P approuvée : 48 / 24 / 16 / 12 / 10 px
      fontSize: {
        'pixel-2xl': ['3rem', { lineHeight: '1.6', letterSpacing: '0.02em' }],
        'pixel-xl': ['1.5rem', { lineHeight: '1.6', letterSpacing: '0.02em' }],
        'pixel-lg': ['1rem', { lineHeight: '1.6', letterSpacing: '0.02em' }],
        'pixel-base': ['0.75rem', { lineHeight: '1.6', letterSpacing: '0.02em' }],
        'pixel-sm': ['0.625rem', { lineHeight: '1.6', letterSpacing: '0.02em' }],
      },

      // ─────────────────────────────────────────────
      // A.4 — BORDURES PIXEL & OMBRES DURES
      // ─────────────────────────────────────────────
      boxShadow: {
        'pixel-sm': '4px 4px 0 0 #000',
        pixel: '8px 8px 0 0 #000',
        'pixel-lg': '12px 12px 0 0 #000',
        // Cadre NES.css complet : 4 côtés (coins biseautés) + ombre brutaliste.
        // Correction audit P1-7 : utilisé par le panel terminal de la Landing.
        frame:
          '0 -4px 0 0 #2E2E4A, 0 4px 0 0 #2E2E4A, -4px 0 0 0 #2E2E4A, 4px 0 0 0 #2E2E4A, 8px 8px 0 0 #000',
        'frame-magenta':
          '0 -4px 0 0 #FF2A6D, 0 4px 0 0 #FF2A6D, -4px 0 0 0 #FF2A6D, 4px 0 0 0 #FF2A6D, 8px 8px 0 0 #000, 0 0 24px rgba(255,42,109,0.35)',
        'frame-green':
          '0 -4px 0 0 #05FFA1, 0 4px 0 0 #05FFA1, -4px 0 0 0 #05FFA1, 4px 0 0 0 #05FFA1, 8px 8px 0 0 #000, 0 0 16px rgba(5,255,161,0.25)',
        // Double contour premium du Boss Modal (Bible B.4)
        'frame-boss':
          '0 -4px 0 0 #FF2A6D, 0 4px 0 0 #FF2A6D, -4px 0 0 0 #FF2A6D, 4px 0 0 0 #FF2A6D, inset 0 0 0 2px #2E2E4A, 12px 12px 0 0 #000, 0 0 32px rgba(255,42,109,0.45)',
        // Glow néon (texte séparé via [text-shadow:...] en JSX)
        'neon-magenta': '0 0 8px #FF2A6D, 0 0 24px rgba(255,42,109,0.35)',
        'neon-green': '0 0 8px #05FFA1, 0 0 20px rgba(5,255,161,0.3)',
      },

      // ─────────────────────────────────────────────
      // A.4 — TEXTURES (scanlines, halftone, dither, hazard)
      // ─────────────────────────────────────────────
      backgroundImage: {
        scanlines:
          'repeating-linear-gradient(0deg, rgba(0,0,0,0.22) 0px, rgba(0,0,0,0.22) 2px, transparent 2px, transparent 4px)',
        vignette:
          'radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,0.35) 100%)',
        // Trame manga : points 1px / pas 5px (uniquement sur paper, jamais sur fonds UI)
        halftone:
          'radial-gradient(circle, rgba(10,10,20,0.35) 1px, transparent 1.5px)',
        // Dither 2x2 « légal 16-bit » (fonds de sprites, jauges)
        dither: 'repeating-conic-gradient(#1A1A2E 0% 25%, #24243E 0% 50%)',
        // Bandes de danger du backdrop Boss (Bible B.4) + animer via bg-hazard
        hazard:
          'repeating-linear-gradient(45deg, rgba(255,200,87,0.06) 0px, rgba(255,200,87,0.06) 12px, transparent 12px, transparent 24px)',
      },
      backgroundSize: {
        'halftone-size': '5px 5px',
        'dither-size': '4px 4px',
      },

      // ─────────────────────────────────────────────
      // A.5 — MICRO-ANIMATIONS (steps() uniquement)
      // ─────────────────────────────────────────────
      keyframes: {
        // Titre REPO TALES : flicker irrégulier de néon fatigué
        flicker: {
          '0%, 18%, 22%, 25%, 53%, 57%, 100%': { opacity: '1' },
          '20%, 24%, 55%': { opacity: '0.72' },
        },
        // Curseur bloc du terminal / underscore du boss
        blink: {
          '0%, 49%': { opacity: '1' },
          '50%, 100%': { opacity: '0' },
        },
        // Reflet diagonal du bouton INSERT COIN (sweep 600ms / cycle 4s)
        shine: {
          '0%': { transform: 'translateX(-150%) skewX(-20deg)' },
          '15%, 100%': { transform: 'translateX(350%) skewX(-20deg)' },
        },
        // Entrée des cartes Squad : slam + stagger 60ms côté JSX (style.animationDelay)
        slam: {
          '0%': { transform: 'scaleY(0.6)', opacity: '0' },
          '60%': { transform: 'scaleY(1.04)' },
          '100%': { transform: 'scaleY(1)', opacity: '1' },
        },
        // Sprite idle 2 frames
        bob: {
          '0%, 49%': { transform: 'translateY(0)' },
          '50%, 100%': { transform: 'translateY(-4px)' },
        },
        // Screen shake du Boss Modal (300ms, ±4px)
        shake: {
          '0%, 100%': { transform: 'translate(0, 0)' },
          '20%': { transform: 'translate(-4px, 2px)' },
          '40%': { transform: 'translate(4px, -2px)' },
          '60%': { transform: 'translate(-2px, -2px)' },
          '80%': { transform: 'translate(2px, 2px)' },
        },
        // Tremblement 1px de la barre HP boss
        tremble: {
          '0%, 100%': { transform: 'translate(0, 0)' },
          '50%': { transform: 'translate(0, 1px)' },
        },
        // Défilement des bandes hazard du backdrop boss
        hazard: {
          to: { backgroundPositionX: '24px' },
        },
        // Balayage vertical du squelette pendant le décodage d'une image FLUX
        scan: {
          '0%': { transform: 'translateY(-120%)' },
          '100%': { transform: 'translateY(420%)' },
        },
      },
      animation: {
        flicker: 'flicker 3s steps(1) infinite',
        blink: 'blink 1s steps(2) infinite',
        shine: 'shine 4s steps(6) infinite',
        slam: 'slam 180ms steps(4) both',
        bob: 'bob 1s steps(1) infinite',
        shake: 'shake 300ms steps(2) 1',
        tremble: 'tremble 120ms steps(1) infinite',
        hazard: 'hazard 2s linear infinite',
        scan: 'scan 1.4s steps(8) infinite',
      },

      // Easings pixel (pour transitions d'état : hover, jauges)
      transitionTimingFunction: {
        pixel2: 'steps(2)',
        pixel4: 'steps(4)',
        pixel6: 'steps(6)',
        pixel8: 'steps(8)',
      },

      // Rappel grille 8px : gaps 8/16/24, paddings 16/24/32 (échelle Tailwind ×2)
    },
  },
  plugins: [],
}
