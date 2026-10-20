import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

import { RoomsService } from './rooms.service.js';
import type { CreateRoomPayload, JoinRoomPayload } from './room.types.js';

@WebSocketGateway({
  cors: {
    origin: '*', // Development only. Restrict this in production.
  },
})
export class RoomsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly activeSocketIds = new Map<string, string>();

  constructor(private readonly roomsService: RoomsService) {}

  handleConnection(client: Socket): void {
    console.log(`Connected: ${client.id}`);
  }

  handleDisconnect(client: Socket): void {
    const roomCode = client.data.roomCode as string | undefined;
    const playerId = client.data.playerId as string | undefined;

    if (!roomCode || !playerId) {
      return;
    }

    const playerKey = this.getPlayerKey(roomCode, playerId);
    const activeSocketId = this.activeSocketIds.get(playerKey);

    // Ignore disconnect events from an older connection.
    if (activeSocketId !== client.id) {
      return;
    }

    this.activeSocketIds.delete(playerKey);

    try {
      const room = this.roomsService.markPlayerDisconnected(roomCode, playerId);

      this.server
        .to(roomCode)
        .emit('room:updated', this.roomsService.getPublicState(room));
    } catch (error: unknown) {
      console.error('Failed to update disconnected player:', error);
    }
  }

  @SubscribeMessage('room:create')
  handleCreateRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: CreateRoomPayload,
  ): void {
    try {
      this.ensureNotInRoom(client, true);

      const { room, player, reconnectToken } = this.roomsService.createRoom(
        body?.playerName,
      );

      void client.join(room.code);
      this.registerPlayerSocket(client, room.code, player.id);

      client.emit('room:created', {
        ...this.roomsService.getPublicState(room),
        player: {
          id: player.id,
          name: player.name,
          isHost: player.isHost,
          isConnected: player.isConnected,
        },
        reconnectToken,
      });

      console.log(`Room created: ${room.code}, host: ${player.name}`);
    } catch (error: unknown) {
      this.emitError(client, error);
    }
  }

  @SubscribeMessage('room:join')
  handleJoinRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: JoinRoomPayload,
  ): void {
    try {
      this.ensureNotInRoom(client);

      const { room, player, reconnectToken } = this.roomsService.joinRoom(
        body?.roomCode,
        body?.playerName,
      );

      void client.join(room.code);
      this.registerPlayerSocket(client, room.code, player.id);

      client.emit('room:joined', {
        ...this.roomsService.getPublicState(room),
        player: {
          id: player.id,
          name: player.name,
          isHost: player.isHost,
          isConnected: player.isConnected,
        },
        reconnectToken,
      });

      this.server
        .to(room.code)
        .emit('room:updated', this.roomsService.getPublicState(room));

      console.log(`Player joined room ${room.code}: ${player.name}`);
    } catch (error: unknown) {
      this.emitError(client, error);
    }
  }

  @SubscribeMessage('room:reconnect')
  handleReconnect(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    body: {
      roomCode: string;
      reconnectToken: string;
    },
  ): void {
    try {
      this.ensureNotInRoom(client);

      void client.join(body?.roomCode);
      const { room, player, reconnectToken } =
        this.roomsService.reconnectPlayer(body?.roomCode, body?.reconnectToken);

      this.registerPlayerSocket(client, room.code, player.id);

      client.emit('room:reconnected', {
        ...this.roomsService.getPublicState(room),
        player: {
          id: player.id,
          name: player.name,
          isHost: player.isHost,
          isConnected: player.isConnected,
        },
        reconnectToken,
      });

      this.server
        .to(room.code)
        .emit('room:updated', this.roomsService.getPublicState(room));

      console.log(`Player reconnected to room ${room.code}: ${player.name}`);
    } catch (error: unknown) {
      this.emitError(client, error);
    }
  }

  @SubscribeMessage('room:leave')
  handleLeaveRoom(@ConnectedSocket() client: Socket): void {
    try {
      const roomCode = client.data.roomCode as string | undefined;
      const playerId = client.data.playerId as string | undefined;

      if (!roomCode || !playerId) {
        throw new Error('You are not in a room.');
      }

      const playerKey = this.getPlayerKey(roomCode, playerId);
      const activeSocketId = this.activeSocketIds.get(playerKey);

      if (activeSocketId !== client.id) {
        throw new Error('This connection is no longer active.');
      }

      const room = this.roomsService.removePlayer(roomCode, playerId);

      this.activeSocketIds.delete(playerKey);

      delete client.data.roomCode;
      delete client.data.playerId;

      void client.leave(roomCode);

      if (!room) {
        this.server.to(roomCode).emit('room:closed', {
          roomCode,
          message: 'The room is now closed.',
        });

        return;
      }

      this.server
        .to(roomCode)
        .emit('room:updated', this.roomsService.getPublicState(room));

      client.emit('room:left', { roomCode });
    } catch (error: unknown) {
      this.emitError(client, error);
    }
  }

  private ensureNotInRoom(client: Socket, isReconnecting = false): void {
    if (client.data.roomCode || client.data.playerId) {
      if (isReconnecting) {
        delete client.data.roomCode;
        delete client.data.playerId;
        return;
      }
      throw new Error('You are already in a room.');
    }
  }

  private registerPlayerSocket(
    client: Socket,
    roomCode: string,
    playerId: string,
  ): void {
    const playerKey = this.getPlayerKey(roomCode, playerId);

    this.activeSocketIds.set(playerKey, client.id);

    client.data.roomCode = roomCode;
    client.data.playerId = playerId;
  }

  private getPlayerKey(roomCode: string, playerId: string): string {
    return `${roomCode}:${playerId}`;
  }

  private emitError(client: Socket, error: unknown): void {
    const message =
      error instanceof Error ? error.message : 'An unexpected error occurred.';

    client.emit('room:error', { message });
  }
}
