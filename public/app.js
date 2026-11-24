const originalNotify = window.notify;
const originalOpenSearch = window.openSearch;
const originalCloseSearch = window.closeSearch;
const searchPanel = document.getElementById('searchPanel');
const searchInput = document.getElementById('searchInput');
const searchResults = document.getElementById('searchResults');

const state = {
  catalog: new Map(),
  featured: [],
  featuredIndex: 0,
  featuredId: null,
  featuredTimer: null,
  featuredSignature: '',
  favorites: new Set(),
  user: null,
  csrfToken: null,
  authMode: 'login',
  browse: null,
  discoveryRequestId: 0,
  scheduleDay: null,
  preferences: { preferredType: 'all', reduceMotion: false },
};
const preferenceStorageKey = 'anime-donghua:preferences';

function loadPreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem(preferenceStorageKey) || '{}');
    return {
      preferredType: ['all', 'anime', 'donghua'].includes(saved.preferredType) ? saved.preferredType : 'all',
      reduceMotion: saved.reduceMotion === true,
    };
  } catch {
    return { preferredType: 'all', reduceMotion: false };
  }
}

function applyPreferences() {
  document.documentElement.classList.toggle('reduce-motion', state.preferences.reduceMotion);
}

function persistPreferences(preferences) {
  state.preferences = {
    preferredType: ['all', 'anime', 'donghua'].includes(preferences.preferredType) ? preferences.preferredType : 'all',
    reduceMotion: preferences.reduceMotion === true,
  };
  applyPreferences();
  startFeaturedRotation();
  try {
    localStorage.setItem(preferenceStorageKey, JSON.stringify(state.preferences));
    return true;
  } catch {
    return false;
  }
}

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function makeButton(label, action, className = 'dialog-button', data = {}) {
  const button = element('button', className, label);
  button.type = 'button';
  button.dataset.action = action;
  for (const [key, value] of Object.entries(data)) button.dataset[key] = value;
  return button;
}

const allowedExternalArtworkHosts = new Set([
  'i.ibb.co',
  'cdn.myanimelist.net',
  'image.tmdb.org',
  's1.anilist.co', 's2.anilist.co', 's3.anilist.co', 's4.anilist.co',
]);

function artworkUrl(title) {
  const raw = title?.imageUrl || title?.artworkUrl || (typeof title?.artwork === 'string' ? title.artwork : title?.artwork?.url);
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 2048) return '';
  try {
    const parsed = new URL(raw, window.location.origin);
    if (parsed.username || parsed.password) return '';
    if (parsed.origin === window.location.origin && ['https:', 'http:'].includes(parsed.protocol)) return parsed.href;
    if (parsed.port || parsed.protocol !== 'https:') return '';
    const host = parsed.hostname.toLowerCase();
    const animexinHost = /(^|\.)animexin(?:\.(?:dev|vip|xyz|top)|ax\.com)$/.test(host);
    const configuredAnimexinHost = title?.artworkSource === 'animexin';
    return allowedExternalArtworkHosts.has(host) || animexinHost || configuredAnimexinHost ? parsed.href : '';
  } catch {
    return '';
  }
}

function appendArtwork(container, title, className = 'catalog-artwork') {
  const src = artworkUrl(title);
  if (!src) return false;
  const image = element('img', className);
  image.src = src;
  image.alt = className === 'hero-image' ? 'Blue dragon and hero artwork' : (title.title ? `${title.title} artwork` : 'Title artwork');
  image.loading = className === 'hero-image' ? 'eager' : 'lazy';
  if (className === 'hero-image') image.fetchPriority = 'high';
  image.decoding = 'async';
  image.addEventListener('error', () => {
    image.remove();
    container.classList.remove('has-artwork');
    const orb = container.querySelector('.hero-orb');
    if (orb) orb.hidden = false;
    if (container.classList.contains('art') && !container.querySelector('.art-label')) {
      const initials = String(title.title || '').split(/\s+/).filter(Boolean).slice(0, 3).map((word) => word.slice(0, 8)).join(' ');
      container.append(element('div', 'art-label', initials.toUpperCase()));
    }
  }, { once: true });
  container.classList.add('has-artwork');
  container.append(image);
  return true;
}

function toast(message) {
  if (typeof originalNotify === 'function') {
    originalNotify(message);
    return;
  }
  const notice = document.getElementById('toast');
  if (!notice) return;
  notice.textContent = String(message || '');
  notice.classList.add('show');
  window.clearTimeout(window.toastTimer);
  window.toastTimer = window.setTimeout(() => notice.classList.remove('show'), 2200);
}

async function csrfToken() {
  if (state.csrfToken) return state.csrfToken;
  const response = await fetch('/api/csrf', {
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || typeof data.csrfToken !== 'string') {
    throw new ApiError('The security check could not be started. Refresh the page and try again.', response.status);
  }
  state.csrfToken = data.csrfToken;
  return state.csrfToken;
}

async function request(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const headers = new Headers(options.headers || {});
  headers.set('Accept', 'application/json');
  let body = options.body;
  if (body !== undefined && body !== null && typeof body !== 'string') {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(body);
  }
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    headers.set('X-CSRF-Token', await csrfToken());
  }

  const response = await fetch(path, {
    ...options,
    method,
    body,
    headers,
    credentials: 'same-origin',
    cache: options.cache || 'default',
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(data.error || 'This request could not be completed.', response.status);
  return data;
}

function guestFavorites() {
  try {
    const values = JSON.parse(localStorage.getItem('anime-donghua:favorites') || '[]');
    return Array.isArray(values) ? values.filter((value) => typeof value === 'string').slice(0, 100) : [];
  } catch {
    return [];
  }
}

function saveGuestFavorites() {
  try {
    localStorage.setItem('anime-donghua:favorites', JSON.stringify([...state.favorites].slice(0, 100)));
  } catch {
    toast('Your browser could not save this list on this device.');
  }
}

function updateFeaturedButton() {
  const button = document.querySelector('.hero .actions .btn:not(.primary)');
  if (!button) return;
  const id = state.featuredId || button.dataset.id;
  button.dataset.id = id || '';
  button.textContent = id && state.favorites.has(id) ? '♥  My List' : '＋  My List';
}

function renderFeatured(index = state.featuredIndex) {
  const title = state.featured[index];
  if (!title) return;
  state.featuredIndex = index;
  state.featuredId = title.id;
  const hero = document.querySelector('.hero');
  const heading = hero?.querySelector('h1');
  const description = hero?.querySelector('.hero-copy > p');
  const tags = hero?.querySelector('.tags');
  const rating = hero?.querySelector('.rating');
  const artwork = hero?.querySelector('.hero-art');
  const watchButton = hero?.querySelector('.actions .btn.primary');
  const dots = hero?.querySelector('.hero-dots');
  if (!hero || !heading || !description || !tags || !rating || !artwork || !watchButton || !dots) return;

  heading.textContent = title.title;
  description.textContent = title.description || 'Discover the story, characters, and latest catalogue details.';
  rating.hidden = !Number.isFinite(title.rating);
  rating.textContent = rating.hidden ? '' : `★ ${title.rating.toFixed(1)}`;
  hero.classList.toggle('hero--anime', title.type === 'anime');
  tags.replaceChildren();
  [title.type === 'donghua' ? 'Donghua' : 'Anime', ...(title.genres || []).slice(0, 3)]
    .forEach((tag) => tags.append(element('span', 'tag', tag)));

  artwork.querySelector('.hero-image')?.remove();
  artwork.classList.remove('has-artwork');
  appendArtwork(artwork, title, 'hero-image');
  const orb = artwork.querySelector('.hero-orb');
  if (orb) orb.hidden = Boolean(artwork.querySelector('.hero-image'));
  watchButton.dataset.id = title.id;
  const listButton = hero.querySelector('.actions .btn:not(.primary)');
  if (listButton) listButton.dataset.id = title.id;

  dots.replaceChildren();
  state.featured.forEach((item, dotIndex) => {
    const dot = makeButton('', 'featured-select', 'hero-dot', { index: dotIndex });
    dot.setAttribute('aria-label', `Show featured title ${dotIndex + 1}: ${item.title}`);
    dot.setAttribute('aria-current', String(dotIndex === index));
    dots.append(dot);
  });
  updateFeaturedButton();
}

function setFeaturedTitles(items) {
  const next = (Array.isArray(items) ? items : []).slice(0, 5);
  if (!next.length) return;
  const signature = JSON.stringify(next.map((item) => [item.id, item.title, item.addedAt, item.imageUrl, item.rating]));
  if (signature === state.featuredSignature) return;
  const activeId = state.featured[state.featuredIndex]?.id;
  state.featured = next;
  state.featuredSignature = signature;
  const activeIndex = next.findIndex((item) => item.id === activeId);
  renderFeatured(activeIndex >= 0 ? activeIndex : 0);
  startFeaturedRotation();
}

function startFeaturedRotation() {
  if (state.featuredTimer) window.clearInterval(state.featuredTimer);
  if (state.featured.length < 2 || state.preferences.reduceMotion) return;
  state.featuredTimer = window.setInterval(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    renderFeatured((state.featuredIndex + 1) % state.featured.length);
  }, 7000);
}

function getDialog() {
  let dialog = document.getElementById('animeDonghuaDialog');
  if (dialog) return { dialog, content: dialog.querySelector('.dialog-content') };

  dialog = element('dialog', 'app-dialog');
  dialog.id = 'animeDonghuaDialog';
  dialog.setAttribute('aria-labelledby', 'dialogTitle');
  const close = makeButton('✕', 'close-dialog', 'dialog-close');
  close.setAttribute('aria-label', 'Close dialog');
  const content = element('div', 'dialog-content');
  dialog.append(close, content);
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  document.body.append(dialog);
  return { dialog, content };
}

function createDialog(title, subtitle = '', eyebrow = '') {
  const { dialog, content } = getDialog();
  content.replaceChildren();
  if (eyebrow) content.append(element('div', 'dialog-eyebrow', eyebrow));
  const heading = element('h2', 'dialog-title', title);
  heading.id = 'dialogTitle';
  content.append(heading);
  if (subtitle) content.append(element('p', 'dialog-subtitle', subtitle));
  if (!dialog.open) dialog.showModal();
  return { dialog, content };
}

function titleByName(name) {
  const clean = String(name || '').trim().toLowerCase();
  const aliases = {
    btth: 'battle through the heavens',
    'a record of a mortal': "a record of a mortal's journey",
    'soul land 2': 'soul land ii',
  };
  const target = aliases[clean] || clean;
  return [...state.catalog.values()].find((item) => item.title.toLowerCase() === target)
    || [...state.catalog.values()].find((item) => item.title.toLowerCase().includes(target));
}

function titleFromCard(card) {
  const name = card.querySelector('.poster-title, .continue-info strong, .update strong')?.textContent?.trim();
  return name ? titleByName(name) : null;
}

function normalizedPlayerEntries(title) {
  if (!Array.isArray(title?.players)) return [];
  return title.players.flatMap((entry) => {
    try {
      const embed = new URL(entry?.embedUrl || '');
      const watch = new URL(entry?.watchUrl || '');
      const providerFor = (host) => {
        if (host === 'dailymotion.com' || host.endsWith('.dailymotion.com') || host === 'dai.ly') return 'Dailymotion';
        if (host === 'rumble.com' || host.endsWith('.rumble.com')) return 'Rumble';
        return null;
      };
      const provider = providerFor(watch.hostname.toLowerCase());
      if (embed.protocol !== 'https:' || watch.protocol !== 'https:' || !provider
        || providerFor(embed.hostname.toLowerCase()) !== provider || embed.username || embed.password || embed.port
        || watch.username || watch.password || watch.port) return [];
      return [{ provider, embedUrl: embed.href, watchUrl: watch.href }];
    } catch {
      return [];
    }
  }).slice(0, 8);
}

function appendAuthorizedPlayers(container, title) {
  const entries = normalizedPlayerEntries(title);
  if (!entries.length) return 0;
  const list = element('div', 'stream-player-list');
  list.setAttribute('aria-label', `${title.title} authorized video players`);
  entries.forEach((entry, index) => {
    const card = element('article', 'stream-player-card');
    card.append(element('h3', 'stream-player-heading', `${entry.provider} player${entries.length > 1 ? ` ${index + 1}` : ''}`));
    const frame = document.createElement('iframe');
    frame.src = entry.embedUrl;
    frame.title = `${entry.provider} video player for ${title.title}`;
    frame.loading = 'lazy';
    frame.referrerPolicy = 'strict-origin-when-cross-origin';
    frame.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen';
    frame.allowFullscreen = true;
    card.append(frame);
    const external = element('a', 'stream-player-watch', `Open on ${entry.provider}`);
    external.href = entry.watchUrl;
    external.target = '_blank';
    external.rel = 'noopener noreferrer';
    card.append(external);
    list.append(card);
  });
  container.append(list);
  return entries.length;
}

function showTitleDetails(title) {
  const { content } = createDialog(title.title, '', title.type === 'donghua' ? 'DONGHUA' : 'ANIME');
  if (artworkUrl(title)) {
    const imageFrame = element('div', 'detail-artwork');
    appendArtwork(imageFrame, title, 'detail-artwork-image');
    content.append(imageFrame);
  }
  const meta = element('div', 'dialog-meta');
  const type = title.type === 'donghua' ? 'Donghua' : 'Anime';
  const format = title.format === 'movie' ? 'Movie' : 'Series';
  const status = title.status ? title.status[0].toUpperCase() + title.status.slice(1) : 'Catalogue';
  [
    type,
    format,
    status,
    Number.isInteger(title.year) ? String(title.year) : '',
    Number.isInteger(title.episodeCount) && title.format !== 'movie' ? `${title.episodeCount} episodes` : '',
    Number.isFinite(title.rating) ? `★ ${title.rating.toFixed(1)}` : '',
  ]
    .filter(Boolean)
    .forEach((label) => meta.append(element('span', 'dialog-chip', label)));
  content.append(meta);
  content.append(element('p', 'dialog-description', title.description || 'Explore this title in the Anime Donghua catalogue.'));

  if (title.genres?.length) {
    const genres = element('div', 'dialog-meta');
    title.genres.forEach((genre) => genres.append(element('span', 'dialog-chip', genre)));
    content.append(genres);
  }
  if (title.alternativeTitles?.length) {
    content.append(element('p', 'title-aliases', `Also known as: ${title.alternativeTitles.join(', ')}`));
  }
  if (title.languages?.length || title.subtitles?.length) {
    const languageDetails = element('div', 'title-languages');
    if (title.languages?.length) languageDetails.append(element('p', '', `Audio: ${title.languages.join(', ')}`));
    if (title.subtitles?.length) languageDetails.append(element('p', '', `Subtitles: ${title.subtitles.join(', ')}`));
    content.append(languageDetails);
  }
  if (title.latestEpisode) {
    const episode = title.latestEpisode;
    const parts = [];
    if (Number.isInteger(episode.season)) parts.push(`Season ${episode.season}`);
    if (Number.isInteger(episode.number)) parts.push(`Episode ${episode.number}`);
    if (episode.title) parts.push(episode.title);
    if (episode.releaseAt) parts.push(new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(episode.releaseAt)));
    if (parts.length) content.append(element('p', 'title-latest-episode', `Latest verified update: ${parts.join(' · ')}`));
  }
  if (title.releaseSchedule?.length) {
    const schedule = element('div', 'dialog-note');
    schedule.append(element('strong', '', 'Verified release schedule'));
    const list = element('ul', 'title-schedule-list');
    title.releaseSchedule.forEach((entry) => {
      list.append(element('li', '', `${entry.day} · ${entry.time}${Number.isInteger(entry.episode) ? ` · Episode ${entry.episode}` : ''}`));
    });
    schedule.append(list);
    content.append(schedule);
  }

  const note = element('div', 'dialog-note');
  if (normalizedPlayerEntries(title).length) {
    note.append(element('strong', '', 'Authorized player sources are available. '));
    note.append(document.createTextNode('Open the playback view to use the Dailymotion or Rumble player. Anime Donghua does not host or proxy video.'));
  } else {
    note.append(element('strong', '', 'Playback is not configured. '));
    note.append(document.createTextNode('Anime Donghua does not host or proxy video. A title can play only after an authorized streaming source is provided.'));
  }
  content.append(note);

  const actions = element('div', 'dialog-actions');
  const isSaved = state.favorites.has(title.id);
  actions.append(makeButton(isSaved ? '♥ Remove from My List' : '＋ Add to My List', 'toggle-favorite', 'dialog-button', { id: title.id }));
  actions.append(makeButton('▶ Open playback view', 'watch-title', 'dialog-button primary', { id: title.id }));
  const fullDetails = element('a', 'dialog-button', 'Full title page');
  fullDetails.href = `/title/${encodeURIComponent(title.id)}`;
  actions.append(fullDetails);
  content.append(actions);
}

function showWatch(title) {
  const { content } = createDialog(title.title, normalizedPlayerEntries(title).length ? 'Authorized playback' : 'Playback unavailable', 'PLAYER');
  const playersAdded = appendAuthorizedPlayers(content, title);
  if (!playersAdded) {
    const player = element('div', 'player-placeholder');
    player.setAttribute('role', 'status');
    player.append(element('div', 'player-symbol', '▶'));
    player.append(element('p', 'player-message', 'No authorized video source is configured for this title.'));
    content.append(player);
  }
  const note = element('div', 'dialog-note');
  if (playersAdded) {
    note.append(element('strong', '', 'Playback is provided by the authorized streaming host. '));
    note.append(document.createTextNode('Anime Donghua does not host, download, or proxy video files.'));
  } else {
    note.append(element('strong', '', 'No stream is being requested or embedded. '));
    note.append(document.createTextNode('Anime Donghua does not host or proxy video. Playback can be enabled only when an authorized provider URL is supplied.'));
  }
  content.append(note);
  content.append(makeButton('← Back to title details', 'open-title', 'dialog-button', { id: title.id }));
  const playerPage = element('a', 'dialog-button', 'Open full player page');
  playerPage.href = `/watch/${encodeURIComponent(title.id)}`;
  content.append(playerPage);
}

async function openTitle(id, mode = 'details') {
  let title = state.catalog.get(id);
  if (!title) {
    try {
      const data = await request(`/api/catalog/${encodeURIComponent(id)}`);
      title = data.item;
      state.catalog.set(title.id, title);
    } catch {
      toast('That title could not be loaded. Try again shortly.');
      return;
    }
  }
  if (mode === 'watch') showWatch(title);
  else showTitleDetails(title);
}

async function openTitleByName(name, mode = 'details') {
  let title = titleByName(name);
  if (!title) {
    try {
      const data = await request('/api/catalog?limit=48');
      state.catalog = new Map(data.items.map((item) => [item.id, item]));
      title = titleByName(name);
    } catch {
      // Show a friendly message rather than leaving a dead clickable card.
    }
  }
  if (!title) return toast('That title is not in the catalogue yet.');
  await openTitle(title.id, mode);
}

function makeBrowseItem(title) {
  const button = makeButton('', 'open-title', 'browse-item', { id: title.id });
  if (artworkUrl(title)) appendArtwork(button, title, 'browse-item-art');
  const copy = element('span', 'browse-item-copy');
  copy.append(element('strong', '', title.title));
  copy.append(element('small', '', `${title.type === 'donghua' ? 'Donghua' : 'Anime'} · ${title.format === 'movie' ? 'Movie' : 'Series'} · ${title.status}`));
  button.append(copy);
  return button;
}

function createPosterCard(title, index = 0) {
  const card = element('article', 'poster');
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `Open ${title.title} details`);
  const art = element('div', 'art');
  const hue = (index * 41 + (title.type === 'donghua' ? 205 : 285)) % 360;
  art.style.setProperty('--c1', `hsl(${hue} 48% 34%)`);
  art.style.setProperty('--c2', `hsl(${(hue + 46) % 360} 42% 13%)`);
  art.style.setProperty('--glow', `hsl(${(hue + 18) % 360} 88% 68%)`);
  if (!appendArtwork(art, title)) {
    const initials = title.title.split(/\s+/).filter(Boolean).slice(0, 3).map((word) => word.slice(0, 8)).join(' ');
    art.append(element('div', 'art-label', initials.toUpperCase()));
  }
  const info = element('div', 'poster-info');
  info.append(element('div', 'poster-title', title.title));
  const labels = [title.type === 'donghua' ? 'Donghua' : 'Anime', title.format === 'movie' ? 'Movie' : 'Series'];
  if (title.status) labels.push(title.status[0].toUpperCase() + title.status.slice(1));
  if (Number.isFinite(title.episodeCount) && title.format !== 'movie') labels.push(`${title.episodeCount} eps`);
  if (Number.isFinite(title.rating)) labels.push(`★ ${title.rating.toFixed(1)}`);
  info.append(element('div', 'poster-sub', labels.join(' · ')));
  card.append(art, info);
  return card;
}

function verifiedUpdateTitles(items = [...state.catalog.values()]) {
  return [...items]
    .filter((title) => title.latestEpisode && latestEpisodeSummary(title))
    .sort((left, right) => {
      const leftTime = Date.parse(left.latestEpisode.releaseAt || '') || 0;
      const rightTime = Date.parse(right.latestEpisode.releaseAt || '') || 0;
      return rightTime - leftTime;
    });
}

function makeUpdateCard(title) {
  const card = element('article', 'update');
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `Open ${title.title} update details`);
  const art = element('div', 'update-art');
  appendArtwork(art, title, 'catalog-artwork');
  const copy = element('div');
  copy.append(element('strong', '', title.title));
  copy.append(element('small', '', latestEpisodeSummary(title)));
  card.append(art, copy);
  return card;
}

function renderHomeUpdates(items) {
  const container = document.getElementById('updatesList');
  if (!container) return;
  const updates = verifiedUpdateTitles(items);
  container.replaceChildren();
  if (!updates.length) {
    container.append(element('div', 'catalogue-empty', 'Verified episode updates are not configured yet.'));
    return;
  }
  updates.slice(0, 3).forEach((title) => container.append(makeUpdateCard(title)));
}

function renderHomeCollections(items) {
  const sections = [
    { selector: '#trending .cards', key: 'trending' },
    { selector: '#donghua .cards', key: 'donghua' },
    { selector: '#anime .cards', key: 'anime' },
  ];
  sections.forEach(({ selector, key }) => {
    const grid = document.querySelector(selector);
    if (!grid) return;
    const titles = items.filter((title) => title.sections?.includes(key)).slice(0, 6);
    const additions = [];
    titles.forEach((title, index) => {
      const existing = [...grid.querySelectorAll('.poster')].find((card) => {
        const name = card.querySelector('.poster-title')?.textContent?.trim();
        return name && titleByName(name)?.id === title.id;
      });
      if (existing) {
        if (artworkUrl(title)) existing.replaceWith(createPosterCard(title, index));
        return;
      }
      additions.push({ title, index });
    });
    additions.reverse().forEach(({ title, index }) => {
      if (grid.children.length >= 6) grid.lastElementChild.remove();
      grid.prepend(createPosterCard(title, index));
    });
  });
}

function filterButton(label, key, value, selected) {
  const button = makeButton(label, 'browse-filter', 'browse-filter', { key, value });
  button.setAttribute('aria-pressed', String((selected || '') === value));
  return button;
}

async function showBrowse(options = {}) {
  state.browse = {
    heading: options.heading || 'Browse catalogue',
    filters: { ...(options.filters || {}) },
    categories: Boolean(options.categories),
  };
  await renderBrowse();
}

async function renderBrowse() {
  if (!state.browse) return;
  const context = state.browse;
  const { content } = createDialog(context.heading, 'Browse the catalogue by type, format, status, or genre.');
  const filterRow = element('div', 'browse-filters');
  const definitions = [
    ['All', 'type', ''], ['Anime', 'type', 'anime'], ['Donghua', 'type', 'donghua'],
    ['Series', 'format', 'series'], ['Movies', 'format', 'movie'],
    ['Ongoing', 'status', 'ongoing'], ['Completed', 'status', 'completed'],
  ];
  definitions.forEach(([label, key, value]) => filterRow.append(filterButton(label, key, value, context.filters[key])));
  if (context.categories) {
    const genres = [...new Set([...state.catalog.values()].flatMap((item) => item.genres || []))].sort((a, b) => a.localeCompare(b));
    genres.forEach((genre) => filterRow.append(filterButton(genre, 'genre', genre, context.filters.genre)));
  }
  content.append(filterRow);
  const results = element('div', 'browse-grid');
  results.append(element('p', 'dialog-loading', 'Loading titles…'));
  content.append(results);

  const params = new URLSearchParams({ limit: '48' });
  Object.entries(context.filters).forEach(([key, value]) => { if (value) params.set(key, value); });
  try {
    const data = await request(`/api/catalog?${params.toString()}`);
    if (!document.getElementById('animeDonghuaDialog')?.open || state.browse !== context) return;
    results.replaceChildren();
    if (!data.items.length) {
      results.className = 'dialog-empty';
      results.textContent = context.filters.format === 'movie' ? 'No movies match these filters yet.' : 'No titles match these filters.';
      return;
    }
    data.items.forEach((title) => {
      state.catalog.set(title.id, title);
      results.append(makeBrowseItem(title));
    });
  } catch (error) {
    if (state.browse !== context) return;
    results.className = 'dialog-empty';
    results.textContent = error.message || 'The catalogue could not be loaded.';
  }
}

function showMyList() {
  const { content } = createDialog('My List', 'Your saved anime and donghua are gathered here.');
  if (!state.favorites.size) {
    content.append(element('div', 'dialog-empty', 'Your list is empty. Open a title and choose “Add to My List” to save it here.'));
    content.append(makeButton('Explore featured titles', 'browse-section', 'dialog-button primary', { section: 'trending' }));
    if (!state.user) {
      content.append(element('p', 'form-help', 'Sign in to sync your list across devices.'));
      content.append(makeButton('Sign in', 'account', 'dialog-button'));
    }
    return;
  }
  const grid = element('div', 'browse-grid');
  state.favorites.forEach((id) => {
    const title = state.catalog.get(id);
    if (title) grid.append(makeBrowseItem(title));
  });
  content.append(grid);
  if (!state.user) {
    content.append(element('p', 'form-help', 'This list is saved on this device. Sign in to sync it across devices.'));
    content.append(makeButton('Sign in to sync', 'account', 'dialog-button'));
  }
}

function latestEpisodeSummary(title) {
  const episode = title.latestEpisode;
  if (!episode) return '';
  const parts = [];
  if (Number.isInteger(episode.season)) parts.push(`Season ${episode.season}`);
  if (Number.isInteger(episode.number)) parts.push(`Episode ${episode.number}`);
  if (episode.title) parts.push(episode.title);
  if (episode.releaseAt) parts.push(new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(episode.releaseAt)));
  return parts.join(' · ');
}

function showUpdates() {
  const { content } = createDialog('Latest updates', 'Episode information is shown only when verified metadata is available.');
  const grid = element('div', 'browse-grid');
  const updates = [...state.catalog.values()]
    .filter((title) => title.latestEpisode && latestEpisodeSummary(title))
    .sort((left, right) => new Date(right.latestEpisode.releaseAt || 0) - new Date(left.latestEpisode.releaseAt || 0));
  updates.forEach((title) => {
    const row = makeBrowseItem(title);
    const summary = row.querySelector('small');
    if (summary) summary.textContent = latestEpisodeSummary(title);
    grid.append(row);
  });
  if (!grid.childElementCount) grid.append(element('div', 'dialog-empty', 'No verified episode updates are available yet.'));
  content.append(grid);
}

function showNotifications() {
  const { content } = createDialog('Notifications', 'Updates will appear here when a verified release feed is connected.');
  content.append(element('div', 'dialog-empty', 'There are no verified release notifications right now.'));
}

function showAccount() {
  if (!state.user) return showAuth('login');
  const { content } = createDialog('Your account', 'Your Anime Donghua account and saved titles.');
  const profile = element('div', 'profile-card');
  profile.append(element('div', 'profile-name', state.user.displayName || 'Anime Donghua fan'));
  profile.append(element('div', 'profile-email', state.user.email || ''));
  content.append(profile);
  const actions = element('div', 'dialog-actions');
  actions.append(makeButton(`My List (${state.favorites.size})`, 'my-list', 'dialog-button primary'));
  actions.append(makeButton('Profile & preferences', 'navigate', 'dialog-button', { path: '/profile' }));
  actions.append(makeButton('Sign out', 'logout', 'dialog-button'));
  content.append(actions);
}

function showAuth(mode = 'login') {
  state.authMode = mode === 'register' ? 'register' : 'login';
  const isRegister = state.authMode === 'register';
  const { content } = createDialog(isRegister ? 'Create your account' : 'Welcome back', 'Sync your saved list across devices and personalize discovery on this browser.', 'ANIME DONGHUA ACCOUNT');
  content.innerHTML += `
    <div class="auth-tabs" role="tablist" aria-label="Account access">
      <button type="button" class="auth-tab" role="tab" aria-selected="${!isRegister}" data-action="auth-mode" data-mode="login">Sign in</button>
      <button type="button" class="auth-tab" role="tab" aria-selected="${isRegister}" data-action="auth-mode" data-mode="register">Create account</button>
    </div>
    <form id="authForm" class="auth-form" novalidate>
      ${isRegister ? '<label class="form-field">Display name <span class="form-help">Optional, up to 50 characters.</span><input name="displayName" type="text" autocomplete="nickname" maxlength="50"></label>' : ''}
      <label class="form-field">Email address<input name="email" type="email" autocomplete="email" maxlength="254" required></label>
      <label class="form-field">Password<input name="password" type="password" autocomplete="${isRegister ? 'new-password' : 'current-password'}" minlength="${isRegister ? '12' : '1'}" maxlength="256" required></label>
      ${isRegister ? '<p class="form-help">Use at least 12 characters. A long passphrase is easiest to remember.</p>' : ''}
      <p class="form-error" id="authMessage" role="alert"></p>
      <button class="dialog-button primary" type="submit">${isRegister ? 'Create account' : 'Sign in'}</button>
    </form>
    <p class="form-help">Passwords are never stored in plain text. Email and display name are encrypted before being saved.</p>
  `;
  content.querySelector('input[name="email"]')?.focus();
}

async function submitAuth(form) {
  const values = Object.fromEntries(new FormData(form).entries());
  const message = document.getElementById('authMessage');
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  submit.textContent = state.authMode === 'register' ? 'Creating account…' : 'Signing in…';
  try {
    const data = await request(`/api/auth/${state.authMode}`, { method: 'POST', body: values });
    state.user = data.user;
    await syncGuestFavorites();
    document.getElementById('animeDonghuaDialog')?.close();
    await renderCurrentPage();
    toast(state.authMode === 'register' ? 'Your account is ready.' : 'You are signed in.');
  } catch (error) {
    message.textContent = error.message || 'Unable to complete sign in.';
    submit.disabled = false;
    submit.textContent = state.authMode === 'register' ? 'Create account' : 'Sign in';
  }
}

async function toggleFavorite(id) {
  if (!state.catalog.has(id)) return toast('That title is not available in the catalogue.');
  const wasSaved = state.favorites.has(id);
  if (state.user) {
    try {
      const result = wasSaved
        ? await request(`/api/me/favorites/${encodeURIComponent(id)}`, { method: 'DELETE' })
        : await request('/api/me/favorites', { method: 'POST', body: { titleId: id } });
      state.favorites = new Set(result.favorites);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        saveGuestFavorites();
        state.user = null;
        return toggleFavorite(id);
      }
      return toast(error.message || 'Your list could not be updated.');
    }
  } else {
    if (wasSaved) state.favorites.delete(id);
    else if (state.favorites.size < 100) state.favorites.add(id);
    else return toast('Your list can contain up to 100 titles.');
    saveGuestFavorites();
  }
  updateFeaturedButton();
  const dialog = document.getElementById('animeDonghuaDialog');
  if (dialog?.open && dialog.querySelector('[data-action="toggle-favorite"]')) {
    const title = state.catalog.get(id);
    if (title) showTitleDetails(title);
  }
  if (normalizedPath() === '/my-list' || normalizedPath() === '/profile') await renderCurrentPage();
  toast(wasSaved ? 'Removed from My List.' : 'Added to My List.');
}

async function syncGuestFavorites() {
  const local = guestFavorites().filter((id) => state.catalog.has(id));
  if (!state.user) {
    state.favorites = new Set(local);
    updateFeaturedButton();
    return;
  }
  try {
    const current = await request('/api/me/favorites');
    let favorites = new Set(current.favorites);
    for (const id of local) {
      if (favorites.has(id) || favorites.size >= 100) continue;
      const result = await request('/api/me/favorites', { method: 'POST', body: { titleId: id } });
      favorites = new Set(result.favorites);
    }
    state.favorites = favorites;
    localStorage.removeItem('anime-donghua:favorites');
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) state.user = null;
    state.favorites = new Set(local);
  }
  updateFeaturedButton();
}

function search(query) {
  searchResults.replaceChildren();
  const clean = String(query || '').trim().toLowerCase();
  if (!clean) {
    searchResults.append(element('p', 'search-hint', 'Start typing to search the catalogue.'));
    return;
  }
  const matches = [...state.catalog.values()]
    .filter((item) => `${item.title} ${(item.alternativeTitles || []).join(' ')} ${(item.genres || []).join(' ')} ${item.description || ''}`.toLowerCase().includes(clean))
    .slice(0, 12);
  if (!matches.length) {
    searchResults.append(element('p', 'search-hint', 'No titles match your search. Try another name or genre.'));
    return;
  }
  matches.forEach((title) => {
    const button = makeButton('', 'open-title', 'search-result', { id: title.id });
    const details = element('span');
    details.append(element('strong', '', title.title));
    details.append(element('small', '', `${title.type === 'donghua' ? 'Donghua' : 'Anime'} · ${title.format === 'movie' ? 'Movie' : 'Series'}`));
    button.append(details, element('span', 'favorite-mark', state.favorites.has(title.id) ? '♥' : '›'));
    searchResults.append(button);
  });
}

function showNotificationAction(message) {
  const actions = {
    'Connect this button to your video player': () => openTitle('perfect-world', 'watch'),
    'Added to your list (demo)': () => toggleFavorite('perfect-world'),
    'Continue watching page': () => window.location.assign('/continue-watching'),
    'More trending titles': () => showBrowse({ heading: 'Featured titles', filters: { section: 'trending' } }),
    'Perfect World selected': () => openTitle('perfect-world'),
    'BTTH selected': () => openTitle('battle-through-the-heavens'),
    'Soul Land selected': () => openTitle('soul-land'),
    'One Piece selected': () => openTitle('one-piece'),
    'Jujutsu Kaisen selected': () => openTitle('jujutsu-kaisen'),
    'Demon Slayer selected': () => openTitle('demon-slayer'),
    'Donghua category': () => showBrowse({ heading: 'Popular donghua', filters: { type: 'donghua' } }),
    'Anime category': () => showBrowse({ heading: 'Popular anime', filters: { type: 'anime' } }),
    'All latest episodes': showUpdates,
    'No new notifications': showNotifications,
    'Profile page coming soon': () => window.location.assign('/profile'),
  };
  const action = actions[message];
  if (action) void Promise.resolve(action()).catch((error) => toast(error.message || 'This action could not be completed.'));
  else toast(message);
}

window.notify = showNotificationAction;
window.filterTitles = search;
window.openSearch = function openSearchWithResults() {
  if (typeof originalOpenSearch === 'function') originalOpenSearch();
  else searchPanel.classList.add('open');
  searchPanel.setAttribute('role', 'dialog');
  searchPanel.setAttribute('aria-modal', 'true');
  searchPanel.setAttribute('aria-labelledby', 'searchHeading');
  search(searchInput.value);
  searchInput.focus();
};
window.closeSearch = function closeSearchWithState() {
  if (typeof originalCloseSearch === 'function') originalCloseSearch();
  else searchPanel.classList.remove('open');
  searchPanel.removeAttribute('aria-modal');
};

async function handleAction(button) {
  const { action, id, key, value } = button.dataset;
  switch (action) {
    case 'close-dialog':
      document.getElementById('animeDonghuaDialog')?.close();
      break;
    case 'featured-select':
      renderFeatured(Number(button.dataset.index));
      break;
    case 'schedule-day':
      selectScheduleDay(button.dataset.day);
      break;
    case 'navigate':
      if (button.dataset.path?.startsWith('/')) window.location.assign(button.dataset.path);
      break;
    case 'open-title':
      window.closeSearch();
      await openTitle(id);
      break;
    case 'watch-title':
      await openTitle(id, 'watch');
      break;
    case 'toggle-favorite':
      await toggleFavorite(id);
      break;
    case 'my-list':
      showMyList();
      break;
    case 'account':
      showAccount();
      break;
    case 'logout':
      await request('/api/auth/logout', { method: 'POST' });
      saveGuestFavorites();
      state.user = null;
      state.favorites = new Set(guestFavorites());
      updateFeaturedButton();
      document.getElementById('animeDonghuaDialog')?.close();
      await renderCurrentPage();
      toast('You have signed out.');
      break;
    case 'auth-mode':
      showAuth(button.dataset.mode);
      break;
    case 'browse-section':
      await showBrowse({ heading: 'Featured titles', filters: { section: button.dataset.section } });
      break;
    case 'browse-filter': {
      if (!state.browse) break;
      const filters = { ...state.browse.filters };
      if (!value || filters[key] === value) delete filters[key];
      else filters[key] = value;
      if (key === 'type' || key === 'format') delete filters.section;
      await showBrowse({ ...state.browse, filters });
      break;
    }
    default:
      break;
  }
}

document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;

  if (target.closest('.icon-btn[aria-label="Search"]')) {
    event.preventDefault();
    event.stopImmediatePropagation();
    window.openSearch();
    return;
  }
  if (target.closest('.icon-btn[aria-label="Notifications"]')) {
    event.preventDefault();
    event.stopImmediatePropagation();
    showNotifications();
    return;
  }
  if (target.closest('.close-search')) {
    event.preventDefault();
    event.stopImmediatePropagation();
    window.closeSearch();
    return;
  }

  const actionButton = target.closest('[data-action]');
  if (actionButton) {
    event.preventDefault();
    event.stopImmediatePropagation();
    void handleAction(actionButton).catch((error) => toast(error.message || 'This action could not be completed.'));
    return;
  }

  const card = target.closest('.poster, .continue-card, .update');
  if (card) {
    event.preventDefault();
    event.stopImmediatePropagation();
    const title = titleFromCard(card);
    const name = card.querySelector('.poster-title, .continue-info strong, .update strong')?.textContent?.trim();
    if (title) void openTitle(title.id).catch((error) => toast(error.message || 'This title could not be opened.'));
    else if (name) void openTitleByName(name).catch((error) => toast(error.message || 'This title could not be opened.'));
    return;
  }

  if (target.closest('.avatar')) {
    event.preventDefault();
    event.stopImmediatePropagation();
    showAccount();
    return;
  }

}, true);

document.addEventListener('keydown', (event) => {
  const card = event.target instanceof Element ? event.target.closest('.poster, .continue-card, .update, .avatar') : null;
  if (!card || (event.key !== 'Enter' && event.key !== ' ')) return;
  event.preventDefault();
  if (card.matches('.avatar')) return showAccount();
  const title = titleFromCard(card);
  const name = card.querySelector('.poster-title, .continue-info strong, .update strong')?.textContent?.trim();
  if (title) void openTitle(title.id).catch((error) => toast(error.message || 'This title could not be opened.'));
  else if (name) void openTitleByName(name).catch((error) => toast(error.message || 'This title could not be opened.'));
}, true);

document.addEventListener('input', (event) => {
  if (event.target === searchInput) search(searchInput.value);
});

searchPanel.addEventListener('click', (event) => {
  if (event.target === searchPanel) window.closeSearch();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && searchPanel.classList.contains('open')) window.closeSearch();
});

document.addEventListener('submit', (event) => {
  if (event.target.id === 'authForm') {
    event.preventDefault();
    void submitAuth(event.target);
  } else if (event.target.id === 'preferencesForm') {
    event.preventDefault();
    savePreferencesForm(event.target);
  } else if (event.target.id === 'discoveryFilters') {
    event.preventDefault();
    void loadDiscovery(event.target);
  }
});

function enableCardKeyboard() {
  document.querySelectorAll('.poster, .continue-card, .update').forEach((card) => {
    if (!card.hasAttribute('tabindex')) card.tabIndex = 0;
    if (!card.hasAttribute('role')) card.setAttribute('role', 'button');
  });
  const avatar = document.querySelector('.avatar');
  if (avatar) {
    avatar.tabIndex = 0;
    avatar.setAttribute('role', 'button');
    avatar.setAttribute('aria-label', 'Open account');
  }
}

function discoveryField(labelText, control) {
  const label = element('label', 'discovery-field');
  label.append(element('span', '', labelText), control);
  return label;
}

function appendSelectField(form, labelText, name, options, selectedValue = '') {
  const select = element('select', '');
  select.name = name;
  select.id = `discovery-${name}`;
  options.forEach(([value, label]) => {
    const option = element('option', '', label);
    option.value = value;
    select.append(option);
  });
  const selected = options.find(([value]) => String(value).toLowerCase() === String(selectedValue).toLowerCase());
  select.value = selected ? selected[0] : options[0][0];
  form.append(discoveryField(labelText, select));
}

function makeDiscoveryForm() {
  const params = new URLSearchParams(window.location.search);
  const form = element('form', 'discovery-filters');
  form.id = 'discoveryFilters';
  const query = element('input');
  query.type = 'search';
  query.name = 'q';
  query.id = 'discovery-query';
  query.maxLength = 100;
  query.autocomplete = 'off';
  query.value = params.get('q') || '';
  form.append(discoveryField('Search titles, genres, or descriptions', query));

  const preferredType = state.preferences.preferredType === 'all' ? '' : state.preferences.preferredType;
  appendSelectField(form, 'Type', 'type', [['', 'All types'], ['anime', 'Anime'], ['donghua', 'Donghua']], params.has('type') ? params.get('type') : preferredType);
  appendSelectField(form, 'Format', 'format', [['', 'All formats'], ['series', 'Series'], ['movie', 'Movies']], params.get('format') || '');
  appendSelectField(form, 'Status', 'status', [['', 'Any status'], ['ongoing', 'Ongoing'], ['completed', 'Completed']], params.get('status') || '');
  const genres = [...new Set([...state.catalog.values()].flatMap((title) => title.genres || []))].sort((left, right) => left.localeCompare(right));
  appendSelectField(form, 'Genre', 'genre', [['', 'All genres'], ...genres.map((genre) => [genre, genre])], params.get('genre') || '');

  const year = element('input');
  year.type = 'number';
  year.name = 'year';
  year.id = 'discovery-year';
  year.min = '1900';
  year.max = '2100';
  year.step = '1';
  year.inputMode = 'numeric';
  const requestedYear = params.get('year') || '';
  year.value = /^\d{4}$/.test(requestedYear) && Number(requestedYear) >= 1900 && Number(requestedYear) <= 2100 ? requestedYear : '';
  form.append(discoveryField('Release year', year));

  const submit = element('button', 'dialog-button primary', 'Apply filters');
  submit.type = 'submit';
  form.append(submit);
  return form;
}

async function loadDiscovery(form) {
  const results = document.getElementById('discoveryResults');
  const count = document.getElementById('discoveryCount');
  if (!results || !count) return;
  const params = new URLSearchParams({ limit: '48' });
  const submitted = new FormData(form);
  for (const key of ['q', 'type', 'format', 'status', 'genre', 'year']) {
    const value = String(submitted.get(key) || '').trim();
    if (value) params.set(key, value);
  }
  const filters = new URLSearchParams(params);
  filters.delete('limit');
  const queryString = filters.toString();
  window.history.replaceState({}, '', `${window.location.pathname}${queryString ? `?${queryString}` : ''}`);

  const requestId = (state.discoveryRequestId || 0) + 1;
  state.discoveryRequestId = requestId;
  results.replaceChildren(element('p', 'dialog-loading', 'Loading catalogue…'));
  count.textContent = 'Loading results';
  try {
    const data = await request(`/api/catalog?${params.toString()}`);
    if (requestId !== state.discoveryRequestId || !results.isConnected) return;
    data.items.forEach((title) => state.catalog.set(title.id, title));
    count.textContent = `${data.total} ${data.total === 1 ? 'title' : 'titles'} found`;
    results.replaceChildren();
    if (!data.items.length) {
      emptyPage(results, 'No titles match these filters. Try changing or clearing a filter.');
      return;
    }
    const grid = element('div', 'cards');
    data.items.forEach((title, index) => grid.append(createPosterCard(title, index)));
    results.append(grid);
  } catch (error) {
    if (requestId !== state.discoveryRequestId || !results.isConnected) return;
    count.textContent = 'Catalogue unavailable';
    emptyPage(results, error.message || 'The catalogue could not be loaded. Please try again.');
  }
}

function renderDiscoveryPage(container) {
  pageHeader(container, 'Discover', 'Filter the catalogue by title, format, status, genre, or release year.');
  container.append(makeDiscoveryForm());
  const count = element('p', 'discovery-count', 'Loading results');
  count.id = 'discoveryCount';
  count.setAttribute('role', 'status');
  container.append(count);
  const results = element('div', 'discovery-results');
  results.id = 'discoveryResults';
  container.append(results);
  void loadDiscovery(document.getElementById('discoveryFilters'));
}

const scheduleDays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function renderScheduleDay(day) {
  const container = document.getElementById('scheduleResults');
  if (!container) return;
  container.replaceChildren();
  const entries = [...state.catalog.values()].flatMap((title) =>
    (title.releaseSchedule || [])
      .filter((entry) => entry.day.toLowerCase() === day.toLowerCase())
      .map((entry) => ({ title, entry })),
  );
  entries.sort((left, right) => left.entry.time.localeCompare(right.entry.time));
  if (!entries.length) {
    emptyPage(container, `No verified weekly releases are listed for ${day}.`);
    return;
  }
  const list = element('div', 'schedule-list');
  entries.forEach(({ title, entry }) => {
    const row = element('article', 'schedule-item');
    const copy = element('div', 'schedule-item-copy');
    const link = element('a', 'schedule-title', title.title);
    link.href = `/title/${encodeURIComponent(title.id)}`;
    copy.append(link);
    const detail = [entry.time];
    if (Number.isInteger(entry.episode)) detail.push(`Episode ${entry.episode}`);
    copy.append(element('p', 'schedule-item-meta', detail.join(' · ')));
    row.append(copy);
    list.append(row);
  });
  container.append(list);
}

function selectScheduleDay(day) {
  if (!scheduleDays.includes(day)) return;
  state.scheduleDay = day;
  document.querySelectorAll('.schedule-day').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.day === day));
  });
  renderScheduleDay(day);
}

function renderSchedulePage(container) {
  pageHeader(container, 'Release Schedule', 'Browse weekly releases and dated announcements when verified schedule data is available.');
  const today = new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(new Date());
  if (!scheduleDays.includes(state.scheduleDay)) state.scheduleDay = today;
  const dayGroup = element('div', 'schedule-days');
  dayGroup.setAttribute('role', 'group');
  dayGroup.setAttribute('aria-label', 'Choose a day of the week');
  scheduleDays.forEach((day) => {
    const button = makeButton(day, 'schedule-day', 'schedule-day', { day });
    button.setAttribute('aria-pressed', String(state.scheduleDay === day));
    dayGroup.append(button);
  });
  container.append(dayGroup);
  const weeklyHeading = element('h2', 'schedule-subhead', 'Weekly releases');
  container.append(weeklyHeading);
  const results = element('div', 'schedule-results');
  results.id = 'scheduleResults';
  container.append(results);
  renderScheduleDay(state.scheduleDay);

  const now = Date.now();
  const upcoming = [...state.catalog.values()]
    .filter((title) => Number.isFinite(Date.parse(title.upcomingReleaseAt || '')) && Date.parse(title.upcomingReleaseAt) >= now)
    .sort((left, right) => Date.parse(left.upcomingReleaseAt) - Date.parse(right.upcomingReleaseAt));
  if (upcoming.length) {
    const section = element('section', 'schedule-upcoming');
    section.append(element('h2', 'schedule-subhead', 'Dated releases'));
    const list = element('div', 'schedule-list');
    const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    upcoming.forEach((title) => {
      const row = element('article', 'schedule-item');
      const copy = element('div', 'schedule-item-copy');
      const link = element('a', 'schedule-title', title.title);
      link.href = `/title/${encodeURIComponent(title.id)}`;
      copy.append(link, element('p', 'schedule-item-meta', `${dateFormat.format(new Date(title.upcomingReleaseAt))} · Device time zone`));
      row.append(copy);
      list.append(row);
    });
    section.append(list);
    container.append(section);
  }
}

function makePreferencesForm() {
  const section = element('section', 'preferences-panel');
  section.append(element('h2', 'schedule-subhead', 'Discovery preferences'));
  section.append(element('p', 'route-page-copy', 'Choose the default content filter and motion behavior for this browser.'));
  const form = element('form', 'preferences-form');
  form.id = 'preferencesForm';
  const select = element('select');
  select.name = 'preferredType';
  select.id = 'preferredType';
  [['all', 'All titles'], ['anime', 'Anime'], ['donghua', 'Donghua']].forEach(([value, label]) => {
    const option = element('option', '', label);
    option.value = value;
    select.append(option);
  });
  select.value = state.preferences.preferredType;
  form.append(discoveryField('Default discovery type', select));

  const motionLabel = element('label', 'preference-check');
  const motion = element('input');
  motion.type = 'checkbox';
  motion.name = 'reduceMotion';
  motion.checked = state.preferences.reduceMotion;
  motionLabel.append(motion, element('span', '', 'Reduce animations and automatic carousel movement'));
  form.append(motionLabel);
  const submit = element('button', 'dialog-button primary', 'Save preferences');
  submit.type = 'submit';
  form.append(submit);
  section.append(form);
  const status = element('p', 'preferences-status', 'Preferences are stored in this browser only. They are not uploaded or synced with your account.');
  status.setAttribute('role', 'status');
  section.append(status);
  return section;
}

function savePreferencesForm(form) {
  const status = form.closest('.preferences-panel')?.querySelector('.preferences-status');
  const saved = persistPreferences({
    preferredType: form.elements.namedItem('preferredType')?.value,
    reduceMotion: form.elements.namedItem('reduceMotion')?.checked,
  });
  if (saved) {
    if (status) status.textContent = 'Preferences saved in this browser only; they are not synced with your account.';
    toast('Preferences saved.');
  } else {
    if (status) status.textContent = 'This browser could not store your preferences. They will not persist after you leave.';
    toast('Preferences could not be saved in this browser.');
  }
}

const pageDefinitions = {
  '/trending': { title: 'Featured Titles', description: 'A curated catalogue selection. Live popularity rankings are not configured.', filters: { section: 'trending' } },
  '/donghua': { title: 'Donghua', description: 'Explore Chinese animation series and films in the catalogue.', filters: { type: 'donghua' } },
  '/anime': { title: 'Anime', description: 'Browse anime series and movies in the catalogue.', filters: { type: 'anime' } },
  '/ongoing': { title: 'Ongoing Series', description: 'Browse series currently marked as ongoing in the catalogue.', filters: { status: 'ongoing' } },
  '/movies': { title: 'Movies', description: 'Anime and donghua films in the catalogue.', filters: { format: 'movie' } },
};

function normalizedPath() {
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  return path === '/index.html' ? '/' : path;
}

function updateActiveNavigation(path) {
  const discoveryPaths = ['/trending', '/ongoing', '/categories', '/continue-watching'];
  const activePath = path.startsWith('/genre/') || path.startsWith('/title/') || path.startsWith('/watch/') || discoveryPaths.includes(path)
    ? '/discover'
    : path;
  document.querySelectorAll('[data-route]').forEach((link) => {
    const active = link.dataset.route === path || link.dataset.route === activePath;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
}

function pageHeader(container, title, description) {
  const header = element('div', 'route-page-header');
  const copy = element('div');
  copy.append(element('h1', 'route-page-title', title));
  copy.append(element('p', 'route-page-copy', description));
  header.append(copy);
  container.append(header);
}

function emptyPage(container, message) {
  container.append(element('div', 'route-page-empty', message));
}

function makePageGrid(container, titles) {
  if (!titles.length) {
    emptyPage(container, 'There are no titles in this section yet. Please check back soon.');
    return;
  }
  const grid = element('div', 'cards');
  titles.forEach((title, index) => grid.append(createPosterCard(title, index)));
  container.append(grid);
}

function slugifyGenre(genre) {
  return genre.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function renderTitlePage(container, title) {
  pageHeader(container, title.title, title.type === 'donghua' ? 'Donghua title details' : 'Anime title details');
  const layout = element('div', 'title-page-layout');
  const artwork = element('div', 'title-page-art');
  if (artworkUrl(title)) appendArtwork(artwork, title, 'title-page-image');
  else artwork.append(element('span', 'title-page-placeholder', title.title));

  const copy = element('div', 'title-page-copy');
  const meta = element('div', 'dialog-meta');
  const facts = [
    title.type === 'donghua' ? 'Donghua' : 'Anime',
    title.format === 'movie' ? 'Movie' : 'Series',
    title.status ? `${title.status[0].toUpperCase()}${title.status.slice(1)}` : '',
    Number.isInteger(title.year) ? String(title.year) : '',
    Number.isInteger(title.episodeCount) && title.format !== 'movie' ? `${title.episodeCount} episodes` : '',
    Number.isFinite(title.rating) ? `★ ${title.rating.toFixed(1)}` : '',
  ].filter(Boolean);
  facts.forEach((fact) => meta.append(element('span', 'dialog-chip', fact)));
  copy.append(meta);
  copy.append(element('p', 'title-page-description', title.description || 'No verified synopsis is available yet.'));

  if (title.alternativeTitles?.length) copy.append(element('p', 'title-aliases', `Also known as: ${title.alternativeTitles.join(', ')}`));
  if (title.genres?.length) {
    const genres = element('div', 'dialog-meta');
    title.genres.forEach((genre) => {
      const link = element('a', 'dialog-chip title-genre-link', genre);
      link.href = `/genre/${encodeURIComponent(slugifyGenre(genre))}`;
      genres.append(link);
    });
    copy.append(genres);
  }
  if (title.languages?.length) copy.append(element('p', 'title-info-line', `Audio: ${title.languages.join(', ')}`));
  if (title.subtitles?.length) copy.append(element('p', 'title-info-line', `Subtitles: ${title.subtitles.join(', ')}`));
  if (title.latestEpisode) {
    const summary = latestEpisodeSummary(title);
    if (summary) copy.append(element('p', 'title-info-line', `Latest verified update: ${summary}`));
  }
  if (title.upcomingReleaseAt) {
    const upcomingFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    copy.append(element('p', 'title-info-line', `Upcoming release: ${upcomingFormat.format(new Date(title.upcomingReleaseAt))} · Device time zone`));
  }
  if (title.releaseSchedule?.length) {
    const schedule = element('div', 'title-schedule');
    schedule.append(element('h2', 'schedule-subhead', 'Verified weekly schedule'));
    const list = element('ul');
    title.releaseSchedule.forEach((entry) => {
      list.append(element('li', '', `${entry.day} · ${entry.time}${Number.isInteger(entry.episode) ? ` · Episode ${entry.episode}` : ''}`));
    });
    schedule.append(list);
    copy.append(schedule);
  }

  const note = element('div', 'dialog-note');
  note.append(element('strong', '', 'Playback is not configured. '));
  note.append(document.createTextNode('No authorized stream is attached to this title. Anime Donghua does not host or proxy video.'));
  copy.append(note);
  const actions = element('div', 'dialog-actions');
  if (title.downloadUrl) {
    const download = element('a', 'dialog-button', 'Owner-provided download');
    download.href = title.downloadUrl;
    download.target = '_blank';
    download.rel = 'noopener noreferrer';
    actions.append(download);
  }
  actions.append(makeButton('View playback status', 'navigate', 'dialog-button primary', { path: `/watch/${encodeURIComponent(title.id)}` }));
  actions.append(makeButton(state.favorites.has(title.id) ? '♥ Remove from My List' : '＋ Add to My List', 'toggle-favorite', 'dialog-button', { id: title.id }));
  copy.append(actions);
  layout.append(artwork, copy);
  container.append(layout);
}

function renderWatchPage(container, title) {
  pageHeader(container, title.title, 'Playback status');
  const player = element('section', 'player-page');
  player.setAttribute('aria-label', `Playback for ${title.title}`);
  const hasArtwork = Boolean(artworkUrl(title));
  const count = appendAuthorizedPlayers(player, title);
  if (!count) {
    player.classList.toggle('has-artwork', hasArtwork);
    player.setAttribute('aria-label', `Playback availability for ${title.title}`);
    if (hasArtwork) {
      const poster = element('div', 'player-page-art');
      appendArtwork(poster, title, 'player-page-image');
      player.append(poster);
    }
    const status = element('div', 'player-page-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.append(element('div', 'player-symbol', '▶'));
    status.append(element('h2', 'schedule-subhead', 'Playback unavailable'));
    status.append(element('p', '', 'No authorized video source is configured for this title.'));
    player.append(status);
  }
  container.append(player);

  const note = element('div', 'dialog-note player-page-note');
  if (count) {
    note.append(element('strong', '', `${count} authorized player${count === 1 ? '' : 's'} available. `));
    note.append(document.createTextNode('Playback is delivered by Dailymotion or Rumble; Anime Donghua does not host or proxy video.'));
  } else {
    note.append(element('strong', '', 'This is not a playable stream. '));
    note.append(document.createTextNode('Anime Donghua does not host or proxy video. Playback can be enabled only after an authorized provider source is supplied.'));
  }
  container.append(note);
  const actions = element('div', 'dialog-actions');
  actions.append(makeButton('← Back to title details', 'navigate', 'dialog-button primary', { path: `/title/${encodeURIComponent(title.id)}` }));
  actions.append(makeButton('Add to My List', 'toggle-favorite', 'dialog-button', { id: title.id }));
  container.append(actions);
}

async function loadRoutedTitle(id) {
  if (state.catalog.has(id)) return state.catalog.get(id);
  const data = await request(`/api/catalog/${encodeURIComponent(id)}`);
  state.catalog.set(data.item.id, data.item);
  return data.item;
}

async function renderCurrentPage() {
  const path = normalizedPath();
  const home = document.getElementById('home');
  const page = document.getElementById('routeMain');
  updateActiveNavigation(path);
  if (path === '/') {
    home.hidden = false;
    page.hidden = true;
    document.title = 'Anime Donghua — Anime & Donghua';
    return;
  }

  home.hidden = true;
  page.hidden = false;
  page.replaceChildren();

  if (path === '/my-list') {
    pageHeader(page, 'My List', 'Your saved anime and donghua, all in one place.');
    const titles = [...state.favorites].map((id) => state.catalog.get(id)).filter(Boolean);
    makePageGrid(page, titles);
    if (!titles.length) {
      const explore = element('a', 'route-link-button', 'Explore the catalogue');
      explore.href = '/discover';
      page.append(explore);
    }
    document.title = 'My List | Anime Donghua';
    return;
  }

  if (path === '/profile') {
    pageHeader(page, 'Profile & Preferences', 'Manage your Anime Donghua account and personalize discovery on this browser.');
    if (state.user) {
      const profile = element('div', 'profile-card route-profile-card');
      profile.append(element('div', 'profile-name', state.user.displayName || 'Anime Donghua fan'));
      profile.append(element('div', 'profile-email', state.user.email || ''));
      profile.append(makeButton(`My List (${state.favorites.size})`, 'navigate', 'dialog-button primary', { path: '/my-list' }));
      profile.append(makeButton('Sign out', 'logout', 'dialog-button'));
      page.append(profile);
    } else {
      emptyPage(page, 'Sign in to sync your saved list across devices. Preferences below remain local to this browser.');
      page.append(makeButton('Sign in or create an account', 'account', 'dialog-button primary'));
    }
    page.append(makePreferencesForm());
    document.title = 'Profile & Preferences | Anime Donghua';
    return;
  }

  if (path === '/categories') {
    pageHeader(page, 'Browse Categories', 'Choose a genre to find your next title.');
    const genres = [...new Set([...state.catalog.values()].flatMap((title) => title.genres || []))].sort((a, b) => a.localeCompare(b));
    const list = element('div', 'category-list');
    genres.forEach((genre) => {
      const link = element('a', 'category-link', genre);
      link.href = `/genre/${encodeURIComponent(slugifyGenre(genre))}`;
      list.append(link);
    });
    if (genres.length) page.append(list);
    else emptyPage(page, 'Genres will appear here when catalogue data is available.');
    document.title = 'Categories | Anime Donghua';
    return;
  }

  if (path === '/discover') {
    renderDiscoveryPage(page);
    document.title = 'Discover | Anime Donghua';
    return;
  }

  if (path === '/schedule') {
    renderSchedulePage(page);
    document.title = 'Release Schedule | Anime Donghua';
    return;
  }

  if (path === '/updates') {
    pageHeader(page, 'Latest Updates', 'Episode updates are shown only when verified metadata is available.');
    const updates = verifiedUpdateTitles();
    if (!updates.length) emptyPage(page, 'No verified episode updates are available yet.');
    else {
      const list = element('div', 'route-updates');
      updates.forEach((title) => list.append(makeUpdateCard(title)));
      page.append(list);
    }
    document.title = 'Latest Updates | Anime Donghua';
    return;
  }

  if (path === '/continue-watching') {
    pageHeader(page, 'Continue Watching', 'Saved playback progress will appear here only after an authorized source is connected.');
    emptyPage(page, 'No saved playback progress is available. Playback sources are not configured, so Anime Donghua has not recorded progress.');
    document.title = 'Continue Watching | Anime Donghua';
    return;
  }

  if (path.startsWith('/title/') || path.startsWith('/watch/')) {
    const isWatchPage = path.startsWith('/watch/');
    let id = '';
    try {
      id = decodeURIComponent(path.slice(isWatchPage ? '/watch/'.length : '/title/'.length));
    } catch {
      id = '';
    }
    let title;
    try {
      title = id ? await loadRoutedTitle(id) : null;
    } catch {
      title = null;
    }
    if (!title) {
      pageHeader(page, 'Title Not Found', 'This title is not available in the current catalogue.');
      emptyPage(page, 'Return to Discover to browse available titles.');
      document.title = 'Title Not Found | Anime Donghua';
      return;
    }
    if (isWatchPage) renderWatchPage(page, title);
    else renderTitlePage(page, title);
    document.title = `${title.title} | Anime Donghua`;
    return;
  }

  let definition = pageDefinitions[path];
  if (path.startsWith('/genre/')) {
    const slug = decodeURIComponent(path.slice('/genre/'.length)).toLowerCase();
    const genre = [...state.catalog.values()].flatMap((title) => title.genres || []).find((item) => slugifyGenre(item) === slug);
    if (!genre) {
      pageHeader(page, 'Category Not Found', 'This genre is not in the current catalogue.');
      emptyPage(page, 'Try choosing another category.');
      return;
    }
    definition = { title: genre, description: `Titles in the ${genre} category.`, filters: { genre } };
  }
  if (!definition) return;

  pageHeader(page, definition.title, definition.description);
  const params = new URLSearchParams({ limit: '48', sort: 'newest' });
  Object.entries(definition.filters).forEach(([key, value]) => params.set(key, value));
  try {
    const data = await request(`/api/catalog?${params.toString()}`);
    makePageGrid(page, data.items);
  } catch (error) {
    emptyPage(page, error.message || 'The catalogue could not be loaded. Please try again.');
  }
  document.title = `${definition.title} | Anime Donghua`;
}

async function refreshCatalog() {
  try {
    const data = await request('/api/catalog?limit=48&sort=newest', { cache: 'no-store' });
    state.catalog = new Map(data.items.map((item) => [item.id, item]));
    renderHomeCollections(data.items);
    renderHomeUpdates(data.items);
    setFeaturedTitles(data.items);
    if (normalizedPath() !== '/') await renderCurrentPage();
  } catch {
    // Keep the last good catalogue visible when a refresh is temporarily unavailable.
  }
}

async function initialize() {
  state.preferences = loadPreferences();
  applyPreferences();
  enableCardKeyboard();
  const catalogTask = request('/api/catalog?limit=48&sort=newest')
    .then((data) => {
      state.catalog = new Map(data.items.map((item) => [item.id, item]));
      renderHomeCollections(data.items);
      renderHomeUpdates(data.items);
      setFeaturedTitles(data.items);
    })
    .catch(() => {});
  const csrfTask = csrfToken().catch(() => {});
  const userTask = request('/api/auth/me')
    .then((data) => { state.user = data.user; })
    .catch(() => { state.user = null; });
  await Promise.all([catalogTask, csrfTask, userTask]);
  state.favorites = new Set(guestFavorites().filter((id) => state.catalog.has(id)));
  await syncGuestFavorites();
  await renderCurrentPage();
  window.setInterval(refreshCatalog, 60_000);
}

void initialize();
