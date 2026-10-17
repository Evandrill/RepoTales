/**
 * Mirror of `backend/models/saga.py`.
 *
 * These are the only shapes the API ever returns. When the Pydantic models
 * change, this file changes with them — there is no generator, so a
 * drift here is a real bug and TypeScript is the thing that catches it.
 */

export type Emotion =
  | 'neutral'
  | 'joyful'
  | 'determined'
  | 'angry'
  | 'sad'
  | 'anxious'
  | 'shocked'

export type BubbleStyle =
  | 'speech'
  | 'shout'
  | 'whisper'
  | 'thought'
  | 'narration'

export type ShotType =
  | 'wide'
  | 'medium'
  | 'close_up'
  | 'extreme_close_up'

export type PoseType =
  | 'idle'
  | 'typing_furious'
  | 'pointing'
  | 'head_in_hands'
  | 'victory'
  | 'shocked'

export type ReadingDirection = 'ltr' | 'rtl'

/** Speaker id used for caption boxes; never a real character. */
export const NARRATOR_ID = 'narrator'

export interface DialogueBubble {
  speaker_id: string
  text: string
  emotion: Emotion
  bubble_style: BubbleStyle
}

export interface Panel {
  scene: string
  shot: ShotType
  pose: PoseType
  emotion: Emotion
  bubbles: DialogueBubble[]
  /** Server-owned FLUX illustration served by /api/image-proxy. */
  image_url: string | null
}

export interface Chapter {
  index: number
  title: string
  summary: string
  panels: Panel[]
}

export interface BossFight {
  name: string
  description: string
  stakes: string
  phases: string[]
  outcome: string
  panels: Panel[]
  /** Server-owned FLUX portrait served by /api/image-proxy. */
  sprite_url: string | null
}

export interface Character {
  character_id: string
  name: string
  role: string
  rpg_class: string
  level: number
  /** Server-owned Git metrics (filled after validation). */
  commits: number
  prs: number
  streak: number
  is_bot: boolean
  /** Server-owned FLUX portrait served by /api/image-proxy. */
  avatar_url: string | null
}

export interface Hero extends Character {
  stats: Record<string, number>
  catchphrase: string | null
}

export interface SagaPayload {
  title: string
  synopsis: string
  reading_direction: ReadingDirection
  hero: Hero
  characters: Character[]
  chapters: Chapter[]
  boss_fight: BossFight
  /** Repairs and inconsistencies the backend found while validating. */
  warnings: string[]
}

export interface GenerateRequest {
  repo_url: string
  limit?: number
  /** Language used for every generated string (titles, bubbles, boss). */
  language?: 'en' | 'fr'
}
