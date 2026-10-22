export interface RoomPlayer {
  id: string;
  name: string;
  isHost: boolean;
  isConnected: boolean;
  /** 4-digit secret used to reclaim this seat from another browser. */
  seatPin: string;
  /** True for a server-side bot that plays automatically via timed actions. */
  isBot: boolean;
}

export interface GameRoom {
  code: string;
  hostId: string;
  players: RoomPlayer[];
  createdAt: Date;
}

export interface CreateRoomPayload {
  playerName: string;
}

export interface JoinRoomPayload {
  roomCode: string;
  playerName: string;
}

export interface PublicRoomState {
  roomCode: string;
  players: RoomPlayer[];
  maxPlayers: number;
}

export interface CreateRoomResult {
  room: GameRoom;
  player: RoomPlayer;
  reconnectToken: string;
}

export interface JoinRoomResult {
  room: GameRoom;
  player: RoomPlayer;
  reconnectToken: string;
}

export interface ReclaimSeatPayload {
  roomCode: string;
  playerName: string;
  seatPin: string;
}

export interface KickPlayerPayload {
  playerId: string;
}

export interface ReconnectPlayerResult {
  room: GameRoom;
  player: RoomPlayer;
  reconnectToken: string;
}
