import { describe, it, expect, beforeEach } from 'vitest';
import { GameService } from './game.service.js';
import { GameRole } from './game-role.enum.js';
import { GamePhase } from './game.types.js';

describe('GameService', () => {
  let service: GameService;

  beforeEach(() => {
    service = new GameService();
  });

  const createPlayers = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      id: `player-${i + 1}`,
      name: `Player ${i + 1}`,
    }));

  it('should start game with valid 5 players and setup picking phase', () => {
    const players = createPlayers(5);
    const gameState = service.startGame('123456', 'player-1', players);

    expect(gameState.roomCode).toBe('123456');
    expect(gameState.phase).toBe(GamePhase.PICKING);
    expect(gameState.players).toHaveLength(5);
    expect(gameState.papers).toHaveLength(5);
    expect(gameState.roundNumber).toBe(1);
  });

  it('should reject starting with fewer than 5 players', () => {
    const players = createPlayers(4);
    expect(() => service.startGame('123456', 'player-1', players)).toThrow(
      /At least 5 players are required/,
    );
  });

  it('should allow players to pick papers and transition to ROLE_REVEAL when all have picked', () => {
    const players = createPlayers(5);
    const game = service.startGame('123456', 'player-1', players);

    // Pick 4 papers
    for (let i = 0; i < 4; i++) {
      service.pickPaper('123456', players[i].id, game.papers[i].id);
      expect(game.phase).toBe(GamePhase.PICKING);
    }

    // Pick 5th paper
    service.pickPaper('123456', players[4].id, game.papers[4].id);
    expect(game.phase).toBe(GamePhase.ROLE_REVEAL);
  });

  it('should auto-pick remaining papers if timer expires', () => {
    const players = createPlayers(5);
    const game = service.startGame('123456', 'player-1', players);

    // Only 2 players pick
    service.pickPaper('123456', players[0].id, game.papers[0].id);
    service.pickPaper('123456', players[1].id, game.papers[1].id);

    // Auto-pick remaining
    service.autoPickRemainingPapers('123456');

    expect(game.phase).toBe(GamePhase.ROLE_REVEAL);
    expect(game.players.every((p) => p.hasPicked && p.role)).toBe(true);
  });

  it('should correctly score when Police guesses correctly', () => {
    const players = createPlayers(5);
    const game = service.startGame('123456', 'player-1', players);
    service.autoPickRemainingPapers('123456');

    const raja = game.players.find((p) => p.role === GameRole.RAJA)!;
    const police = game.players.find((p) => p.role === GameRole.POLICE)!;
    const chor = game.players.find((p) => p.role === GameRole.CHOR)!;

    // Raja selects target CHOR
    service.selectTarget('123456', raja.id, GameRole.CHOR);
    expect(game.phase).toBe(GamePhase.GUESSING);

    // Police correctly guesses Chor
    service.guessPlayer('123456', police.id, chor.id);

    expect(game.phase).toBe(GamePhase.ROUND_RESULT);
    expect(police.roundScore).toBe(800);
    expect(police.score).toBe(800);
    expect(chor.roundScore).toBe(0); // Caught thief gets 0
    expect(chor.score).toBe(0);
    expect(raja.roundScore).toBe(1000);
  });

  it('should correctly score when Police guesses wrong', () => {
    const players = createPlayers(5);
    const game = service.startGame('123456', 'player-1', players);
    service.autoPickRemainingPapers('123456');

    const raja = game.players.find((p) => p.role === GameRole.RAJA)!;
    const police = game.players.find((p) => p.role === GameRole.POLICE)!;
    const chor = game.players.find((p) => p.role === GameRole.CHOR)!;
    const dakat = game.players.find((p) => p.role === GameRole.DAKAT)!;

    // Raja selects target CHOR
    service.selectTarget('123456', raja.id, GameRole.CHOR);

    // Police guesses Dakat instead of Chor
    service.guessPlayer('123456', police.id, dakat.id);

    expect(game.phase).toBe(GamePhase.ROUND_RESULT);
    expect(police.roundScore).toBe(0); // Police failed
    expect(police.score).toBe(0);
    expect(chor.roundScore).toBe(500); // Chor escaped
    expect(chor.score).toBe(500);
    expect(dakat.roundScore).toBe(400); // Dakat gets normal score
  });

  it('should reshuffle papers every round so the same player is not always Chor/Dakat', () => {
    // Simulates the perception bug: a player who always grabs the same
    // paper slot (e.g. their favourite icon position) must still end up
    // with varied roles across rounds, not always Chor/Dakat.
    const players = createPlayers(5);
    const roleCounts: Partial<Record<GameRole, number>> = {};

    for (let round = 0; round < 500; round++) {
      service.removeGame('123456');
      const game = service.startGame('123456', 'player-1', players);
      // Player-1 always picks the first displayed paper.
      service.pickPaper('123456', 'player-1', game.papers[0].id);
      service.autoPickRemainingPapers('123456');

      const myRole = game.players[0].role;
      roleCounts[myRole] = (roleCounts[myRole] ?? 0) + 1;

      const chor = game.players.find((p) => p.role === GameRole.CHOR)!;
      const dakat = game.players.find((p) => p.role === GameRole.DAKAT)!;
      expect(chor).toBeDefined();
      expect(dakat).toBeDefined();
      expect(chor.id).not.toBe(dakat.id);
    }

    // Expected ~100 occurrences per role over 500 rounds. A biased shuffle
    // (e.g. always landing on the same role) would blow far past these bounds.
    for (const role of [
      GameRole.RAJA,
      GameRole.POLICE,
      GameRole.CHOR,
      GameRole.DAKAT,
      GameRole.JHARUDAR,
    ]) {
      expect(roleCounts[role]).toBeGreaterThan(40);
      expect(roleCounts[role]).toBeLessThan(160);
    }
  });

  it('should trigger GAME_OVER when maxRounds condition is met', () => {
    const players = createPlayers(5);
    const game = service.startGame('123456', 'player-1', players, {
      maxRounds: 1,
    });
    service.autoPickRemainingPapers('123456');

    const raja = game.players.find((p) => p.role === GameRole.RAJA)!;
    const police = game.players.find((p) => p.role === GameRole.POLICE)!;
    const chor = game.players.find((p) => p.role === GameRole.CHOR)!;

    service.selectTarget('123456', raja.id, GameRole.CHOR);
    service.guessPlayer('123456', police.id, chor.id);

    expect(game.phase).toBe(GamePhase.GAME_OVER);
    expect(game.winnerPlayerId).toBe(raja.id); // Raja has highest score (1000)
  });
});
