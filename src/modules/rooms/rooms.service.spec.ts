import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { DISCONNECT_GRACE_MS, RoomsService } from './rooms.service.js';

describe('RoomsService seat recovery', () => {
  let service: RoomsService;

  beforeEach(() => {
    service = new RoomsService();
  });

  const createRoom = () => {
    const created = service.createRoom('Host');
    const joined = service.joinRoom(created.room.code, 'Guest');

    return { roomCode: created.room.code, host: created.player, guest: joined.player };
  };

  it('issues a 4-digit seat PIN to every player', () => {
    const { host, guest } = createRoom();

    expect(host.seatPin).toMatch(/^\d{4}$/);
    expect(guest.seatPin).toMatch(/^\d{4}$/);
  });

  it('keeps seat PINs out of the public room state', () => {
    const { roomCode } = createRoom();
    const publicState = service.getPublicState(service.getRoom(roomCode));

    expect(JSON.stringify(publicState)).not.toContain('seatPin');
  });

  it('reclaims a disconnected seat with the correct name and PIN', () => {
    const { roomCode, guest } = createRoom();

    service.markPlayerDisconnected(roomCode, guest.id);

    const result = service.reclaimSeat(roomCode, 'Guest', guest.seatPin);

    expect(result.player.id).toBe(guest.id);
    expect(result.player.isConnected).toBe(true);
    expect(result.reconnectToken).not.toBe('');
    expect(service.getRoom(roomCode).players).toHaveLength(2);
  });

  it('accepts the name case-insensitively', () => {
    const { roomCode, guest } = createRoom();

    service.markPlayerDisconnected(roomCode, guest.id);

    const result = service.reclaimSeat(roomCode, 'gUeSt', guest.seatPin);

    expect(result.player.id).toBe(guest.id);
  });

  it('rejects an incorrect PIN', () => {
    const { roomCode, guest } = createRoom();
    const wrongPin = guest.seatPin === '0000' ? '1111' : '0000';

    service.markPlayerDisconnected(roomCode, guest.id);

    expect(() => service.reclaimSeat(roomCode, 'Guest', wrongPin)).toThrow(
      /Incorrect seat PIN/,
    );
  });

  it('rejects reclaiming a seat that is still connected', () => {
    const { roomCode, guest } = createRoom();

    expect(() => service.reclaimSeat(roomCode, 'Guest', guest.seatPin)).toThrow(
      /still in use/,
    );
  });

  it('rejects an unknown player name', () => {
    const { roomCode, guest } = createRoom();

    service.markPlayerDisconnected(roomCode, guest.id);

    expect(() => service.reclaimSeat(roomCode, 'Nobody', guest.seatPin)).toThrow(
      /No player with that name/,
    );
  });

  it('kicks a player when the host asks', () => {
    const { roomCode, host, guest } = createRoom();

    const { room, playerName } = service.kickPlayer(roomCode, host.id, guest.id);

    expect(playerName).toBe('Guest');
    expect(room?.players.map((player) => player.id)).toEqual([host.id]);
  });

  it('refuses a kick from a non-host', () => {
    const { roomCode, host, guest } = createRoom();
    const third = service.joinRoom(roomCode, 'Third');

    expect(() =>
      service.kickPlayer(roomCode, third.player.id, guest.id),
    ).toThrow(/Only the host can remove players/);

    expect(service.getRoom(roomCode).hostId).toBe(host.id);
  });

  it('refuses to let the host kick themselves', () => {
    const { roomCode, host } = createRoom();

    expect(() => service.kickPlayer(roomCode, host.id, host.id)).toThrow(
      /cannot remove themselves/,
    );
  });
});

describe('RoomsService bot players', () => {
  let service: RoomsService;

  beforeEach(() => {
    service = new RoomsService();
  });

  it('lets the host add a bot with a default unique name', () => {
    const created = service.createRoom('Host');

    const { room, bot } = service.addBotPlayer(
      created.room.code,
      created.player.id,
    );

    expect(bot.isBot).toBe(true);
    expect(bot.isConnected).toBe(true);
    expect(bot.name).toMatch(/^Bot /);
    expect(room.players.find((p) => p.id === bot.id)).toBe(bot);
  });

  it('honors the bot name set by the host', () => {
    const created = service.createRoom('Host');

    const { bot } = service.addBotPlayer(
      created.room.code,
      created.player.id,
      'Crazy Cop',
    );

    expect(bot.name).toBe('Crazy Cop');
  });

  it('refuses to add a bot when non-host triggers the request', () => {
    const created = service.createRoom('Host');
    const guest = service.joinRoom(created.room.code, 'Guest').player;

    expect(() =>
      service.addBotPlayer(created.room.code, guest.id, 'Bot X'),
    ).toThrow(/Only the host can add bots/);
  });

  it('rejects a bot name already taken by a human (case-insensitive)', () => {
    const created = service.createRoom('Host');
    service.joinRoom(created.room.code, 'Guest');

    expect(() =>
      service.addBotPlayer(created.room.code, created.player.id, 'GUEST'),
    ).toThrow(/already taken/);
  });

  it('keeps the room within the max player limit when adding bots', () => {
    const created = service.createRoom('Host');

    for (let i = 0; i < 7; i++) {
      service.addBotPlayer(created.room.code, created.player.id);
    }

    expect(() =>
      service.addBotPlayer(created.room.code, created.player.id),
    ).toThrow(/Room is full/);
  });

  it('refuses bots while a game is active', () => {
    const created = service.createRoom('Host');
    service.setGameActiveChecker(() => true);

    expect(() =>
      service.addBotPlayer(created.room.code, created.player.id),
    ).toThrow(/while a game is active/);
  });

  it('exposes bots in the public room state without leaking secrets', () => {
    const created = service.createRoom('Host');
    service.addBotPlayer(created.room.code, created.player.id, 'Bot Buzz');

    const publicState = service.getPublicState(
      service.getRoom(created.room.code),
    );
    const bots = publicState.players.filter((p) => p.isBot);

    expect(bots).toHaveLength(1);
    expect(bots[0].name).toBe('Bot Buzz');
    expect(JSON.stringify(publicState)).not.toContain('seatPin');
  });

  it('transfers the host to a human, never a bot, when the host leaves', () => {
    const created = service.createRoom('Host');
    service.joinRoom(created.room.code, 'Guest');
    const bot = service.addBotPlayer(created.room.code, created.player.id).bot;

    service.removePlayer(created.room.code, created.player.id);

    const room = service.getRoom(created.room.code);
    const newHost = room.players.find((p) => p.id === room.hostId);

    expect(newHost).toBeDefined();
    expect(newHost?.isBot).toBe(false);
    expect(room.players.some((p) => p.id === bot.id)).toBe(true);
  });

  it('kicks a bot like a regular player when the host removes it', () => {
    const created = service.createRoom('Host');
    const bot = service.addBotPlayer(created.room.code, created.player.id).bot;

    const { room, playerName } = service.kickPlayer(
      created.room.code,
      created.player.id,
      bot.id,
    );

    expect(playerName).toBe(bot.name);
    expect(room?.players).toHaveLength(1);
  });

  it('never lets a bot seat be reclaimed with a PIN', () => {
    const created = service.createRoom('Host');
    const bot = service.addBotPlayer(created.room.code, created.player.id).bot;

    expect(() =>
      service.reclaimSeat(created.room.code, bot.name, bot.seatPin),
    ).toThrow(/still in use/);
  });
});

describe('RoomsService disconnect grace period', () => {
  let service: RoomsService;

  beforeEach(() => {
    vi.useFakeTimers();
    service = new RoomsService();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('releases a seat that stays disconnected for the full grace period', () => {
    const created = service.createRoom('Host');
    const guest = service.joinRoom(created.room.code, 'Guest').player;
    const timedOut = vi.fn();

    service.setPlayerTimedOutHandler(timedOut);
    service.markPlayerDisconnected(created.room.code, guest.id);

    vi.advanceTimersByTime(DISCONNECT_GRACE_MS - 1);
    expect(service.getRoom(created.room.code).players).toHaveLength(2);

    vi.advanceTimersByTime(1);

    expect(service.getRoom(created.room.code).players).toHaveLength(1);
    expect(timedOut).toHaveBeenCalledWith(created.room.code, 'Guest');
  });

  it('keeps the seat when the player reconnects before the grace period', () => {
    const created = service.createRoom('Host');
    const joined = service.joinRoom(created.room.code, 'Guest');

    service.markPlayerDisconnected(created.room.code, joined.player.id);
    service.reconnectPlayer(created.room.code, joined.reconnectToken);

    vi.advanceTimersByTime(DISCONNECT_GRACE_MS);

    const room = service.getRoom(created.room.code);

    expect(room.players).toHaveLength(2);
    expect(room.players.find((p) => p.id === joined.player.id)?.isConnected).toBe(
      true,
    );
  });

  it('keeps the seat when it is reclaimed with the PIN before the deadline', () => {
    const created = service.createRoom('Host');
    const guest = service.joinRoom(created.room.code, 'Guest').player;

    service.markPlayerDisconnected(created.room.code, guest.id);
    service.reclaimSeat(created.room.code, 'Guest', guest.seatPin);

    vi.advanceTimersByTime(DISCONNECT_GRACE_MS);

    expect(service.getRoom(created.room.code).players).toHaveLength(2);
  });
});
