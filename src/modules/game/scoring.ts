import { GameRole } from './game-role.enum.js';

export const ROLE_SCORES: Record<GameRole, number> = {
  [GameRole.RAJA]: 1000,
  [GameRole.POLICE]: 800,
  [GameRole.CHOR]: 500,
  [GameRole.DAKAT]: 400,
  [GameRole.JHARUDAR]: 200,
  [GameRole.CLEANER]: 200,
  [GameRole.PAGOL]: 50,
  [GameRole.CHAGOL]: 100,
};
