import { Module } from '@nestjs/common';
import { ChatGateway } from './chat.gateway.js';
import { RoomsModule } from '../rooms/rooms.module.js';

@Module({
  imports: [RoomsModule],
  providers: [ChatGateway],
  exports: [ChatGateway],
})
export class ChatModule {}
