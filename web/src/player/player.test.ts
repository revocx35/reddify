// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Track } from '../../../shared/api';

const mk = (id: string): Track => ({ id, name: id, artists: [], album: null, cover: null, durationMs: 1000, explicit: false, playable: true, cached: true });
const smartShuffle = vi.fn();
vi.mock('../api/client', () => ({
  api: {
    smartShuffle: (...a: unknown[]) => smartShuffle(...a),
    prepare: async () => ({ status: 'ready' }),
    streamUrl: (id: string) => `/api/stream/${id}`,
    recommendations: async () => [],
    played: async () => undefined,
    status: async () => null,
  },
}));
vi.mock('./cast', () => ({ CastController: class {} }));

const { Player } = await import('./player');

beforeEach(() => {
  smartShuffle.mockReset();
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('Smart Shuffle (web player)', () => {
  it('cycles off → shuffle → smart → off, mixes one recommendation per 3 songs and removes them again', async () => {
    const list = Array.from({ length: 9 }, (_, i) => mk(`t${i}`));
    smartShuffle.mockResolvedValue({ tracks: [mk('r1'), mk('t3'), mk('r2'), mk('r3'), mk('r4')], offline: false });
    const p = new Player();
    p.playList(list, 0, null);
    p.cycleShuffle();
    expect(p.getState().shuffle).toBe(true);
    expect(p.getState().smart).toBe(false);

    p.cycleShuffle();
    await flush();
    const st = p.getState();
    expect(st.smart).toBe(true);
    // The request carries the playing list (the server seeds from it and never repeats it).
    const [ids, count] = smartShuffle.mock.calls[0]!;
    expect(new Set(ids as string[])).toEqual(new Set(list.map((t) => t.id)));
    expect(count).toBe(3);
    // 8 upcoming songs → a recommendation after the 3rd and the 6th; t3 (already in the list) is never added.
    expect(st.queue).toHaveLength(11);
    expect(st.smartIds).toEqual(['r1', 'r2']);
    expect(st.queue[4]!.id).toBe('r1');
    expect(st.queue[8]!.id).toBe('r2');
    expect(p.isSmartPick('r1')).toBe(true);

    p.cycleShuffle();
    const off = p.getState();
    expect(off.smart).toBe(false);
    expect(off.shuffle).toBe(false);
    expect(off.smartIds).toEqual([]);
    expect(off.queue.map((t) => t.id)).toEqual(list.map((t) => t.id));
  });

  it('drops an answer that arrives after the list changed, and works when the server fails', async () => {
    let resolve!: (v: unknown) => void;
    smartShuffle.mockReturnValueOnce(new Promise((r) => (resolve = r))).mockRejectedValueOnce(new Error('down'));
    const p = new Player();
    p.playList(Array.from({ length: 6 }, (_, i) => mk(`a${i}`)), 0, null);
    p.setSmart(true);
    p.playList(Array.from({ length: 6 }, (_, i) => mk(`b${i}`)), 0, null);
    resolve({ tracks: [mk('late')], offline: false });
    await flush();
    // The new list asked for its own recommendations (the server failed: no change, no error).
    expect(smartShuffle).toHaveBeenCalledTimes(2);
    expect(p.getState().queue.some((t) => t.id === 'late')).toBe(false);
    expect(p.getState().smart).toBe(true);
    expect(p.getState().queue).toHaveLength(6);
  });
});
