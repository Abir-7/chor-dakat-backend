import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'socket.io';

import { BotService } from './bots.service.js';
import { GameService } from './game.service.js';
import { GamePhase } from './game.types.js';
import { GameRole } from './game-role.enum.js';
import { RoomsService } from '../rooms/rooms.service.js';
import { ALLOWED_REACTIONS } from '../chat/reactions.js';

type BotHandlers = Parameters<BotService['setHandlers']>[0];

describe('BotService', () => {
  let roomsService: RoomsService;
  let gameService: GameService;
  let botService: BotService;
  let ctx: ReturnType<typeof createRoomOnce>;

  beforeEach(() => {
    vi.useFakeTimers();
    roomsService = new RoomsService();
    gameService = new GameService();
    botService = new BotService(gameService);
    ctx = createRoomOnce();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createRoomOnce() {
    const created = roomsService.createRoom('Host');

    for (let i = 0; i < 3; i++) {
      roomsService.addBotPlayer(created.room.code, created.player.id);
    }

    const room = roomsService.getRoom(created.room.code);
    const players = room.players.map((player) => ({
      id: player.id,
      name: player.name,
      isBot: player.isBot,
    }));

    return {
      roomCode: created.room.code,
      hostId: created.player.id,
      players,
    };
  }

  function wireHandlers() {
    const pickPaper = vi.fn(
      (...args: Parameters<BotHandlers['pickPaper']>) =>
        gameService.pickPaper(...args),
    );
    const selectTarget = vi.fn(
      (...args: Parameters<BotHandlers['selectTarget']>) =>
        gameService.selectTarget(...args),
    );
    const guessPlayer = vi.fn(
      (...args: Parameters<BotHandlers['guessPlayer']>) =>
        gameService.guessPlayer(...args),
    );

    botService.setHandlers({ pickPaper, selectTarget, guessPlayer });

    return { pickPaper, selectTarget, guessPlayer };
  }

  /** Lets every pending bot timer fire, pumping the scheduler in waves. */
  function advanceBots() {
    for (let i = 0; i < 15 && vi.getTimerCount() > 0; i++) {
      vi.advanceTimersByTime(6000);
    }
  }

  it('bots pick their papers on their own while real players keep picking', () => {
    const { roomCode, hostId, players } = ctx;
    const gameState = gameService.startGame(roomCode, hostId, players);
    const { pickPaper } = wireHandlers();

    expect(gameState.phase).toBe(GamePhase.PICKING);

    botService.onRoundStarted(roomCode);
    advanceBots();

    const bots = gameState.players.filter((p) => p.isBot);

    expect(bots).toHaveLength(3);
    for (const bot of bots) {
      expect(bot.hasPicked).toBe(true);
      expect(bot.role).toBeDefined();
    }
    expect(pickPaper).toHaveBeenCalledTimes(3);

    // The host (a human) still has to pick their own slip.
    expect(gameState.players.find((p) => p.id === hostId)?.hasPicked).toBe(
      false,
    );
    expect(gameState.phase).toBe(GamePhase.PICKING);

    const unpickedPaper = gameState.papers.find(
      (paper) => !paper.selectedBy,
    )!;
    gameService.pickPaper(roomCode, hostId, unpickedPaper.id);

    expect(gameState.phase).toBe(GamePhase.ROLE_REVEAL);
  });

  it('does not schedule the same bot turn twice', () => {
    const { roomCode, hostId, players } = ctx;
    gameService.removeGame(roomCode);
    const gameState = gameService.startGame(roomCode, hostId, players);
    const { pickPaper } = wireHandlers();

    botService.onRoundStarted(roomCode);
    // Real-world callers re-run the scheduler after every state change.
    botService.onGameStateAdvanced(roomCode);
    botService.onGameStateAdvanced(roomCode);
    botService.onGameStateAdvanced(roomCode);

    advanceBots();

    expect(pickPaper).toHaveBeenCalledTimes(3);
    expect(
      gameState.players.filter((p) => p.isBot).every((p) => p.hasPicked),
    ).toBe(true);
  });

  it('drops pending bot turns when pending timers are cleared', () => {
    const { roomCode, hostId, players } = ctx;
    gameService.removeGame(roomCode);
    gameService.startGame(roomCode, hostId, players);
    const { pickPaper } = wireHandlers();

    botService.onRoundStarted(roomCode);
    botService.clearTimers(roomCode);
    advanceBots();

    expect(pickPaper).not.toHaveBeenCalled();
  });

  it('bot Babu picks the target and bot Police makes the arrest, finishing the round', () => {
    const { roomCode, hostId, players } = ctx;
    let finished = false;

    for (let attempt = 0; attempt < 80 && !finished; attempt++) {
      gameService.removeGame(roomCode);

      const gameState = gameService.startGame(roomCode, hostId, players);
      wireHandlers();

      botService.onRoundStarted(roomCode);
      advanceBots(); // bots pick their papers

      const host = gameState.players.find((p) => p.id === hostId)!;

      // If the host holds a deciding role the bot flow stalls; retry until
      // the bots hold both Babu and Police.
      if (host.role === GameRole.RAJA || host.role === GameRole.POLICE) {
        continue;
      }

      const unpickedPaper = gameState.papers.find(
        (paper) => !paper.selectedBy,
      )!;
      gameService.pickPaper(roomCode, hostId, unpickedPaper.id);

      expect(gameState.phase).toBe(GamePhase.ROLE_REVEAL);

      botService.onGameStateAdvanced(roomCode);
      advanceBots(); // bot Babu selects the target

      expect(gameState.phase).toBe(GamePhase.GUESSING);
      expect([GameRole.CHOR, GameRole.DAKAT]).toContain(gameState.targetRole);

      botService.onGameStateAdvanced(roomCode);
      advanceBots(); // bot Police arrests one of the two suspects

      expect(gameState.phase).toBe(GamePhase.ROUND_RESULT);
      expect(gameState.selectedPlayerId).toBeDefined();

      const police = gameState.players.find(
        (p) => p.role === GameRole.POLICE,
      )!;
      expect(police.isBot).toBe(true);
      expect(police.roundScore).toBeGreaterThanOrEqual(0);
      expect(gameState.history).toHaveLength(1);

      finished = true;
    }

    expect(finished).toBe(true);
  });

  it('emits chat reactions for every bot on a round result', () => {
    const { roomCode, players } = ctx;
    gameService.removeGame(roomCode);
    gameService.startGame(roomCode, ctx.hostId, players);

    const emit = vi.fn();
    botService.setServer({
      to: vi.fn(() => ({ emit })),
    } as unknown as Server);

    botService.onRoundEnded(roomCode, true, 100);

    vi.advanceTimersByTime(6000);

    const botIds = new Set(players.filter((p) => p.isBot).map((p) => p.id));
    const reactionEvents = emit.mock.calls.filter(
      ([event]) => event === 'chat:reaction',
    );

    expect(reactionEvents).toHaveLength(3);

    for (const [, payload] of reactionEvents) {
      expect(botIds.has(payload.senderId)).toBe(true);
      expect(payload.senderName).toMatch(/^Bot /);
      expect(ALLOWED_REACTIONS.has(payload.reaction)).toBe(true);
      expect(typeof payload.timestamp).toBe('string');
    }
  });
});
