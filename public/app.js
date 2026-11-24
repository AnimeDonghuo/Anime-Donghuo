const originalNotify = window.notify;
const originalOpenSearch = window.openSearch;
const originalCloseSearch = window.closeSearch;
const searchPanel = document.getElementById('searchPanel');
const searchInput = document.getElementById('searchInput');
const searchResults = document.getElementById('searchResults');

const state = {
  catalog: new Map(),
  favorites: new Set(),
  user: null,
  csrfToken: null,
  authMode: 'login',
  browse: null,
};

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

function toast(message) {
  if (typeof originalNotify === 'function') originalNotify(message);
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
  button.textContent = state.favorites.has('perfect-world') ? '♥  My List' : '＋  My List';
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

function showTitleDetails(title) {
  const { content } = createDialog(title.title, '', title.type === 'donghua' ? 'DONGHUA' : 'ANIME');
  const meta = element('div', 'dialog-meta');
  const type = title.type === 'donghua' ? 'Donghua' : 'Anime';
  const format = title.format === 'movie' ? 'Movie' : 'Series';
  const status = title.status ? title.status[0].toUpperCase() + title.status.slice(1) : 'Catalogue';
  [type, format, status, Number.isFinite(title.rating) ? `★ ${title.rating.toFixed(1)}` : '']
    .filter(Boolean)
    .forEach((label) => meta.append(element('span', 'dialog-chip', label)));
  content.append(meta);
  content.append(element('p', 'dialog-description', title.description || 'Explore this title in the Anime Donghua catalogue.'));

  if (title.genres?.length) {
    const genres = element('div', 'dialog-meta');
    title.genres.forEach((genre) => genres.append(element('span', 'dialog-chip', genre)));
    content.append(genres);
  }

  const note = element('div', 'dialog-note');
  note.append(element('strong', '', 'Playback source not connected. '));
  note.append(document.createTextNode('This catalogue does not host or proxy video. Add an authorized streaming provider before playback can begin.'));
  content.append(note);

  const actions = element('div', 'dialog-actions');
  const isSaved = state.favorites.has(title.id);
  actions.append(makeButton(isSaved ? '♥ Remove from My List' : '＋ Add to My List', 'toggle-favorite', 'dialog-button', { id: title.id }));
  actions.append(makeButton(title.format === 'movie' ? '▶ View movie' : '▶ Watch now', 'watch-title', 'dialog-button primary', { id: title.id }));
  content.append(actions);
}

function showWatch(title) {
  const { content } = createDialog(title.title, 'NOW PLAYING', 'WATCH');
  const player = element('div', 'player-placeholder');
  player.setAttribute('aria-label', 'No licensed playback source is connected');
  player.append(element('div', 'player-symbol', '▶'));
  player.append(element('p', 'player-message', 'No licensed stream is configured for this title yet.'));
  content.append(player);
  const note = element('div', 'dialog-note');
  note.append(element('strong', '', 'Ready for an authorized provider. '));
  note.append(document.createTextNode('When you add a legal streaming source, this player view can open it here.'));
  content.append(note);
  content.append(makeButton('← Back to title details', 'open-title', 'dialog-button', { id: title.id }));
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
  button.append(element('strong', '', title.title));
  button.append(element('small', '', `${title.type === 'donghua' ? 'Donghua' : 'Anime'} · ${title.format === 'movie' ? 'Movie' : 'Series'} · ${title.status}`));
  return button;
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
    content.append(makeButton('Explore trending titles', 'browse-section', 'dialog-button primary', { section: 'trending' }));
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

function showUpdates() {
  const { content } = createDialog('Latest updates', 'Recently listed episodes across the catalogue.');
  const grid = element('div', 'browse-grid');
  document.querySelectorAll('#updates .update').forEach((row) => {
    const title = titleFromCard(row);
    if (title) grid.append(makeBrowseItem(title));
  });
  if (!grid.childElementCount) grid.append(element('div', 'dialog-empty', 'There are no new episode updates yet.'));
  content.append(grid);
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
  actions.append(makeButton('Sign out', 'logout', 'dialog-button'));
  content.append(actions);
}

function showAuth(mode = 'login') {
  state.authMode = mode === 'register' ? 'register' : 'login';
  const isRegister = state.authMode === 'register';
  const { content } = createDialog(isRegister ? 'Create your account' : 'Welcome back', 'Save your list and keep your preferences together.', 'ANIME DONGHUA ACCOUNT');
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
    .filter((item) => `${item.title} ${(item.genres || []).join(' ')} ${item.description || ''}`.toLowerCase().includes(clean))
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
    'Continue watching page': () => showBrowse({ heading: 'Continue watching', filters: { section: 'continue' } }),
    'More trending titles': () => showBrowse({ heading: 'Trending titles', filters: { section: 'trending' } }),
    'Perfect World selected': () => openTitle('perfect-world'),
    'BTTH selected': () => openTitle('battle-through-the-heavens'),
    'Soul Land selected': () => openTitle('soul-land'),
    'One Piece selected': () => openTitle('one-piece'),
    'Jujutsu Kaisen selected': () => openTitle('jujutsu-kaisen'),
    'Demon Slayer selected': () => openTitle('demon-slayer'),
    'Donghua category': () => showBrowse({ heading: 'Popular donghua', filters: { type: 'donghua' } }),
    'Anime category': () => showBrowse({ heading: 'Popular anime', filters: { type: 'anime' } }),
    'All latest episodes': showUpdates,
    'No new notifications': showUpdates,
    'Profile page coming soon': showAccount,
  };
  const action = actions[message];
  if (action) void Promise.resolve(action()).catch((error) => toast(error.message || 'This action could not be completed.'));
  else toast(message);
}

window.notify = showNotificationAction;
window.filterTitles = search;
window.openSearch = function openSearchWithResults() {
  originalOpenSearch();
  searchPanel.setAttribute('role', 'dialog');
  searchPanel.setAttribute('aria-modal', 'true');
  searchPanel.setAttribute('aria-labelledby', 'searchHeading');
  search(searchInput.value);
};
window.closeSearch = function closeSearchWithState() {
  originalCloseSearch();
  searchPanel.removeAttribute('aria-modal');
};

async function handleAction(button) {
  const { action, id, key, value } = button.dataset;
  switch (action) {
    case 'close-dialog':
      document.getElementById('animeDonghuaDialog')?.close();
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
      toast('You have signed out.');
      break;
    case 'auth-mode':
      showAuth(button.dataset.mode);
      break;
    case 'browse-section':
      await showBrowse({ heading: 'Trending titles', filters: { section: button.dataset.section } });
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

  const quick = target.closest('.quick a');
  if (quick) {
    const icon = quick.querySelector('.qicon')?.textContent || '';
    const label = quick.textContent.replace(icon, '').trim();
    const browseActions = {
      Popular: () => showBrowse({ heading: 'Trending titles', filters: { section: 'trending' } }),
      Ongoing: () => showBrowse({ heading: 'Ongoing series', filters: { status: 'ongoing' } }),
      Movies: () => showBrowse({ heading: 'Anime & donghua movies', filters: { format: 'movie' } }),
      Categories: () => showBrowse({ heading: 'Browse categories', filters: {}, categories: true }),
    };
    if (browseActions[label]) {
      event.preventDefault();
      event.stopImmediatePropagation();
      void browseActions[label]().catch((error) => toast(error.message || 'The catalogue could not be opened.'));
    }
    return;
  }

  const bottom = target.closest('.bottom a');
  if (bottom) {
    const label = bottom.textContent.trim();
    if (label.includes('My List')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      showMyList();
    } else if (label.includes('Profile')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      showAccount();
    }
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
  if (event.target.id !== 'authForm') return;
  event.preventDefault();
  void submitAuth(event.target);
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

async function initialize() {
  enableCardKeyboard();
  const catalogTask = request('/api/catalog?limit=48')
    .then((data) => { state.catalog = new Map(data.items.map((item) => [item.id, item])); })
    .catch(() => {});
  const csrfTask = csrfToken().catch(() => {});
  const userTask = request('/api/auth/me')
    .then((data) => { state.user = data.user; })
    .catch(() => { state.user = null; });
  await Promise.all([catalogTask, csrfTask, userTask]);
  state.favorites = new Set(guestFavorites().filter((id) => state.catalog.has(id)));
  await syncGuestFavorites();
}

void initialize();
