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
