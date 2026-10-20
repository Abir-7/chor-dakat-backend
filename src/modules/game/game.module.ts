import { Module } from '@nestjs/common';
import { GameGateway } from './game.gateway.js';
import { GameService } from './game.service.js';
import { RoomsModule } from '../rooms/rooms.module.js';

@Module({
  providers: [GameGateway, GameService],
  exports: [GameGateway, GameService],
  imports: [RoomsModule],
})
export class GameModule {}
