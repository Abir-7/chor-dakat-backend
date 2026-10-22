import { BadRequestException } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { RoomsService } from '../rooms/rooms.service.js';
import { ALLOWED_REACTIONS } from './reactions.js';

interface SendMessagePayload {
  message: string;
}

interface SendReactionPayload {
  reaction: string;
}

@WebSocketGateway({
  cors: {
    origin: '*',
  },
})
export class ChatGateway {
  @WebSocketServer()
  server!: Server;

  constructor(private readonly roomsService: RoomsService) {}

  @SubscribeMessage('chat:send-message')
  handleSendMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: SendMessagePayload,
  ): void {
    try {
      const { roomCode, playerId, playerName } = this.validateSender(client);

      if (
        !payload ||
        typeof payload.message !== 'string' ||
        !payload.message.trim()
      ) {
        throw new BadRequestException('Message cannot be empty.');
      }

      const message = payload.message.trim();

      if (message.length > 200) {
        throw new BadRequestException('Message cannot exceed 200 characters.');
      }

      this.server.to(roomCode).emit('chat:message', {
        senderId: playerId,
        senderName: playerName,
        message,
        timestamp: new Date().toISOString(),
      });
    } catch (error: unknown) {
      client.emit('chat:error', {
        message:
          error instanceof Error ? error.message : 'Failed to send message',
      });
    }
  }

  @SubscribeMessage('chat:send-reaction')
  handleSendReaction(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: SendReactionPayload,
  ): void {
    try {
      const { roomCode, playerId, playerName } = this.validateSender(client);

      if (
        !payload ||
        typeof payload.reaction !== 'string' ||
        !ALLOWED_REACTIONS.has(payload.reaction)
      ) {
        throw new BadRequestException('Invalid reaction.');
      }

      this.server.to(roomCode).emit('chat:reaction', {
        senderId: playerId,
        senderName: playerName,
        reaction: payload.reaction,
        timestamp: new Date().toISOString(),
      });
    } catch (error: unknown) {
      client.emit('chat:error', {
        message:
          error instanceof Error ? error.message : 'Failed to send reaction',
      });
    }
  }

  private validateSender(client: Socket): {
    roomCode: string;
    playerId: string;
    playerName: string;
  } {
    const roomCode = client.data.roomCode as string | undefined;
    const playerId = client.data.playerId as string | undefined;

    if (!roomCode || !playerId) {
      throw new BadRequestException('Join a room before chatting.');
    }

    const room = this.roomsService.getRoomIfExists(roomCode);

    if (!room) {
      throw new BadRequestException('Room does not exist.');
    }

    const player = room.players.find((p) => p.id === playerId);

    if (!player) {
      throw new BadRequestException('Player not found in room.');
    }

    return {
      roomCode,
      playerId,
      playerName: player.name,
    };
  }
}
