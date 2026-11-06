import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isPersistedQueryNotFound,
  parseAlbum,
  parseArtist,
  parseCard,
  parseHome,
  parsePlaylist,
  parseRecommendations,
  parseSearch,
  parseSearchTracks,
  parseTrack,
  parseTrackUnion,
  pickImage,
  uriId,
} from './parse.js';

const fx = (name: string): unknown =>
  JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', '__fixtures__', `${name}.json`), 'utf8'));

const ID = /^[A-Za-z0-9]{22}$/;

describe('pathfinder parsers (fixtures captured from open.spotify.com)', () => {
  it('home: sections with titles and cards of every kind', () => {
    const h = parseHome(fx('home'));
    expect(h.sections.length).toBeGreaterThanOrEqual(3);
    const titles = h.sections.map((s) => s.title);
    expect(titles).toContain('Trending songs');
    const kinds = new Set(h.sections.flatMap((s) => s.items.map((i) => i.kind)));
    expect(kinds).toEqual(new Set(['track', 'artist', 'album', 'playlist']));
    for (const s of h.sections) for (const c of s.items) expect(c.id).toMatch(ID);
    const song = h.sections.find((s) => s.title === 'Trending songs')!.items[0]!;
    // Home track cards carry no duration: the server fetches getTrack before matching audio (library/service.ts).
    expect(song.track?.artists.length).toBeGreaterThan(0);
  });

  it('search: tracks with artists, album and duration; artists/albums/playlists', () => {
    const s = parseSearch(fx('searchDesktop'), 'daft punk');
    expect(s.tracks.length).toBeGreaterThan(3);
    const t = s.tracks[0]!;
    expect(t.id).toMatch(ID);
    expect(t.artists[0]?.name).toBeTruthy();
    expect(t.album?.id).toMatch(ID);
    expect(t.cover).toMatch(/^https:\/\/i\.scdn\.co\//);
    expect(t.durationMs).toBeGreaterThan(30_000);
    expect(s.artists.length).toBeGreaterThan(0);
    expect(s.albums.length).toBeGreaterThan(0);
    expect(s.playlists.length).toBeGreaterThan(0);
  });

  it('search tracks page', () => {
    const p = parseSearchTracks(fx('searchTracks'), 0);
    expect(p.tracks.length).toBeGreaterThanOrEqual(10);
    expect(p.total).toBeGreaterThan(0);
  });

  it('album: every track gets the album and its cover', () => {
    const a = parseAlbum(fx('getAlbum'))!;
    expect(a.album.name).toBe('Discovery');
    expect(a.album.year).toBe('2001');
    expect(a.album.artists[0]?.name).toBe('Daft Punk');
    expect(a.tracks[0]?.name).toBe('One More Time');
    expect(a.tracks.every((t) => t.album?.id === a.album.id && t.cover)).toBe(true);
  });

  it('artist: profile, top tracks, discography, related artists', () => {
    const a = parseArtist(fx('queryArtistOverview'))!;
    expect(a.artist.name).toBe('Daft Punk');
    expect(a.artist.monthlyListeners).toBeGreaterThan(1_000_000);
    expect(a.topTracks.length).toBeGreaterThanOrEqual(5);
    expect(a.albums.length).toBeGreaterThan(0);
    expect(a.albums.every((c) => c.kind === 'album')).toBe(true);
    expect(a.related.length).toBeGreaterThan(0);
    expect(a.related[0]?.kind).toBe('artist');
  });

  it('playlist: metadata and tracks', () => {
    const p = parsePlaylist(fx('fetchPlaylist'), 0)!;
    expect(p.playlist.name).toBe('Top Songs - Global');
    expect(p.playlist.owner).toBe('Spotify');
    expect(p.tracks.length).toBeGreaterThan(10);
    expect(p.total).toBe(50);
    expect(p.tracks[0]?.durationMs).toBeGreaterThan(60_000);
  });

  it('track + recommendations', () => {
    const t = parseTrackUnion(fx('getTrack'))!;
    expect(t.name).toBe('One More Time');
    expect(t.artists[0]?.name).toBe('Daft Punk');
    expect(parseRecommendations(fx('internalLinkRecommenderTrack')).length).toBeGreaterThan(0);
  });

  it('rejects hostile or malformed input', () => {
    expect(parseTrack({ __typename: 'Track', uri: 'spotify:track:../../etc', name: 'x' })).toBeNull();
    expect(parseTrack({ __typename: 'Episode', uri: 'spotify:track:0DiWol3AO6WpXZgp0goxAV', name: 'x' })).toBeNull();
    expect(parseCard({ __typename: 'Album', uri: 'spotify:artist:0DiWol3AO6WpXZgp0goxAV' })).toBeNull();
    expect(parseHome(null).sections).toEqual([]);
    expect(parseAlbum({ data: { albumUnion: 'x' } })).toBeNull();
    expect(pickImage([{ url: 'javascript:alert(1)' }, { url: 'https://evil.example/x.jpg' }])).toBeNull();
    expect(pickImage([{ url: 'https://i.scdn.co/image/abc', width: 300 }])).toBe('https://i.scdn.co/image/abc');
    expect(uriId('spotify:track:0DiWol3AO6WpXZgp0goxAV', 'album')).toBeNull();
    expect(isPersistedQueryNotFound({ errors: [{ message: 'PersistedQueryNotFound' }] })).toBe(true);
  });
});
