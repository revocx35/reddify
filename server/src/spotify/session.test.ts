import { describe, expect, it } from 'vitest';
import { openMemoryDb } from '../db/db.js';
import { Repo } from '../db/repo.js';
import { SpotifySession, instanceToken } from './session.js';

const HASH = 'a'.repeat(64);

describe('SpotifySession.capture (learning from the web player)', () => {
  it('learns operation hash + variable template from a POST and keeps the newest hash', () => {
    const repo = new Repo(openMemoryDb());
    const s = new SpotifySession(1, repo, 'http://x', Buffer.from('s'.repeat(40)));
    s.capture({
      url: 'https://api-partner.spotify.com/pathfinder/v2/query',
      method: 'POST',
      headers: { Authorization: 'Bearer tok', 'client-token': 'ct', 'app-platform': 'WebPlayer', cookie: 'never-kept' },
      postData: JSON.stringify({ operationName: 'searchDesktop', variables: { searchTerm: 'x', limit: 10 }, extensions: { persistedQuery: { version: 1, sha256Hash: HASH } } }),
    });
    expect(repo.op('searchDesktop')?.hash).toBe(HASH);
    expect(JSON.parse(repo.op('searchDesktop')!.variables)).toEqual({ searchTerm: 'x', limit: 10 });
    s.capture({
      url: 'https://api-partner.spotify.com/pathfinder/v2/query',
      method: 'POST',
      headers: {},
      postData: JSON.stringify({ operationName: 'searchDesktop', variables: {}, extensions: { persistedQuery: { sha256Hash: 'b'.repeat(64) } } }),
    });
    expect(repo.op('searchDesktop')?.hash).toBe('b'.repeat(64));
  });

  it('ignores malformed operation names and hashes', () => {
    const repo = new Repo(openMemoryDb());
    const s = new SpotifySession(1, repo, 'http://x', Buffer.from('s'.repeat(40)));
    s.capture({ url: 'https://api-partner.spotify.com/pathfinder/v2/query', method: 'POST', postData: JSON.stringify({ operationName: 'x; drop', extensions: { persistedQuery: { sha256Hash: HASH } } }) });
    s.capture({ url: 'https://api-partner.spotify.com/pathfinder/v2/query', method: 'POST', postData: JSON.stringify({ operationName: 'ok', extensions: { persistedQuery: { sha256Hash: 'zz' } } }) });
    s.capture({ url: 'https://api-partner.spotify.com/pathfinder/v2/query', method: 'POST', postData: '{not json' });
    expect(repo.ops()).toEqual([]);
  });

  it('derives per-instance manager tokens like the Go manager (rdf/chromium/instance/<id>)', () => {
    const a = instanceToken(Buffer.from('secret'), 1);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(a).not.toBe(instanceToken(Buffer.from('secret'), 2));
    // Same vector as chromium/manager/manager_test.go TestTokenVectors.
    expect(instanceToken(Buffer.from('testsecret-0123456789'), 1)).toBe('60e0b1d6093d655da45afa6886ecbbcddf6a392f02aaadbebb37a81a687358fd');
  });
});
