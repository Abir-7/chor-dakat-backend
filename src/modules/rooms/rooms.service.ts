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

@Injectable()
export class RoomsService {
  private readonly rooms = new Map<string, GameRoom>();
  private readonly maxPlayers = 8;
  private isGameActive?: (roomCode: string) => boolean;
  private onRoomEmpty?: (roomCode: string) => void;
  private onRoomPlayersChanged?: (roomCode: string) => void;
  private onPlayerReconnected?: (roomCode: string, playerId: string) => void;
  // Reconnect token -> player ID
  private readonly reconnectTokens = new Map<string, string>();

  // Player ID -> current reconnect token
  private readonly playerReconnectTokens = new Map<string, string>();

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

    return room;
  }

  markPlayerConnected(roomCode: string, playerId: string): GameRoom {
    const room = this.getRoom(roomCode);
    const player = room.players.find((item) => item.id === playerId);

    if (!player) {
      throw new NotFoundException('Player not found in this room.');
    }

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

    player.isConnected = true;

    this.onPlayerReconnected?.(roomCode, playerId);

    return {
      room,
      player,
      reconnectToken: newReconnectToken,
    };
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

