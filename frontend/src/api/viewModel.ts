/**
 * Adapter: backend `SagaPayload` -> view contract used by the GLM design
 * components (SagaApp / GuildRoster / MangaReader / BossEventModal).
 *
 * The backend model stays the single source of truth (it is what the LLM
 * produces and what Pydantic validates). The design expects a flatter,
 * screen-oriented shape (`heroes`, `guild`, `chapters`, `boss.attacks[].ap`);
 * everything that would otherwise be invented by the LLM — Git counters,
 * AP costs, rarity — is derived deterministically here.
 */
import type { Chapter, Character, Panel, SagaPayload } from '../types/saga'
import { resolveAssetUrl } from './saga.ts'

export type Rarity = 'LEGENDARY' | 'EPIC' | 'RARE'
export type AttackTone = 'magenta' | 'cyan' | 'green'

export interface RosterHero {
  id: string
  name: string
  level: number
  rarity: Rarity
  klass: string
  sub: string
  hp: number
  atk: number
  def: number
  commits: number
  prs: number
  streak: number
  sprite?: string | null
}

export interface GuildInfo {
  name: string
  xp: number
  xpMax: number
  level: string
  nextTier: string
  nextTierXp: number
  nextTierMax: number
}

export interface ReaderPanel {
  span: 'wide' | 'half'
  art: string | null
  bubble?: string
  sfx?: { text: string; color: string }
  caption?: string
  terminal?: { line: string; stage: string; code: string }
}

export interface ReaderChapter {
  number: number
  title: string
  issue: string
  panels: ReaderPanel[]
  footer: { left: string; right: string }
}

export interface BossAttack {
  key: string
  ap: number
  /** Absolute HP removed from the boss on hit (proportional to maxHp). */
  damage: number
  hint: string
  tone: AttackTone
  icon: 'bolt' | 'rewind' | 'spark'
}

export interface SagaBoss {
  name: string
  level: string
  hp: number
  maxHp: number
  threat: string
  status: string
  sig: string
  attacks: BossAttack[]
  sprite?: string | null
}

export interface SagaView {
  title: string
  synopsis: string
  heroes: RosterHero[]
  guild: GuildInfo
  chapters: ReaderChapter[]
  boss: SagaBoss
}

export interface ViewOptions {
  /** "owner/repo" — used for the guild name. */
  repoPath?: string
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value))

const upper = (value: string) => value.toUpperCase()

/** Drop a leading "Chapter 3 —" / "Ch. 3:" written by the LLM or the mock. */
const stripChapterPrefix = (value: string) =>
  value.replace(/^\s*(?:chapter|ch\.?)\s*\d+\s*[—–:-]\s*/i, '').trim()

/** Drop a leading "Phase 2 —" so BossEventModal doesn't print it twice. */
const stripBossPhase = (value: string) =>
  value.replace(/^\s*phase\s*\d+\s*[—–:-]\s*/i, '').trim()

/** FNV-1a -> the 8-hex "signature" the boss screen prints. */
function hash8(value: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).toUpperCase().padStart(8, '0')
}

/** Map 1..100 stats onto the roster's 1..10 gauges (1..10 passes through). */
function gauge(
  stats: Record<string, number> | undefined,
  keys: string[],
  fallback: number,
): number {
  const values = (keys || [])
    .map((key) => stats?.[key])
    .filter((value): value is number => typeof value === 'number')
  if (values.length === 0) return fallback
  const scale = values.every((value) => value <= 10) ? 1 : 0.1
  const average = values.reduce((sum, value) => sum + value, 0) / values.length
  return clamp(Math.round(average * scale), 1, 10)
}

function rarityFor(character: Character, isHero: boolean): Rarity {
  if (isHero) return 'LEGENDARY'
  if (character.is_bot) return 'RARE'
  return character.level >= 60 ? 'EPIC' : 'RARE'
}

function levelGauge(level: number, offset = 0): number {
  return clamp(Math.round(level / 10) + offset, 1, 10)
}

function toHero(
  character: Character,
  index: number,
  isHero: boolean,
  heroStats: Record<string, number> | undefined,
): RosterHero {
  const fallback = levelGauge(character.level)
  return {
    id: String(index + 1).padStart(2, '0'),
    name: upper(character.name),
    level: character.level,
    rarity: rarityFor(character, isHero),
    klass: upper(character.rpg_class),
    sub: upper(character.role).slice(0, 28),
    hp: isHero ? gauge(heroStats, ['constitution', 'stamina', 'hp'], fallback) : fallback,
    atk: isHero
      ? gauge(heroStats, ['strength', 'intelligence', 'atk'], fallback)
      : clamp(fallback + (index % 2), 1, 10),
    def: isHero
      ? gauge(heroStats, ['constitution', 'wisdom', 'defense'], fallback)
      : clamp(fallback - (index % 2), 1, 10),
    commits: character.commits ?? 0,
    prs: character.prs ?? 0,
    streak: character.streak ?? 0,
    sprite: resolveAssetUrl(character.avatar_url),
  }
}

/* ── SFX: the design puts a shout on every panel; derive it from the pose. ── */
const SFX_BY_POSE: Record<string, { text: string; color: string }> = {
  typing_furious: { text: 'TYPE!!', color: 'text-neon-green' },
  pointing: { text: 'GO!', color: 'text-neon-magenta' },
  head_in_hands: { text: 'NO!!', color: 'text-alert' },
  victory: { text: 'WIN!', color: 'text-neon-green' },
  shocked: { text: '!!', color: 'text-alert' },
}

const SFX_BY_EMOTION: Record<string, { text: string; color: string }> = {
  angry: { text: 'ARGH!', color: 'text-alert' },
  shocked: { text: '!!', color: 'text-alert' },
  joyful: { text: 'GG!', color: 'text-neon-green' },
  determined: { text: 'GO!', color: 'text-neon-cyan' },
}

function bubbleFor(panel: Panel): string | undefined {
  const bubble = panel.bubbles.find((item) => item.text?.trim())
  return bubble ? `« ${bubble.text.trim()} »` : undefined
}

function toReaderPanel(panel: Panel, index: number): ReaderPanel {
  const sfx = SFX_BY_POSE[panel.pose] ?? SFX_BY_EMOTION[panel.emotion]
  const caption = panel.scene.trim().slice(0, 96)
  const isFailure = /error|fail|bug|crash|panic|conflict|broken|outage/i.test(
    panel.scene,
  )

  return {
    span: index === 0 ? 'wide' : 'half',
    art: resolveAssetUrl(panel.image_url),
    bubble: bubbleFor(panel),
    sfx: sfx ? { ...sfx } : undefined,
    caption: caption ? `[${upper(caption)}]` : undefined,
    terminal: isFailure
      ? {
          line: `> ${panel.scene.trim().slice(0, 90)}`,
          stage: `STAGE: ${upper(panel.pose).replace(/_/g, ' ')}`,
          code: `SHOT: ${upper(panel.shot).replace(/_/g, ' ')}`,
        }
      : undefined,
  }
}

function toReaderChapter(chapter: Chapter): ReaderChapter {
  const issue = `#${String(chapter.index).padStart(2, '0')}`
  return {
    number: chapter.index,
    // MangaReader prefixes "CH.{n} —" itself; the mock payload already says
    // "Chapter 1 — …", which would otherwise render the number twice.
    title: upper(stripChapterPrefix(chapter.title)),
    issue,
    panels: chapter.panels.map(toReaderPanel),
    footer: {
      left: `REPO TALES SAGA // ISSUE ${issue} // SHONEN JUMP COMPILER`,
      right: `[${upper(chapter.summary).slice(0, 48)}]`,
    },
  }
}

/**
 * Canonical move names. The LLM's phase prose is great as a *hint*, but as a
 * button label it gets truncated mid-word ("THE ALERT STORM PA") and breaks
 * the layout. Fixed names keep the buttons readable in EN and FR; the phase
 * text stays visible underneath. Damages are fractions of the boss max HP so
 * every saga lasts roughly 4–6 hits whatever its chapter count.
 */
const MOVE_TEMPLATES: Array<{
  key: string
  ap: number
  ratio: number
  tone: AttackTone
  icon: BossAttack['icon']
}> = [
  { key: 'FORCE PUSH', ap: 2, ratio: 0.32, tone: 'magenta', icon: 'bolt' },
  { key: 'ROLLBACK', ap: 1, ratio: 0.16, tone: 'cyan', icon: 'rewind' },
  { key: 'REFACTOR', ap: 2, ratio: 0.24, tone: 'green', icon: 'spark' },
]

function toAttacks(saga: SagaPayload, maxHp: number): BossAttack[] {
  const phases = saga.boss_fight.phases
    .filter((phase) => phase?.trim())
    .map(stripBossPhase)

  const moves = MOVE_TEMPLATES.map((template, index) => {
    const label = upper(phases[index] ?? '').trim()
    return {
      key: template.key,
      ap: template.ap,
      damage: Math.max(1, Math.round(maxHp * template.ratio)),
      hint: label ? `PHASE ${index + 1} — ${label.slice(0, 34)}` : `PHASE ${index + 1}`,
      tone: template.tone,
      icon: template.icon,
    }
  })

  return moves
}

export function buildSagaView(saga: SagaPayload, options: ViewOptions = {}): SagaView {
  const cast: Character[] = [
    // `characters` already contains a coerced copy of the hero (backend heal),
    // but keep this defensive for older payloads. The narrator is a dialogue
    // device, not a guild member, so it never gets a roster card.
    ...saga.characters.filter(
      (c) => c.character_id !== saga.hero.character_id && c.character_id !== 'narrator',
    ),
  ]
  const ordered: Character[] = [
    { ...saga.hero } as Character,
    ...cast,
  ]

  const heroes = ordered.map((character, index) =>
    toHero(character, index, character.character_id === saga.hero.character_id, saga.hero.stats),
  )

  const totalCommits = heroes.reduce((sum, hero) => sum + hero.commits, 0)
  const heroLevel = saga.hero.level
  const xp = totalCommits * 25 + heroLevel * 100
  const xpMax = xp + 1500 + saga.chapters.length * 250
  const lastChapter = saga.chapters[saga.chapters.length - 1]

  const repoName = options.repoPath
    ? `@${options.repoPath.split('/').slice(0, 2).join('-').toUpperCase()}`
    : '@OCTO-SQUAD'

  const maxHp = 5000 + saga.chapters.length * 1000
  const bossName = saga.boss_fight.name

  return {
    title: saga.title,
    synopsis: saga.synopsis,
    heroes,
    guild: {
      name: repoName,
      xp,
      xpMax,
      level: `LV.${saga.chapters.length} SAGA`,
      nextTier: upper(stripChapterPrefix(lastChapter?.title ?? 'NEXT ARC')),
      nextTierXp: Math.round(xp % 1500),
      nextTierMax: 1500,
    },
    chapters: saga.chapters.map(toReaderChapter),
    boss: {
      name: upper(bossName),
      level: `LEVEL ${clamp(heroLevel + 10, 1, 99)} — FINAL BUG`,
      hp: maxHp,
      maxHp,
      threat:
        saga.chapters.length >= 6
          ? 'CATACLYSMIC'
          : saga.chapters.length >= 4
            ? 'SEVERE'
            : 'MODERATE',
      status: `[${upper(saga.boss_fight.stakes).slice(0, 64)}]`,
      sig: `0x${hash8(bossName)}`,
      attacks: toAttacks(saga, maxHp),
      sprite: resolveAssetUrl(saga.boss_fight.sprite_url),
    },
  }
}
