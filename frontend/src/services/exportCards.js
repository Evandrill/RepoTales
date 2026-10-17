/**
 * REPO TALES — exportCards.js
 *
 * Draws the whole guild roster as one collectible team sheet on a <canvas>
 * and downloads it as a PNG. No dependency, no server round-trip: the same
 * component data that renders the cards is painted at 1240px wide, so the
 * exported image is shareable for the hackathon submission.
 *
 * Portraits are loaded through the existing /api/image-proxy URLs. A missing
 * or slow portrait never blocks the export: the card falls back to the
 * "NO SIGNAL" placeholder after a short timeout. If the canvas is tainted
 * (cross-origin FLUX host without CORS), the export retries without images.
 */

const COLORS = {
  void: "#0A0A14",
  deep: "#101020",
  panel: "#141426",
  raised: "#1D1D32",
  dim: "#3A3A5C",
  ink: "#F2F0F5",
  muted: "#8A8AA8",
  green: "#4DFF88",
  magenta: "#FF2A6D",
  violet: "#B026FF",
  cyan: "#05D9E8",
  gold: "#FFD166",
  alert: "#FF3355",
  black: "#05050C",
};

const RARITY = {
  LEGENDARY: { color: COLORS.gold, glyph: "★" },
  EPIC: { color: COLORS.violet, glyph: "◆" },
  RARE: { color: COLORS.cyan, glyph: "▲" },
};

const PIXEL = '"Press Start 2P", monospace';
const DIALOGUE = '"VT323", monospace';
const DATA = '"JetBrains Mono", monospace';

const CARD_W = 271;
const CARD_H = 430;
const GAP = 20;
const PAD = 48;
const COLS = 4;

const SPRITE_TIMEOUT_MS = 4000;

function loadSprite(url) {
  if (!url) return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    let settled = false;
    const timer = setTimeout(() => finish(null), SPRITE_TIMEOUT_MS);

    function finish(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }

    img.crossOrigin = "anonymous"; // never taint the export canvas
    img.onload = () => finish(img.naturalWidth ? img : null);
    img.onerror = () => finish(null);
    img.src = url;
  });
}

function fill(ctx, text, vars) {
  return String(text ?? "").replace(/\{(\w+)\}/g, (match, name) =>
    vars[name] === undefined || vars[name] === null ? match : String(vars[name]),
  );
}

/** Shrink, then ellipsize, so a long LLM name cannot escape its card. */
function drawFitted(ctx, text, x, y, maxWidth, options = {}) {
  const {
    size = 10,
    family = DATA,
    color = COLORS.ink,
    align = "left",
  } = options;
  let current = size;
  ctx.font = `${current}px ${family}`;
  while (current > 6 && ctx.measureText(text).width > maxWidth) {
    current -= 1;
    ctx.font = `${current}px ${family}`;
  }
  let value = String(text ?? "");
  if (ctx.measureText(value).width > maxWidth) {
    while (value.length > 1 && ctx.measureText(`${value}…`).width > maxWidth) {
      value = value.slice(0, -1);
    }
    value = `${value}…`;
  }
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(value, x, y);
  return current;
}

function pixelBox(ctx, x, y, w, h, color) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

function drawFrame(ctx, width, height) {
  ctx.fillStyle = COLORS.void;
  ctx.fillRect(0, 0, width, height);

  // Pixel grid / scanlines, deliberately faint so the text stays readable.
  ctx.fillStyle = "rgba(176, 38, 255, 0.05)";
  for (let y = 0; y < height; y += 4) ctx.fillRect(0, y, width, 1);
  ctx.fillStyle = "rgba(5, 217, 232, 0.04)";
  for (let x = 0; x < width; x += 48) ctx.fillRect(x, 0, 1, height);

  // Cabinet frame.
  ctx.strokeStyle = COLORS.dim;
  ctx.lineWidth = 4;
  ctx.strokeRect(12, 12, width - 24, height - 24);
  pixelBox(ctx, PAD, 150, 120, 4, COLORS.magenta);
}

function drawHeader(ctx, guildName, labels) {
  drawFitted(ctx, labels.title, PAD, 88, 900, {
    size: 30,
    family: PIXEL,
    color: COLORS.magenta,
  });
  drawFitted(ctx, fill(labels.subtitle, { guild: guildName }), PAD, 124, 900, {
    size: 16,
    family: DIALOGUE,
    color: COLORS.muted,
  });
  drawFitted(ctx, labels.badge ?? "16-BIT SAGA CORE // TEAM SHEET", 1060, 88, 132, {
    size: 7,
    family: PIXEL,
    color: COLORS.green,
    align: "right",
  });
}

function drawGauge(ctx, x, y, w, label, value) {
  const clamped = Math.max(0, Math.min(10, Number(value) || 0));
  ctx.font = `7px ${DATA}`;
  ctx.fillStyle = COLORS.muted;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(label, x, y);
  ctx.fillStyle = COLORS.ink;
  ctx.textAlign = "right";
  ctx.fillText(`${String(clamped).padStart(2, "0")}/10`, x + w, y);

  const gap = 2;
  const cell = (w - gap * 9) / 10;
  for (let i = 0; i < 10; i += 1) {
    ctx.fillStyle = i < clamped ? COLORS.green : COLORS.raised;
    ctx.fillRect(x + i * (cell + gap), y + 6, cell, 7);
  }
}

function drawCard(ctx, hero, x, y, sprite, labels) {
  const rarity = RARITY[hero.rarity] ?? RARITY.RARE;
  const innerX = x + 12;
  const innerW = CARD_W - 24;

  // Card body + corner rivets.
  pixelBox(ctx, x, y, CARD_W, CARD_H, COLORS.panel);
  ctx.strokeStyle = rarity.color;
  ctx.lineWidth = 4;
  ctx.strokeRect(x + 2, y + 2, CARD_W - 4, CARD_H - 4);
  for (const [dx, dy] of [
    [0, 0],
    [CARD_W - 6, 0],
    [0, CARD_H - 6],
    [CARD_W - 6, CARD_H - 6],
  ]) {
    pixelBox(ctx, x + dx, y + dy, 6, 6, rarity.color);
  }

  // Slot + rarity ribbon.
  drawFitted(ctx, `#${hero.id}-${(hero.sub || "").split(" ")[0] || "CORE"}`, innerX, y + 26, 140, {
    size: 8,
    color: COLORS.muted,
  });
  drawFitted(ctx, `${rarity.glyph} ${hero.rarity}`, x + CARD_W - 12, y + 26, 110, {
    size: 8,
    color: rarity.color,
    align: "right",
  });

  // Portrait (cover crop, pixelated).
  const px = innerX;
  const py = y + 38;
  const pw = innerW;
  const ph = 150;
  pixelBox(ctx, px, py, pw, ph, COLORS.black);
  if (sprite) {
    ctx.imageSmoothingEnabled = false;
    const scale = Math.max(pw / sprite.naturalWidth, ph / sprite.naturalHeight);
    const dw = sprite.naturalWidth * scale;
    const dh = sprite.naturalHeight * scale;
    ctx.drawImage(sprite, px + (pw - dw) / 2, py + (ph - dh) / 2, dw, dh);
  } else {
    ctx.fillStyle = COLORS.raised;
    ctx.fillRect(px, py, pw, ph);
    drawFitted(ctx, rarity.glyph, px + pw / 2, py + ph / 2 + 8, pw - 24, {
      size: 26,
      family: DIALOGUE,
      color: rarity.color,
      align: "center",
    });
    drawFitted(ctx, "NO SIGNAL", px + pw / 2, py + ph - 14, pw - 24, {
      size: 7,
      color: COLORS.muted,
      align: "center",
    });
  }
  ctx.strokeStyle = COLORS.dim;
  ctx.lineWidth = 2;
  ctx.strokeRect(px, py, pw, ph);

  // Name + level.
  drawFitted(ctx, hero.name, innerX, y + 218, innerW - 62, {
    size: 13,
    family: PIXEL,
    color: COLORS.ink,
  });
  drawFitted(ctx, `${labels.level}${hero.level}`, x + CARD_W - 12, y + 218, 58, {
    size: 8,
    color: COLORS.muted,
    align: "right",
  });

  // Class plate.
  pixelBox(ctx, innerX, y + 230, innerW, 40, COLORS.raised);
  ctx.strokeStyle = COLORS.dim;
  ctx.lineWidth = 2;
  ctx.strokeRect(innerX, y + 230, innerW, 40);
  drawFitted(ctx, hero.klass, innerX + 8, y + 247, innerW - 16, {
    size: 7,
    color: rarity.color,
  });
  drawFitted(ctx, `// ${hero.sub}`, innerX + 8, y + 262, innerW - 16, {
    size: 7,
    color: COLORS.muted,
  });

  // HP / ATK / DEF.
  drawGauge(ctx, innerX, y + 290, innerW, labels.hp, hero.hp);
  drawGauge(ctx, innerX, y + 314, innerW, labels.atk, hero.atk);
  drawGauge(ctx, innerX, y + 338, innerW, labels.def, hero.def);

  // Git stats plate.
  pixelBox(ctx, innerX, y + 358, innerW, 56, COLORS.deep);
  ctx.strokeStyle = COLORS.dim;
  ctx.lineWidth = 2;
  ctx.strokeRect(innerX, y + 358, innerW, 56);
  const rows = [
    [labels.commits, labels.formatNumber(hero.commits), COLORS.ink],
    [labels.prs, labels.formatNumber(hero.prs), COLORS.ink],
    [labels.streak, `${String(hero.streak).padStart(2, "0")} ${labels.days}`, COLORS.gold],
  ];
  rows.forEach(([label, value, color], index) => {
    const rowY = y + 376 + index * 16;
    drawFitted(ctx, label, innerX + 8, rowY, innerW - 80, {
      size: 7,
      color: COLORS.muted,
    });
    drawFitted(ctx, value, x + CARD_W - 20, rowY, 90, {
      size: 8,
      color,
      align: "right",
    });
  });
}

function drawFooter(ctx, width, height, labels) {
  ctx.strokeStyle = COLORS.dim;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(PAD, height - 52);
  ctx.lineTo(width - PAD, height - 52);
  ctx.stroke();
  drawFitted(ctx, labels.footer, PAD, height - 28, width - PAD * 2 - 120, {
    size: 8,
    color: COLORS.muted,
  });
  drawFitted(ctx, "REPO TALES // AMD MI300X", width - PAD, height - 28, 180, {
    size: 8,
    color: COLORS.green,
    align: "right",
  });
}

function renderSheet(heroes, guild, labels, sprites) {
  const rows = Math.max(1, Math.ceil(heroes.length / COLS));
  const width = PAD * 2 + COLS * CARD_W + (COLS - 1) * GAP;
  const height = 168 + rows * CARD_H + (rows - 1) * GAP + 92;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");

  drawFrame(ctx, width, height);
  drawHeader(ctx, guild?.name ?? "@GUILD", labels);

  heroes.forEach((hero, index) => {
    const col = index % COLS;
    const row = Math.floor(index / COLS);
    const x = PAD + col * (CARD_W + GAP);
    const y = 168 + row * (CARD_H + GAP);
    drawCard(ctx, hero, x, y, sprites[index], labels);
  });

  drawFooter(ctx, width, height, labels);
  return canvas;
}

function canvasToBlob(canvas) {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), "image/png");
    } catch {
      // Tainted canvas (a cross-origin portrait without CORS): the caller
      // retries with zero images, which always produces a clean sheet.
      resolve(null);
    }
  });
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/**
 * @param {{
 *   heroes: Array<Record<string, any>>,
 *   guild?: { name?: string } | null,
 *   labels: Record<string, string | ((...args: any[]) => string)>,
 *   locale?: string,
 *   filename?: string,
 * }} options
 * @returns {Promise<string>} the downloaded filename
 */
export async function exportSquadCards({
  heroes,
  guild,
  labels,
  locale = "en-US",
  filename,
}) {
  if (!heroes?.length) throw new Error("No heroes to export");
  if (typeof document === "undefined") throw new Error("Export requires a browser");

  if (document.fonts?.ready) {
    try {
      await document.fonts.ready;
    } catch {
      // Font loading is best-effort; the monospace fallbacks still render.
    }
  }

  const numberFormatter = new Intl.NumberFormat(locale);
  const date = new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date());

  const resolved = {
    ...labels,
    formatNumber: (value) => numberFormatter.format(Number(value) || 0),
    footer: fill(labels.footer ?? "REPO TALES // {date}", { date }),
  };

  const sprites = await Promise.all(heroes.map((hero) => loadSprite(hero.sprite)));
  let canvas = renderSheet(heroes, guild, resolved, sprites);
  let blob = await canvasToBlob(canvas);

  if (!blob) {
    // The portraits tainted the canvas: re-render with placeholders rather
    // than failing the export outright.
    canvas = renderSheet(heroes, guild, resolved, heroes.map(() => null));
    blob = await canvasToBlob(canvas);
  }
  if (!blob) throw new Error("Could not encode the team sheet");

  const safeGuild = String(guild?.name ?? "guild")
    .replace(/^@/, "")
    .replace(/[^\w-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  const name =
    filename ||
    `repotales-squad-${safeGuild || "guild"}-${new Date()
      .toISOString()
      .slice(0, 10)}.png`;

  download(blob, name);
  return name;
}
