import { GameRole } from './game-role.enum.js';

export enum GamePhase {
  WAITING = 'WAITING',
  PICKING = 'PICKING',
  ROLE_REVEAL = 'ROLE_REVEAL',
  GUESSING = 'GUESSING',
  ROUND_RESULT = 'ROUND_RESULT',
  GAME_OVER = 'GAME_OVER',
}

export interface GameSettings {
  targetScore?: number; // e.g. 3000 points to win
  maxRounds?: number; // e.g. 5 rounds match
}

export interface GamePlayer {
  id: string;
  name: string;
  role?: GameRole;
  hasPicked: boolean;
  score: number; // Total score across all rounds
  roundScore: number; // Score earned in the current round
  /** True when this seat is a server-side bot acting on timers. */
  isBot?: boolean;
}

export interface GamePaper {
  id: string;
  role: GameRole;
  /** Identity icon pinned to this exact paper for the whole round. */
  icon: string;
  selectedBy?: string;
}

/** Points each player earned in a single finished round. */
export interface RoundRecord {
  roundNumber: number;
  scores: { playerId: string; points: number }[];
}

export interface GameState {
  hostId: string;
  roomCode: string;
  phase: GamePhase;
  players: GamePlayer[];
  papers: GamePaper[];
  targetRole?: GameRole.CHOR | GameRole.DAKAT;
  selectedPlayerId?: string;
  roundNumber: number;
  history: RoundRecord[];
  nextRoundAllowedPlayerId?: string;
  settings?: GameSettings;
  winnerPlayerId?: string;
}

export type StartGamePlayer = Pick<GamePlayer, 'id' | 'name'> &
  Partial<Pick<GamePlayer, 'score' | 'isBot'>>;

export interface AllowNextRoundPayload {
  playerId: string;
}
