import { BadRequestException, Injectable } from '@nestjs/common';
import { randomInt, randomUUID } from 'node:crypto';
import { GameRole } from './game-role.enum.js';
import {
  GamePaper,
  GamePhase,
  GamePlayer,
  GameSettings,
  GameState,
  RoundRecord,
  StartGamePlayer,
} from './game.types.js';
import { ROLE_SCORES } from './scoring.js';

@Injectable()
export class GameService {
  private readonly minPlayers = 4;
  private readonly maxPlayers = 8;

  private readonly gameStates = new Map<string, GameState>();

  /** Fun identity icons — one is permanently assigned to each paper slip. */
  private readonly paperIconPool: string[] = [
    '🐴',
    '🍬',
    '🎈',
    '🍕',
    '⚓',
    '🌵',
    '🌮',
    '🧸',
  ];

  private readonly roleDistribution: Record<number, GameRole[]> = {
    4: [
      GameRole.RAJA,
      GameRole.POLICE,
      GameRole.CHOR,
      GameRole.DAKAT,
    ],
    5: [
      GameRole.RAJA,
      GameRole.POLICE,
      GameRole.CHOR,
      GameRole.DAKAT,
      GameRole.JHARUDAR,
    ],
    6: [
      GameRole.RAJA,
      GameRole.POLICE,
      GameRole.CHOR,
      GameRole.DAKAT,
      GameRole.JHARUDAR,
      GameRole.CLEANER,
    ],
    7: [
      GameRole.RAJA,
      GameRole.POLICE,
      GameRole.CHOR,
      GameRole.DAKAT,
      GameRole.JHARUDAR,
      GameRole.CLEANER,
      GameRole.PAGOL,
    ],
    8: [
      GameRole.RAJA,
      GameRole.POLICE,
      GameRole.CHOR,
      GameRole.DAKAT,
      GameRole.JHARUDAR,
      GameRole.CLEANER,
      GameRole.PAGOL,
      GameRole.CHAGOL,
    ],
  };

  startGame(
    roomCode: string,
    hostId: string,
    roomPlayers: StartGamePlayer[],
    settings?: GameSettings,
  ): GameState {
    const playerCount = roomPlayers.length;

    // Validate player count.
    if (playerCount < this.minPlayers) {
      throw new BadRequestException(
        `At least ${this.minPlayers} players are required to start the game.`,
      );
    }

    if (playerCount > this.maxPlayers) {
      throw new BadRequestException(
        `Maximum ${this.maxPlayers} players are allowed.`,
      );
    }

    // Validate host.
    const host = roomPlayers.find((player) => player.id === hostId);

    if (!host) {
      throw new BadRequestException('The host must be part of the game.');
    }

    if (typeof roomCode !== 'string' || !/^\d{6}$/.test(roomCode)) {
      throw new BadRequestException('Invalid room code.');
    }

    if (!Array.isArray(roomPlayers)) {
      throw new BadRequestException('Invalid player list.');
    }

    if (
      roomPlayers.some(
        (player) =>
          !player ||
          typeof player.id !== 'string' ||
          !player.id.trim() ||
          typeof player.name !== 'string' ||
          !player.name.trim(),
      )
    ) {
      throw new BadRequestException('Invalid player information.');
    }

    // Prevent duplicate player IDs.
    const playerIds = roomPlayers.map((player) => player.id);

    if (new Set(playerIds).size !== playerIds.length) {
      throw new BadRequestException('Duplicate players are not allowed.');
    }

    const existingGame = this.gameStates.get(roomCode);

    // Prevent starting a new round before the current round finishes or game over.
    if (
      existingGame &&
      existingGame.phase !== GamePhase.ROUND_RESULT &&
      existingGame.phase !== GamePhase.GAME_OVER
    ) {
      throw new BadRequestException('A game is already in progress.');
    }

    // Keep the same players between rounds.
    if (existingGame) {
      const previousPlayerIds = existingGame.players
        .map((player) => player.id)
        .sort();

      const currentPlayerIds = [...playerIds].sort();

      const samePlayers =
        previousPlayerIds.length === currentPlayerIds.length &&
        previousPlayerIds.every(
          (playerId, index) => playerId === currentPlayerIds[index],
        );

      if (!samePlayers) {
        throw new BadRequestException(
          'The player list cannot change between rounds.',
        );
      }

      // Prevent another player from taking over as host during the game.
      if (existingGame.hostId !== hostId) {
        throw new BadRequestException(
          'The host cannot change during an active game session.',
        );
      }
    }

    // Get roles for the current player count.
    const roles = this.roleDistribution[playerCount];

    if (!roles) {
      throw new BadRequestException('Invalid player count.');
    }

    // Create shuffled papers. Each paper gets a permanent identity icon,
    // so a paper keeps the same icon for every player through the round.
    const shuffledIcons = this.shuffleIcons([...this.paperIconPool]);

    const papers: GamePaper[] = this.shuffleRoles([...roles]).map(
      (role, index) => ({
        id: randomUUID(),
        role,
        icon: shuffledIcons[index % shuffledIcons.length],
      }),
    );

    // Reset round-specific data and preserve cumulative scores.
    // If starting fresh from GAME_OVER, reset scores.
    const isNewMatch = existingGame?.phase === GamePhase.GAME_OVER;
    const players: GamePlayer[] = roomPlayers.map((player) => {
      const previousPlayer = existingGame?.players.find(
        (item) => item.id === player.id,
      );

      return {
        id: player.id,
        name: player.name,
        hasPicked: false,
        score: isNewMatch ? 0 : (previousPlayer?.score ?? player.score ?? 0),
        roundScore: 0,
        isBot: player.isBot ?? false,
      };
    });

    // Create the new game state.
    const gameState: GameState = {
      roomCode,
      hostId,
      phase: GamePhase.PICKING,
      players,
      papers,
      roundNumber: existingGame && !isNewMatch ? existingGame.roundNumber + 1 : 1,
      // Keep per-round scoring history across rounds; reset it on a new match.
      history: isNewMatch ? [] : existingGame?.history ?? [],
      settings: settings ?? existingGame?.settings,
    };

    this.gameStates.set(roomCode, gameState);

    return gameState;
  }

  pickPaper(roomCode: string, playerId: string, paperId: string): GameState {
    const game = this.gameStates.get(roomCode);

    if (!game) {
      throw new BadRequestException('Game not found.');
    }

    if (game.phase !== GamePhase.PICKING) {
      throw new BadRequestException(
        'Paper selection is not available right now.',
      );
    }

    const player = game.players.find((item) => item.id === playerId);

    if (!player) {
      throw new BadRequestException('Player does not belong to this game.');
    }

    if (player.hasPicked) {
      throw new BadRequestException('You have already picked a paper.');
    }

    const paper = game.papers.find((item) => item.id === paperId);

    if (!paper) {
      throw new BadRequestException('Paper not found.');
    }

    if (paper.selectedBy) {
      throw new BadRequestException('This paper has already been selected.');
    }

    // The player receives the role written on the selected paper.
    paper.selectedBy = player.id;
    player.role = paper.role;
    player.hasPicked = true;

    // Reveal roles only after every player has selected a paper.
    const everyonePicked = game.players.every((item) => item.hasPicked);

    if (everyonePicked) {
      game.phase = GamePhase.ROLE_REVEAL;
    }

    return game;
  }

  autoPickRemainingPapers(roomCode: string): GameState {
    const game = this.gameStates.get(roomCode);

    if (!game || game.phase !== GamePhase.PICKING) {
      return game!;
    }

    const unpickedPlayers = game.players.filter((p) => !p.hasPicked);
    const unselectedPapers = game.papers.filter((p) => !p.selectedBy);

    for (let i = 0; i < unpickedPlayers.length; i++) {
      const player = unpickedPlayers[i];
      const paper = unselectedPapers[i];
      if (player && paper) {
        paper.selectedBy = player.id;
        player.role = paper.role;
        player.hasPicked = true;
      }
    }

    const everyonePicked = game.players.every((item) => item.hasPicked);
    if (everyonePicked) {
      game.phase = GamePhase.ROLE_REVEAL;
    }

    return game;
  }

  getPublicGameState(roomCode: string) {
    const game = this.gameStates.get(roomCode);

    if (!game) {
      throw new BadRequestException('Game not found.');
    }

    return {
      roomCode: game.roomCode,
      phase: game.phase,
      roundNumber: game.roundNumber,
      history: game.history ?? [],
      targetRole: game.targetRole,
      selectedPlayerId: game.selectedPlayerId,
      settings: game.settings,
      winnerPlayerId: game.winnerPlayerId,
      players: game.players.map((player) => ({
        id: player.id,
        name: player.name,
        isBot: player.isBot ?? false,
        role:
          game.phase === GamePhase.ROLE_REVEAL ||
          game.phase === GamePhase.GUESSING
            ? player.role === GameRole.CHOR || player.role === GameRole.DAKAT
              ? 'CHOR_OR_DAKAT'
              : player.role
            : game.phase === GamePhase.ROUND_RESULT ||
              game.phase === GamePhase.GAME_OVER
            ? player.role
            : undefined,
        hasPicked: player.hasPicked,
        score: player.score,
        roundScore: player.roundScore,
      })),
      // Send ALL papers (taken ones included) so every player can see who
      // picked which slip. roles are never exposed, only the identity icon.
      papers: game.papers.map((paper) => ({
        id: paper.id,
        icon: paper.icon,
        selectedBy: paper.selectedBy,
      })),
    };
  }

  getGameState(roomCode: string): GameState | undefined {
    return this.gameStates.get(roomCode);
  }

  private shuffleIcons(icons: string[]): string[] {
    for (let index = icons.length - 1; index > 0; index--) {
      const randomIndex = randomInt(index + 1);

      [icons[index], icons[randomIndex]] = [icons[randomIndex], icons[index]];
    }

    return icons;
  }

  private shuffleRoles(roles: GameRole[]): GameRole[] {
    for (let index = roles.length - 1; index > 0; index--) {
      const randomIndex = randomInt(index + 1);

      [roles[index], roles[randomIndex]] = [roles[randomIndex], roles[index]];
    }

    return roles;
  }

  getMyRole(roomCode: string, playerId: string): GameRole {
    const game = this.gameStates.get(roomCode);

    if (!game) {
      throw new BadRequestException('Game not found.');
    }

    if (
      game.phase !== GamePhase.ROLE_REVEAL &&
      game.phase !== GamePhase.GUESSING &&
      game.phase !== GamePhase.ROUND_RESULT &&
      game.phase !== GamePhase.GAME_OVER
    ) {
      throw new BadRequestException('Roles have not been revealed yet.');
    }

    const player = game.players.find((item) => item.id === playerId);

    if (!player?.role) {
      throw new BadRequestException('Player role not found.');
    }

    return player.role;
  }

  selectTarget(
    roomCode: string,
    playerId: string,
    targetRole: GameRole.CHOR | GameRole.DAKAT,
  ): GameState {
    const game = this.gameStates.get(roomCode);

    if (!game) {
      throw new BadRequestException('Game not found.');
    }

    if (game.phase !== GamePhase.ROLE_REVEAL) {
      throw new BadRequestException(
        'Target selection is not available right now.',
      );
    }

    const raja = game.players.find((player) => player.id === playerId);

    if (!raja || raja.role !== GameRole.RAJA) {
      throw new BadRequestException('Only Babu can select the target role.');
    }

    if (targetRole !== GameRole.CHOR && targetRole !== GameRole.DAKAT) {
      throw new BadRequestException('Invalid target role.');
    }

    game.targetRole = targetRole;

    // Defensive: never let a stale selected player from a previous round
    // appear as an already-chosen suspect when guessing begins.
    game.selectedPlayerId = undefined;

    game.phase = GamePhase.GUESSING;

    return game;
  }

  guessPlayer(
    roomCode: string,
    policeId: string,
    selectedPlayerId: string,
  ): GameState {
    const game = this.gameStates.get(roomCode);

    if (!game) {
      throw new BadRequestException('Game not found.');
    }

    if (game.phase !== GamePhase.GUESSING) {
      throw new BadRequestException('Guessing is not available right now.');
    }

    if (
      typeof policeId !== 'string' ||
      typeof selectedPlayerId !== 'string' ||
      !policeId.trim() ||
      !selectedPlayerId.trim()
    ) {
      throw new BadRequestException('Invalid player information.');
    }
    const police = game.players.find((player) => player.id === policeId);

    if (!police || police.role !== GameRole.POLICE) {
      throw new BadRequestException('Only Police can guess the player.');
    }

    const selectedPlayer = game.players.find(
      (player) => player.id === selectedPlayerId,
    );

    if (!selectedPlayer) {
      throw new BadRequestException(
        'Selected player does not belong to this game.',
      );
    }

    if (
      selectedPlayer.role !== GameRole.CHOR &&
      selectedPlayer.role !== GameRole.DAKAT
    ) {
      throw new BadRequestException('Police must select either Chor or Dakat.');
    }

    if (!game.targetRole) {
      throw new BadRequestException('Babu has not selected a target role.');
    }

    game.selectedPlayerId = selectedPlayerId;

    this.calculateRoundScores(game);

    this.checkMatchEnd(game);

    return game;
  }

  private calculateRoundScores(game: GameState): void {
    if (!game.targetRole || !game.selectedPlayerId) {
      throw new BadRequestException(
        'Target role and selected player are required.',
      );
    }

    const selectedPlayer = game.players.find(
      (player) => player.id === game.selectedPlayerId,
    );

    if (!selectedPlayer?.role) {
      throw new BadRequestException('Selected player role not found.');
    }

    // All players must have selected their papers before scoring.
    if (game.players.some((player) => !player.role)) {
      throw new BadRequestException(
        'All players must have a role before scoring.',
      );
    }

    const isCorrectGuess = selectedPlayer.role === game.targetRole;

    // Calculate all round scores before updating cumulative scores.
    const roundScores = game.players.map((player) => {
      if (!player.role) {
        throw new BadRequestException('Player role not found.');
      }

      let roundScore = ROLE_SCORES[player.role];

      // Police gets points only when the guess is correct.
      if (player.role === GameRole.POLICE && !isCorrectGuess) {
        roundScore = 0;
      }

      // The correctly identified target gets zero points.
      if (isCorrectGuess && player.id === selectedPlayer.id) {
        roundScore = 0;
      }

      return {
        player,
        roundScore,
      };
    });

    // Update round and cumulative scores.
    for (const { player, roundScore } of roundScores) {
      player.roundScore = roundScore;
      player.score += roundScore;
    }

    // Record this round's points for the round-by-round leaderboard.
    const history = game.history ?? [];
    history.push({
      roundNumber: game.roundNumber,
      scores: roundScores.map(({ player, roundScore }) => ({
        playerId: player.id,
        points: roundScore,
      })),
    });
    game.history = history;
  }

  private checkMatchEnd(game: GameState): void {
    const settings = game.settings;

    let isOver = false;

    // Check target score condition (e.g. 3000 points)
    if (settings?.targetScore && settings.targetScore > 0) {
      const reachedTarget = game.players.some(
        (p) => p.score >= settings.targetScore!,
      );
      if (reachedTarget) {
        isOver = true;
      }
    }

    // Check max rounds condition (e.g. 5 rounds)
    if (settings?.maxRounds && settings.maxRounds > 0) {
      if (game.roundNumber >= settings.maxRounds) {
        isOver = true;
      }
    }

    if (isOver) {
      game.phase = GamePhase.GAME_OVER;

      // Find top scorer
      const sorted = [...game.players].sort((a, b) => b.score - a.score);
      game.winnerPlayerId = sorted[0]?.id;
    } else {
      game.phase = GamePhase.ROUND_RESULT;
    }
  }

  allowNextRound(
    roomCode: string,
    requesterId: string,
    allowedPlayerId: string,
  ): GameState {
    const game = this.gameStates.get(roomCode);

    if (!game) {
      throw new BadRequestException('Game not found.');
    }

    // Only allow permission changes after a round finishes.
    if (game.phase !== GamePhase.ROUND_RESULT) {
      throw new BadRequestException(
        'Next-round permission can only be changed after a round ends.',
      );
    }

    if (
      typeof requesterId !== 'string' ||
      typeof allowedPlayerId !== 'string' ||
      !requesterId.trim() ||
      !allowedPlayerId.trim()
    ) {
      throw new BadRequestException('Invalid player information.');
    }

    // Verify the requester is the actual host.
    if (game.hostId !== requesterId) {
      throw new BadRequestException(
        'Only the host can grant next-round permission.',
      );
    }

    // Verify the selected player belongs to this game.
    const allowedPlayer = game.players.find(
      (player) => player.id === allowedPlayerId,
    );

    if (!allowedPlayer) {
      throw new BadRequestException(
        'The selected player is not part of this game.',
      );
    }

    // Grant or replace the permission.
    game.nextRoundAllowedPlayerId = allowedPlayerId;

    return game;
  }

  finishMatch(roomCode: string, requesterId: string): GameState {
    const game = this.gameStates.get(roomCode);

    if (!game) {
      throw new BadRequestException('Game not found.');
    }

    if (game.hostId !== requesterId) {
      throw new BadRequestException('Only the host can finish the game.');
    }

    game.phase = GamePhase.GAME_OVER;

    const sorted = [...game.players].sort((a, b) => b.score - a.score);
    game.winnerPlayerId = sorted[0]?.id;

    return game;
  }
  canStartNextRound(roomCode: string, playerId: string): boolean {
    const game = this.gameStates.get(roomCode);

    if (!game) {
      throw new BadRequestException('Game not found.');
    }

    if (
      game.phase !== GamePhase.ROUND_RESULT &&
      game.phase !== GamePhase.GAME_OVER
    ) {
      throw new BadRequestException(
        'The current round must finish before starting the next round.',
      );
    }

    return (
      game.hostId === playerId || game.nextRoundAllowedPlayerId === playerId
    );
  }

  removeGame(roomCode: string): void {
    this.gameStates.delete(roomCode);
  }
}
