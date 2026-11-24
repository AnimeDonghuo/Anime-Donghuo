import assert from 'node:assert/strict';
import test from 'node:test';
import { findPosterSource, normalizeTitle, resolveAndCachePoster } from '../src/posters.js';

const emptyConfig = {
  animexinEnabled: true,
  animexinBaseUrl: 'https://animexin.dev',
  malClientId: null,
  tmdbApiKey: null,
  tmdbReadAccessToken: null,
  imgbbApiKey: null,
};

function jsonResponse(value) {
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
}

function donghuaMovie() {
  return { id: 'big-fish-and-begonia', title: 'Big Fish & Begonia', type: 'donghua', format: 'movie', alternativeTitles: [] };
}

test('title matching normalizes punctuation and diacritics without inventing matches', () => {
  assert.equal(normalizeTitle('  Big Fish & Begonia!  '), 'big fish and begonia');
  assert.equal(normalizeTitle('Nausicaä of the Valley of the Wind'), 'nausicaa of the valley of the wind');
});

test('donghua movie posters try Animexin before MyAnimeList', async () => {
  const calls = [];
  const fetchImpl = async (input) => {
    const url = new URL(input);
    calls.push(url.hostname);
    if (url.hostname === 'animexin.dev') {
      assert.equal(url.searchParams.get('s'), 'Big Fish & Begonia');
      return new Response('<html><body><article><h2 itemprop="headline">Another film</h2></article></body></html>', {
        headers: { 'content-type': 'text/html' },
      });
    }
    if (url.hostname === 'api.myanimelist.net') {
      return jsonResponse({ data: [{ node: {
        title: 'Big Fish & Begonia',
        media_type: 'movie',
        main_picture: { large: 'https://cdn.myanimelist.net/images/anime/1/2.jpg' },
      } }] });
    }
    throw new Error(`Unexpected provider ${url.hostname}`);
  };

  const poster = await findPosterSource(donghuaMovie(), { ...emptyConfig, malClientId: 'test-client-id' }, fetchImpl);
  assert.deepEqual(calls, ['animexin.dev', 'api.myanimelist.net']);
  assert.deepEqual(poster, {
    imageUrl: 'https://cdn.myanimelist.net/images/anime/1/2.jpg',
    source: 'mal',
  });
});

test('Animexin is not contacted unless scraping is explicitly enabled', async () => {
  const calls = [];
  const fetchImpl = async (input) => {
    const url = new URL(input);
    calls.push(url.hostname);
    if (url.hostname === 'graphql.anilist.co') return jsonResponse({ data: { Page: { media: [] } } });
    throw new Error(`Unexpected provider ${url.hostname}`);
  };
  await findPosterSource(donghuaMovie(), { ...emptyConfig, animexinEnabled: false }, fetchImpl);
  assert.equal(calls.includes('animexin.dev'), false);
});

test('Animexin scraper accepts exact movie cards and reads only poster metadata', async () => {
  const html = '<article class="bs"><h2 itemprop="headline">Big Fish &amp; Begonia</h2>'
    + '<div class="typez">Movie</div><img itemprop="image" data-src="https://cdn.animexin.dev/poster.jpg"></article>';
  const fetchImpl = async (input) => {
    const url = new URL(input);
    assert.equal(url.hostname, 'animexin.dev');
    return new Response(html, { headers: { 'content-type': 'text/html' } });
  };
  const poster = await findPosterSource(donghuaMovie(), emptyConfig, fetchImpl);
  assert.deepEqual(poster, { imageUrl: 'https://cdn.animexin.dev/poster.jpg', source: 'animexin' });
});

test('Animexin scraper handles nested div-based movie cards and nested headline markup', async () => {
  const html = '<div class="bsx"><a href="/big-fish-and-begonia">'
    + '<div class="limit"><div class="typez">Movie</div>'
    + '<img itemprop="image" src="https://cdn.animexin.dev/poster.jpg">'
    + '<div class="tt"><h2><a itemprop="headline">Big Fish &amp; Begonia</a></h2></div>'
    + '</div></a></div>';
  const fetchImpl = async () => new Response(html, { headers: { 'content-type': 'text/html' } });
  const poster = await findPosterSource(donghuaMovie(), emptyConfig, fetchImpl);
  assert.deepEqual(poster, { imageUrl: 'https://cdn.animexin.dev/poster.jpg', source: 'animexin' });
});

test('MyAnimeList is preferred over AniList when it returns an exact match', async () => {
  const calls = [];
  const fetchImpl = async (input) => {
    const url = new URL(input);
    calls.push(url.hostname);
    if (url.hostname === 'api.myanimelist.net') {
      return jsonResponse({ data: [{ node: {
        title: 'One Piece',
        media_type: 'tv',
        main_picture: { medium: 'https://cdn.myanimelist.net/images/anime/3/4.jpg' },
      } }] });
    }
    throw new Error('AniList should not be requested after an exact MAL match.');
  };
  const poster = await findPosterSource(
    { id: 'one-piece', title: 'One Piece', type: 'anime', format: 'series' },
    { ...emptyConfig, malClientId: 'test-client-id' },
    fetchImpl,
  );
  assert.equal(poster?.source, 'mal');
  assert.deepEqual(calls, ['api.myanimelist.net']);
});

test('AniList is the secondary catalogue source and TMDB is excluded for donghua series', async () => {
  const calls = [];
  const fetchImpl = async (input) => {
    const url = new URL(input);
    calls.push(url.hostname);
    if (url.hostname === 'api.myanimelist.net') return jsonResponse({ data: [] });
    if (url.hostname === 'graphql.anilist.co') {
      return jsonResponse({ data: { Page: { media: [{
        title: { romaji: 'Perfect World', english: null, native: '完美世界' },
        format: 'TV',
        countryOfOrigin: 'CN',
        coverImage: { large: 'https://s4.anilist.co/file/anime/5.jpg' },
      }] } } });
    }
    throw new Error('TMDB must not be used for a donghua series.');
  };
  const poster = await findPosterSource(
    { id: 'perfect-world', title: 'Perfect World', type: 'donghua', format: 'series' },
    { ...emptyConfig, malClientId: 'test-client-id', tmdbApiKey: 'test-tmdb-key' },
    fetchImpl,
  );
  assert.equal(poster?.source, 'anilist');
  assert.deepEqual(calls, ['api.myanimelist.net', 'graphql.anilist.co']);
});

test('TMDB is the final fallback for donghua movies', async () => {
  const calls = [];
  const fetchImpl = async (input) => {
    const url = new URL(input);
    calls.push(url.hostname);
    if (url.hostname === 'animexin.dev') {
      return new Response('<html></html>', { headers: { 'content-type': 'text/html' } });
    }
    if (url.hostname === 'graphql.anilist.co') return jsonResponse({ data: { Page: { media: [] } } });
    if (url.hostname === 'api.themoviedb.org') {
      return jsonResponse({ results: [{
        title: 'Big Fish & Begonia',
        poster_path: '/poster-1.jpg',
      }] });
    }
    throw new Error(`Unexpected provider ${url.hostname}`);
  };
  const poster = await findPosterSource(donghuaMovie(), { ...emptyConfig, tmdbApiKey: 'test-tmdb-key' }, fetchImpl);
  assert.deepEqual(calls, ['animexin.dev', 'graphql.anilist.co', 'api.themoviedb.org']);
  assert.deepEqual(poster, {
    imageUrl: 'https://image.tmdb.org/t/p/w500/poster-1.jpg',
    source: 'tmdb',
  });
});

test('poster images are uploaded to ImgBB when configured', async () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
  const calls = [];
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input);
    calls.push(url.hostname);
    if (url.hostname === 'graphql.anilist.co') {
      return jsonResponse({ data: { Page: { media: [{
        title: { romaji: 'Your Name', english: 'Your Name', native: '君の名は。' },
        format: 'MOVIE',
        countryOfOrigin: 'JP',
        coverImage: { extraLarge: 'https://s4.anilist.co/file/your-name.png' },
      }] } } });
    }
    if (url.hostname === 's4.anilist.co') {
      return new Response(png, { headers: { 'content-type': 'image/png' } });
    }
    if (url.hostname === 'api.imgbb.com') {
      assert.equal(url.searchParams.get('key'), 'test-imgbb-key');
      assert.equal(options.method, 'POST');
      assert.ok(options.body instanceof FormData);
      return jsonResponse({ success: true, data: { url: 'https://i.ibb.co/abcd/poster.png' } });
    }
    throw new Error(`Unexpected host ${url.hostname}`);
  };
  const cached = await resolveAndCachePoster(
    { id: 'your-name', title: 'Your Name', type: 'anime', format: 'movie' },
    { ...emptyConfig, imgbbApiKey: 'test-imgbb-key' },
    fetchImpl,
  );
  assert.deepEqual(calls, ['graphql.anilist.co', 's4.anilist.co', 'api.imgbb.com']);
  assert.deepEqual(cached, { imageUrl: 'https://i.ibb.co/abcd/poster.png', artworkSource: 'anilist' });
});
