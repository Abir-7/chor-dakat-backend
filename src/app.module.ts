import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { RoomsModule } from './modules/rooms/rooms.module.js';
import { PlayersModule } from './modules/players/players.module.js';
import { GameModule } from './modules/game/game.module.js';
import { ChatModule } from './modules/chat/chat.module.js';

@Module({
  imports: [RoomsModule, PlayersModule, GameModule, ChatModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
