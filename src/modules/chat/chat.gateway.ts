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

interface ChatMessageEntry {
  senderId: string;
  senderName: string;
  message: string;
  timestamp: string;
}

/** Messages kept per room so a refresh/reconnect can replay the chat. */
const MAX_HISTORY_PER_ROOM = 100;

@WebSocketGateway({
  cors: {
    origin: '*',
  },
})
export class ChatGateway {
  @WebSocketServer()
  server!: Server;

  /** Room-wise chat history: roomCode -> messages (oldest first). */
  private readonly chatHistory = new Map<string, ChatMessageEntry[]>();

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

      const entry: ChatMessageEntry = {
        senderId: playerId,
        senderName: playerName,
        message,
        timestamp: new Date().toISOString(),
      };
      this.storeMessage(roomCode, entry);

      this.server.to(roomCode).emit('chat:message', entry);
    } catch (error: unknown) {
      client.emit('chat:error', {
        message:
          error instanceof Error ? error.message : 'Failed to send message',
      });
    }
  }

  /**
   * Player asks for the chat that already happened in this room (used after
   * a page refresh or to bring a returning player up to date).
   */
  @SubscribeMessage('chat:history')
  handleChatHistory(@ConnectedSocket() client: Socket): void {
    try {
      const { roomCode } = this.validateSender(client);
      client.emit('chat:history', this.chatHistory.get(roomCode) ?? []);
    } catch {
      // Not in a room (yet): nothing to replay.
      client.emit('chat:history', []);
    }
  }

  /** Append a message to the room's history, dropping dead rooms. */
  private storeMessage(roomCode: string, entry: ChatMessageEntry): void {
    // Rooms are removed when everyone leaves; drop their history too.
    for (const code of this.chatHistory.keys()) {
      if (!this.roomsService.getRoomIfExists(code)) {
        this.chatHistory.delete(code);
      }
    }

    const history = this.chatHistory.get(roomCode) ?? [];
    history.push(entry);

    if (history.length > MAX_HISTORY_PER_ROOM) {
      history.splice(0, history.length - MAX_HISTORY_PER_ROOM);
    }

    this.chatHistory.set(roomCode, history);
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
