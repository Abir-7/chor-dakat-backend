import { Module } from '@nestjs/common';
import { GameGateway } from './game.gateway.js';
import { GameService } from './game.service.js';
import { BotService } from './bots.service.js';
import { RoomsModule } from '../rooms/rooms.module.js';

@Module({
  providers: [GameGateway, GameService, BotService],
  exports: [GameGateway, GameService, BotService],
  imports: [RoomsModule],
})
export class GameModule {}
