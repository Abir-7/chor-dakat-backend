import { Injectable, Logger } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import type { Server } from 'socket.io';

import { GameService } from './game.service.js';
import { GamePhase } from './game.types.js';
import { GameRole } from './game-role.enum.js';
import { ALLOWED_REACTIONS } from '../chat/reactions.js';

/**
 * The gateway turns these callbacks into the same service calls + socket
 * emissions that a real player's socket message would trigger, so a bot
 * action lands in the room exactly like a human action.
 */
export interface BotActionHandlers {
  pickPaper: (roomCode: string, playerId: string, paperId: string) => void;
  selectTarget: (
    roomCode: string,
    playerId: string,
    targetRole: GameRole.CHOR | GameRole.DAKAT,
  ) => void;
  guessPlayer: (
    roomCode: string,
    playerId: string,
    selectedPlayerId: string,
  ) => void;
}

/** Bots take their turn after this "thinking" window. */
const BOT_THINK_MS = 1200;
/** Extra random thinking time so several bots never act identically. */
const BOT_THINK_JITTER_MS = 2200;
/** Per-bot stagger so bots rarely pick in the same instant. */
const BOT_STAGGER_MS = 400;
/** Babu and the Police "think" like a human decision: 7-10 seconds. */
const BOT_DECIDE_MIN_MS = 7000;
const BOT_DECIDE_MAX_MS = 10000;

const TOTAL_REACTION_CHANCE = 0.45;
const REACTION_EXTRA_MS = 2400;

const CAUGHT_REACTIONS = ['😭', '😱', '😂', '👀'];
const MISSED_REACTIONS = ['🔥', '😂', '👍', '🤝'];

interface BotReaction {
  senderId: string;
  senderName: string;
  reaction: string;
  timestamp: string;
}

@Injectable()
export class BotService {
  private readonly logger = new Logger(BotService.name);

  private server?: Server;
  private handlers?: BotActionHandlers;

  constructor(
    private readonly gameService: GameService,
  ) {
    // GameService owns all game state; bot turns are scheduled against it.
  }

  /** roomCode -> live bot timers, so a room's pending turns can be cleared. */
  private readonly roomTimers = new Map<string, Set<NodeJS.Timeout>>();
  /** Dedupes scheduled bot actions across re-runs of the scheduler. */
  private readonly scheduledActions = new Map<string, Set<string>>();

  setServer(server: Server): void {
    this.server = server;
  }

  setHandlers(handlers: BotActionHandlers): void {
    this.handlers = handlers;
  }

  /** Called when a fresh round/match starts: reset timers, kick bot turns off. */
  onRoundStarted(roomCode: string): void {
    this.clearTimers(roomCode);
    this.scheduleTurns(roomCode);
    this.scheduleRoundStartReaction(roomCode);
  }

  /**
   * Re-evaluates pending bot actions. Idempotent: call after every state
   * change (human or bot) so newly opened phases get bot turns scheduled.
   */
  onGameStateAdvanced(roomCode: string): void {
    this.scheduleTurns(roomCode);
  }

  /**
   * Called right after a round result (or match end) is broadcast: bots chip
   * in with an emotional reaction, like players do after a catch or a miss.
   */
  onRoundEnded(
    roomCode: string,
    caught: boolean,
    reactionChancePercent = 30,
  ): void {
    const game = this.gameService.getGameState(roomCode);

    if (!game) {
      return;
    }

    const bots = game.players.filter((player) => player.isBot);

    for (const bot of bots) {
      if (randomInt(100) >= reactionChancePercent) {
        continue;
      }

      const pool = caught ? CAUGHT_REACTIONS : MISSED_REACTIONS;

      this.scheduleTimer(
        roomCode,
        `reaction:${bot.id}:round-end`,
        800 + randomInt(REACTION_EXTRA_MS),
        () => this.emitReaction(roomCode, bot.id, pool),
      );
    }
  }

  /** Cancels every pending bot timer for a room (abort, lobby, room empty). */
  clearTimers(roomCode: string): void {
    const timers = this.roomTimers.get(roomCode);

    if (timers) {
      for (const timer of timers) {
        clearTimeout(timer);
      }
      this.roomTimers.delete(roomCode);
    }

    this.scheduledActions.delete(roomCode);
  }

  /**
   * Walks the current game state and schedules any action a bot still owes:
   * picking a paper (PICKING), Babu's target pick (ROLE_REVEAL) and the
   * Police arrest (GUESSING).
   */
  private scheduleTurns(roomCode: string): void {
    const game = this.gameService.getGameState(roomCode);

    if (!game) {
      this.clearTimers(roomCode);
      return;
    }

    if (game.phase === GamePhase.PICKING) {
      let staggerIndex = 0;

      for (const bot of game.players) {
        if (!bot.isBot || bot.hasPicked) {
          continue;
        }

        this.scheduleTimer(
          roomCode,
          `pick:${bot.id}`,
          this.botDelay(staggerIndex),
          () => this.runBotPick(roomCode, bot.id),
        );

        staggerIndex += 1;
      }
    }

    if (game.phase === GamePhase.ROLE_REVEAL) {
      const raja = game.players.find(
        (player) => player.role === GameRole.RAJA,
      );

      if (raja?.isBot && !game.targetRole) {
        this.scheduleTimer(
          roomCode,
          `target:${raja.id}`,
          this.decideDelay(),
          () => this.runBotSelectTarget(roomCode, raja.id),
        );
      }
    }

    if (game.phase === GamePhase.GUESSING) {
      const police = game.players.find(
        (player) => player.role === GameRole.POLICE,
      );

      if (police?.isBot && !game.selectedPlayerId) {
        this.scheduleTimer(
          roomCode,
          `guess:${police.id}`,
          this.decideDelay(),
          () => this.runBotGuess(roomCode, police.id),
        );
      }
    }
  }

  private botDelay(staggerIndex: number): number {
    return (
      BOT_THINK_MS +
      randomInt(BOT_THINK_JITTER_MS) +
      (staggerIndex > 0 ? staggerIndex * BOT_STAGGER_MS : 0)
    );
  }

  /** Babu's command and the Police arrest land somewhere in a 7-10s window. */
  private decideDelay(): number {
    return BOT_DECIDE_MIN_MS + randomInt(BOT_DECIDE_MAX_MS - BOT_DECIDE_MIN_MS);
  }

  private runBotPick(roomCode: string, botId: string): void {
    const game = this.gameService.getGameState(roomCode);

    if (!game || game.phase !== GamePhase.PICKING) {
      return;
    }

    const bot = game.players.find(
      (player) => player.id === botId && player.isBot && !player.hasPicked,
    );

    if (!bot) {
      return;
    }

    const availablePapers = game.papers.filter((paper) => !paper.selectedBy);

    if (availablePapers.length === 0) {
      return;
    }

    const paper = availablePapers[randomInt(availablePapers.length)];

    try {
      this.handlers?.pickPaper(roomCode, botId, paper.id);
      this.maybeReactAfterAction(roomCode, botId);
    } catch (error) {
      this.logBotFailure(roomCode, 'pick a paper', error);
    }
  }

  private runBotSelectTarget(roomCode: string, botId: string): void {
    const game = this.gameService.getGameState(roomCode);

    if (!game || game.phase !== GamePhase.ROLE_REVEAL || game.targetRole) {
      return;
    }

    // Babu cannot know which suspect holds which role: a fair 50/50 call.
    const targetRole = randomInt(2) === 0 ? GameRole.CHOR : GameRole.DAKAT;

    try {
      this.handlers?.selectTarget(roomCode, botId, targetRole);
      this.maybeReactAfterAction(roomCode, botId);
    } catch (error) {
      this.logBotFailure(roomCode, 'select a target', error);
    }
  }

  private runBotGuess(roomCode: string, botId: string): void {
    const game = this.gameService.getGameState(roomCode);

    if (!game || game.phase !== GamePhase.GUESSING || game.selectedPlayerId) {
      return;
    }

    // The Police only ever sees the two masked suspects: pick one at random.
    const suspects = game.players.filter(
      (player) => player.role === GameRole.CHOR || player.role === GameRole.DAKAT,
    );

    if (suspects.length === 0) {
      return;
    }

    const suspect = suspects[randomInt(suspects.length)];

    try {
      this.handlers?.guessPlayer(roomCode, botId, suspect.id);
    } catch (error) {
      this.logBotFailure(roomCode, 'make an arrest', error);
    }
  }

  private maybeReactAfterAction(roomCode: string, botId: string): void {
    this.scheduleBotReaction(roomCode, botId, TOTAL_REACTION_CHANCE);
  }

  private scheduleRoundStartReaction(roomCode: string): void {
    this.scheduleBotReaction(roomCode, undefined, 0.6);
  }

  /**
   * Chance-based: one bot in the room sends a floating reaction after a
   * short delay, mirroring the chat gateway's `chat:reaction` payload.
   */
  private scheduleBotReaction(
    roomCode: string,
    botId: string | undefined,
    chance: number,
  ): void {
    if (!this.server) {
      return;
    }

    const game = this.gameService.getGameState(roomCode);

    if (!game) {
      return;
    }

    const bots = game.players.filter((player) => player.isBot);

    if (bots.length === 0) {
      return;
    }

    if (randomInt(100) >= Math.round(chance * 100)) {
      return;
    }

    let botIdToUse = botId;

    if (!botIdToUse) {
      botIdToUse = bots[randomInt(bots.length)].id;
    } else {
      // The acting bot is gone (or never was a bot): fall back or skip quietly.
      const botExists = bots.some((bot) => bot.id === botIdToUse);

      if (!botExists) {
        botIdToUse = bots[randomInt(bots.length)].id;
      }
    }

    this.scheduleTimer(
      roomCode,
      `reaction:${botIdToUse}:${Date.now()}`,
      800 + randomInt(REACTION_EXTRA_MS),
      () => this.emitReaction(roomCode, botIdToUse!, [...ALLOWED_REACTIONS]),
    );
  }

  private emitReaction(roomCode: string, botId: string, pool: string[]): void {
    if (!this.server) {
      return;
    }

    const game = this.gameService.getGameState(roomCode);
    const bot = game?.players.find(
      (player) => player.id === botId && player.isBot,
    );

    if (!bot) {
      return;
    }

    const payload: BotReaction = {
      senderId: bot.id,
      senderName: bot.name,
      reaction: pool[randomInt(pool.length)],
      timestamp: new Date().toISOString(),
    };

    this.server.to(roomCode).emit('chat:reaction', payload);
  }

  private scheduleTimer(
    roomCode: string,
    action: string,
    delayMs: number,
    callback: () => void,
  ): void {
    const key = `${roomCode}:${action}`;

    let roomKeys = this.scheduledActions.get(roomCode);

    if (!roomKeys) {
      roomKeys = new Set<string>();
      this.scheduledActions.set(roomCode, roomKeys);
    }

    if (roomKeys.has(key)) {
      return;
    }

    roomKeys.add(key);

    let timers = this.roomTimers.get(roomCode);

    if (!timers) {
      timers = new Set<NodeJS.Timeout>();
      this.roomTimers.set(roomCode, timers);
    }

    const timer = setTimeout(() => {
      roomKeys!.delete(key);
      timers!.delete(timer);
      callback();
    }, delayMs);

    // Never keep the process alive just for a bot turn.
    timer.unref?.();

    timers.add(timer);
  }

  private logBotFailure(roomCode: string, action: string, error: unknown): void {
    this.logger.warn(
      `Bot in room ${roomCode} failed to ${action}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
