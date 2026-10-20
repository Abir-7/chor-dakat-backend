import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomInt, randomUUID } from 'node:crypto';

import type {
  CreateRoomResult,
  GameRoom,
  JoinRoomResult,
  ReconnectPlayerResult,
  RoomPlayer,
} from './room.types.js';

/** How long a disconnected seat is held before it is released. */
export const DISCONNECT_GRACE_MS = 2 * 60 * 1000;

@Injectable()
export class RoomsService {
  private readonly rooms = new Map<string, GameRoom>();
  private readonly maxPlayers = 8;
  private isGameActive?: (roomCode: string) => boolean;
  private onRoomEmpty?: (roomCode: string) => void;
  private onRoomPlayersChanged?: (roomCode: string) => void;
  private onPlayerReconnected?: (roomCode: string, playerId: string) => void;
  private onPlayerTimedOut?: (roomCode: string, playerName: string) => void;
  // Reconnect token -> player ID
  private readonly reconnectTokens = new Map<string, string>();

  // Player ID -> current reconnect token
  private readonly playerReconnectTokens = new Map<string, string>();

  // `${roomCode}:${playerId}` -> pending seat-release timer
  private readonly disconnectTimers = new Map<string, NodeJS.Timeout>();

  setRoomPlayersChangedHandler(handler: (roomCode: string) => void): void {
    this.onRoomPlayersChanged = handler;
  }

  setRoomEmptyHandler(handler: (roomCode: string) => void): void {
    this.onRoomEmpty = handler;
  }

  setGameActiveChecker(checker: (roomCode: string) => boolean): void {
    this.isGameActive = checker;
  }

  setPlayerReconnectedHandler(handler: (roomCode: string, playerId: string) => void): void {
    this.onPlayerReconnected = handler;
  }

  setPlayerTimedOutHandler(
    handler: (roomCode: string, playerName: string) => void,
  ): void {
    this.onPlayerTimedOut = handler;
  }

  /**
   * Announces that a seat is live again. The transport layer calls this once
   * the returning socket is registered, so listeners (game state resync) can
   * find that socket.
   */
  notifyPlayerReconnected(roomCode: string, playerId: string): void {
    this.onPlayerReconnected?.(roomCode, playerId);
  }

  createRoom(playerName: string): CreateRoomResult {
    const name = this.validatePlayerName(playerName);

    let code: string;

    do {
      code = randomInt(100000, 1000000).toString();
    } while (this.rooms.has(code));

    const player: RoomPlayer = {
      id: randomUUID(),
      name,
      isHost: true,
      isConnected: true,
      seatPin: this.generateSeatPin(),
    };

    const room: GameRoom = {
      code,
      hostId: player.id,
      players: [player],
      createdAt: new Date(),
    };

    this.rooms.set(code, room);

    return {
      room,
      player,
      reconnectToken: this.issueReconnectToken(player.id),
    };
  }

  joinRoom(code: string, playerName: string): JoinRoomResult {
    const roomCode = this.validateRoomCode(code);
    const name = this.validatePlayerName(playerName);
    const room = this.getRoom(roomCode);
    if (this.isGameActive?.(roomCode)) {
      throw new BadRequestException('Cannot join while a game is active.');
    }
    if (room.players.length >= this.maxPlayers) {
      throw new BadRequestException('Room is full.');
    }

    const duplicateName = room.players.some(
      (player) => player.name.toLowerCase() === name.toLowerCase(),
    );

    if (duplicateName) {
      throw new BadRequestException(
        'This player name is already taken in the room.',
      );
    }

    const player: RoomPlayer = {
      id: randomUUID(),
      name,
      isHost: false,
      isConnected: true,
      seatPin: this.generateSeatPin(),
    };

    room.players.push(player);

    return {
      room,
      player,
      reconnectToken: this.issueReconnectToken(player.id),
    };
  }

  getRoom(roomCode: string): GameRoom {
    const code = this.validateRoomCode(roomCode);
    const room = this.rooms.get(code);

    if (!room) {
      throw new NotFoundException('Room not found.');
    }

    return room;
  }

  getRoomIfExists(roomCode: string): GameRoom | undefined {
    if (typeof roomCode !== 'string' || !/^\d{6}$/.test(roomCode)) {
      return undefined;
    }

    return this.rooms.get(roomCode);
  }

  getPublicState(room: GameRoom) {
    return {
      roomCode: room.code,
      players: room.players.map((player) => ({
        id: player.id,
        name: player.name,
        isHost: player.isHost,
        isConnected: player.isConnected,
      })),
      maxPlayers: this.maxPlayers,
    };
  }

  removePlayer(roomCode: string, playerId: string): GameRoom | undefined {
    const code = this.validateRoomCode(roomCode);
    const room = this.rooms.get(code);

    if (!room) {
      return undefined;
    }

    const player = room.players.find((item) => item.id === playerId);

    if (!player) {
      return room;
    }

    this.cancelDisconnectTimeout(code, playerId);
    this.revokeReconnectToken(playerId);

    room.players = room.players.filter((item) => item.id !== playerId);

    if (room.players.length === 0) {
      this.rooms.delete(code);
      this.onRoomEmpty?.(code);
      return undefined;
    }

    if (room.hostId === playerId) {
      // Transfer host to the first remaining player.
      const newHost = room.players[0];

      room.hostId = newHost.id;

      for (const remainingPlayer of room.players) {
        remainingPlayer.isHost = remainingPlayer.id === newHost.id;
      }
    }
    this.onRoomPlayersChanged?.(code);
    return room;
  }

  markPlayerDisconnected(roomCode: string, playerId: string): GameRoom {
    const room = this.getRoom(roomCode);
    const player = room.players.find((item) => item.id === playerId);

    if (!player) {
      throw new NotFoundException('Player not found in this room.');
    }

    player.isConnected = false;

    this.scheduleDisconnectTimeout(roomCode, playerId);

    return room;
  }

  markPlayerConnected(roomCode: string, playerId: string): GameRoom {
    const room = this.getRoom(roomCode);
    const player = room.players.find((item) => item.id === playerId);

    if (!player) {
      throw new NotFoundException('Player not found in this room.');
    }

    this.cancelDisconnectTimeout(roomCode, playerId);

    player.isConnected = true;

    return room;
  }

  reconnectPlayer(
    roomCode: string,
    reconnectToken: string,
  ): ReconnectPlayerResult {
    if (
      typeof reconnectToken !== 'string' ||
      reconnectToken.trim().length === 0
    ) {
      throw new BadRequestException('Reconnect token is required.');
    }

    const room = this.getRoom(roomCode);
    const token = reconnectToken.trim();
    const playerId = this.reconnectTokens.get(token);

    if (!playerId) {
      throw new BadRequestException('Invalid or expired reconnect token.');
    }

    const player = room.players.find((item) => item.id === playerId);

    if (!player) {
      throw new NotFoundException('Player does not belong to this room.');
    }

    this.revokeReconnectToken(playerId);

    const newReconnectToken = this.issueReconnectToken(playerId);

    this.cancelDisconnectTimeout(roomCode, playerId);

    player.isConnected = true;

    return {
      room,
      player,
      reconnectToken: newReconnectToken,
    };
  }

  /**
   * Restores a seat from a browser that no longer has the reconnect token
   * (e.g. the browser was closed). The player must know the room code, the
   * name they joined with, and the 4-digit PIN that was issued to that seat.
   */
  reclaimSeat(
    roomCode: string,
    playerName: string,
    seatPin: string,
  ): ReconnectPlayerResult {
    const code = this.validateRoomCode(roomCode);
    const name = this.validatePlayerName(playerName);

    if (typeof seatPin !== 'string' || !/^\d{4}$/.test(seatPin.trim())) {
      throw new BadRequestException('Seat PIN must be exactly 4 digits.');
    }

    const room = this.getRoom(code);
    const pin = seatPin.trim();
    const player = room.players.find(
      (item) => item.name.toLowerCase() === name.toLowerCase(),
    );

    if (!player) {
      throw new NotFoundException(
        'No player with that name is in this room.',
      );
    }

    if (player.seatPin !== pin) {
      throw new BadRequestException('Incorrect seat PIN.');
    }

    if (player.isConnected) {
      throw new BadRequestException(
        'That seat is still in use. Ask the host to remove it first.',
      );
    }

    this.revokeReconnectToken(player.id);

    const reconnectToken = this.issueReconnectToken(player.id);

    this.cancelDisconnectTimeout(code, player.id);

    player.isConnected = true;

    return { room, player, reconnectToken };
  }

  /**
   * Host-only removal of another player (e.g. a seat that went dark).
   * Returns the room after removal, or undefined if the room is now empty.
   */
  kickPlayer(
    roomCode: string,
    hostId: string,
    targetPlayerId: string,
  ): { room: GameRoom | undefined; playerName: string } {
    const room = this.getRoom(roomCode);

    if (room.hostId !== hostId) {
      throw new BadRequestException('Only the host can remove players.');
    }

    if (targetPlayerId === hostId) {
      throw new BadRequestException('The host cannot remove themselves.');
    }

    const target = room.players.find((item) => item.id === targetPlayerId);

    if (!target) {
      throw new NotFoundException('Player not found in this room.');
    }

    const playerName = target.name;

    return { room: this.removePlayer(room.code, targetPlayerId), playerName };
  }

  private scheduleDisconnectTimeout(
    roomCode: string,
    playerId: string,
  ): void {
    const key = this.getPlayerKey(roomCode, playerId);

    if (this.disconnectTimers.has(key)) {
      return;
    }

    const timer = setTimeout(() => {
      this.disconnectTimers.delete(key);

      const room = this.rooms.get(roomCode);
      const player = room?.players.find((item) => item.id === playerId);

      // The player came back or the room is gone: nothing to release.
      if (!room || !player || player.isConnected) {
        return;
      }

      const playerName = player.name;

      this.removePlayer(roomCode, playerId);
      this.onPlayerTimedOut?.(roomCode, playerName);
    }, DISCONNECT_GRACE_MS);

    // Never keep the process alive just for a seat timer.
    timer.unref?.();

    this.disconnectTimers.set(key, timer);
  }

  private cancelDisconnectTimeout(roomCode: string, playerId: string): void {
    const key = this.getPlayerKey(roomCode, playerId);
    const timer = this.disconnectTimers.get(key);

    if (timer) {
      clearTimeout(timer);
      this.disconnectTimers.delete(key);
    }
  }

  private getPlayerKey(roomCode: string, playerId: string): string {
    return `${roomCode}:${playerId}`;
  }

  private generateSeatPin(): string {
    return randomInt(1000, 10000).toString();
  }

  private issueReconnectToken(playerId: string): string {
    const previousToken = this.playerReconnectTokens.get(playerId);

    if (previousToken) {
      this.reconnectTokens.delete(previousToken);
    }

    const token = randomUUID();

    this.reconnectTokens.set(token, playerId);
    this.playerReconnectTokens.set(playerId, token);

    return token;
  }

  private revokeReconnectToken(playerId: string): void {
    const token = this.playerReconnectTokens.get(playerId);

    if (token) {
      this.reconnectTokens.delete(token);
      this.playerReconnectTokens.delete(playerId);
    }
  }

  private validatePlayerName(playerName: string): string {
    if (typeof playerName !== 'string') {
      throw new BadRequestException('Player name must be a string.');
    }

    const name = playerName.trim();

    if (name.length < 2 || name.length > 20) {
      throw new BadRequestException(
        'Player name must be between 2 and 20 characters.',
      );
    }

    return name;
  }

  private validateRoomCode(roomCode: string): string {
    if (typeof roomCode !== 'string' || !/^\d{6}$/.test(roomCode.trim())) {
      throw new BadRequestException('Room code must contain exactly 6 digits.');
    }

    return roomCode.trim();
  }
}

