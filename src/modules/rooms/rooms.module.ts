import { Module } from '@nestjs/common';
import { RoomsService } from './rooms.service.js';
import { RoomsGateway } from './rooms.gateway.js';

@Module({
  providers: [RoomsService, RoomsGateway],
  exports: [RoomsService],
})
export class RoomsModule {}
