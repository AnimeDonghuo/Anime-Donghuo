/**
 * Weekly release schedule typed into the Telegram bot.
 *
 * The publisher writes the week once, in the shape they already think in:
 *
 *   /schedule Monday
 *   Battle Through The Heavens 19:00
 *   Swallowed Star 20:30
 *
 * then a second message for Tuesday, and so on. Everything below turns that
 * text into durable rows and back into readable text, so the bot and the
 * website cannot disagree about what a schedule entry is.
 */

export const SCHEDULE_DAYS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];

const DAY_INDEX = new Map(SCHEDULE_DAYS.map((day, index) => [day.toLowerCase(), index]));
// Publishers type short forms. `t`/`th` are ambiguous on their own, so only
// unambiguous stems are accepted here and the full name always wins.
const DAY_ALIASES = new Map([
  ['mon', 0], ['monday', 0],
  ['tue', 1], ['tues', 1], ['tuesday', 1],
  ['wed', 2], ['weds', 2], ['wednesday', 2],
  ['thu', 3], ['thur', 3], ['thurs', 3], ['thursday', 3],
  ['fri', 4], ['friday', 4],
  ['sat', 5], ['saturday', 5],
  ['sun', 6], ['sunday', 6],
]);

export const MAX_SCHEDULE_ENTRIES_PER_DAY = 60;

/** `monday`, `MON`, `Tues` → `Monday`; anything else → null. */
export function resolveScheduleDay(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/[^a-z]/g, '');
  if (!raw) return null;
  const index = DAY_ALIASES.has(raw) ? DAY_ALIASES.get(raw) : DAY_INDEX.get(raw);
  return Number.isInteger(index) ? SCHEDULE_DAYS[index] : null;
}

export function scheduleDayIndex(day) {
  const resolved = resolveScheduleDay(day);
  return resolved ? DAY_INDEX.get(resolved.toLowerCase()) : SCHEDULE_DAYS.length;
}

// "19:00", "7:00 PM", "7pm", "19.00", "19:00:00" and "19 hours"? Only the
// clock forms are supported; a bare number like "19" is read as 19:00 because
// that is how publishers write it.
const TIME_PATTERN = /^(\d{1,2})(?:[:.](\d{2}))?(?::\d{2})?\s*([ap]\.?\s?m\.?)?$/i;

const TIMEZONE_PATTERN = /^(?:[A-Z]{2,5}|GMT\s?[+-]\d{1,2}(?::\d{2})?|UTC\s?[+-]\d{1,2}(?::\d{2})?)$/;

/** A clock time in one canonical shape: `{ time: 'HH:MM', minutes: 1140 }`. */
export function normalizeScheduleTime(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 16) return null;
  const match = raw.match(TIME_PATTERN);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = Number(match[2] || 0);
  const meridiem = (match[3] || '').replace(/[.\s]/g, '').toLowerCase();
  if (minutes > 59) return null;
  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    if (meridiem === 'pm' && hours !== 12) hours += 12;
    if (meridiem === 'am' && hours === 12) hours = 0;
  }
  if (hours > 23) return null;
  const time = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  return { time, minutes: hours * 60 + minutes };
}

function normalizeTimezone(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const compact = raw.toUpperCase().replace(/\s+/g, '');
  return TIMEZONE_PATTERN.test(compact) ? compact : null;
}

/** `19:00` → `7:00 PM`; a 24-hour string that cannot be read is passed through. */
export function formatScheduleTime(time, timezone = null) {
  const normalized = normalizeScheduleTime(time);
  const zone = timezone ? ` ${timezone}` : '';
  if (!normalized) return `${String(time || '').trim()}${zone}`.trim();
  const hours = Math.floor(normalized.minutes / 60);
  const minutes = normalized.minutes % 60;
  const suffix = hours >= 12 ? 'PM' : 'AM';
  const display = hours % 12 === 0 ? 12 : hours % 12;
  return `${display}:${String(minutes).padStart(2, '0')} ${suffix}${zone}`;
}

// The time sits at the end of the line, optionally after a dash or a pipe, and
// optionally followed by a timezone. Everything before it is the title.
// A bare hour ("Perfect World 21") is accepted too, because that is how the
// week is usually typed out; the digits before the hour keep it apart from a
// season number in the middle of a title.
const ENTRY_TIME_PATTERN = /(?:\s*[-–—|·]\s*|\s+)(\d{1,2}(?:[:.]\d{2})(?::\d{2})?(?:\s?[ap]\.?\s?m\.?)?|\d{1,2}\s?[ap]\.?\s?m\.?|\d{1,2})(?:\s+([A-Za-z]{2,5}|(?:GMT|UTC)\s?[+-]\d{1,2}(?::\d{2})?))?\s*$/i;

function cleanTitle(value) {
  return String(value || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—|·:,]+/, '')
    .replace(/[\s\-–—|·:,]+$/, '')
    .trim()
    .slice(0, 120);
}

/**
 * One line of a `/schedule` message → `{ title, time, timezone }`.
 *
 * A line that cannot be read is returned with an `error` instead of being
 * dropped silently: a schedule the publisher cannot see was not saved.
 */
export function parseScheduleLine(line) {
  const raw = String(line || '').trim();
  if (!raw) return null;
  // People separate the time with a dash but also with nothing at all; both
  // forms reach the same branch below.
  const spaced = raw.replace(/\s+-\s+$/, '');
  const match = spaced.match(ENTRY_TIME_PATTERN);
  if (!match) {
    return { error: `“${raw.slice(0, 80)}” has no time. Write the donghua name then the time, e.g. Swallowed Star 20:30.` };
  }
  const parsedTime = normalizeScheduleTime(match[1]);
  const title = cleanTitle(spaced.slice(0, match.index));
  if (!title) {
    return { error: `“${raw.slice(0, 80)}” has no donghua name before the time.` };
  }
  if (!parsedTime) {
    return { error: `“${match[1].trim()}” is not a clock time. Use 24-hour (19:30) or 7:30 PM.` };
  }
  return {
    title,
    time: parsedTime.time,
    minutes: parsedTime.minutes,
    timezone: normalizeTimezone(match[2]),
  };
}

/**
 * One line may hold several entries separated by commas ("A 19:00, B 20:30").
 * A segment without a time is part of the previous title, so only commas that
 * introduce another timed entry split the line.
 */
function splitEntrySegments(line) {
  const parts = String(line || '').split(/\s*[,;]\s*/).filter(Boolean);
  if (parts.length < 2) return [line];
  const segments = [];
  let buffer = '';
  for (const part of parts) {
    const candidate = buffer ? `${buffer}, ${part}` : part;
    if (parseScheduleLine(part)?.title && !parseScheduleLine(part)?.error) {
      if (buffer) segments.push(buffer);
      buffer = part;
    } else {
      buffer = candidate;
    }
  }
  if (buffer) segments.push(buffer);
  return segments;
}

/**
 * The whole argument text of `/schedule` → what to store.
 *
 * `Monday` may be the first word, or a later line may open a new day, so one
 * message can carry several days. `firstDay` (from `args`) is returned even
 * when the body is empty so the bot can report "no entries" clearly.
 */
export function parseScheduleMessage(args) {
  const text = String(args || '').replace(/\r\n?/g, '\n').trim();
  const lines = text.split('\n').map((line) => line.trim());
  const entries = [];
  const errors = [];

  // The first token may already be the day ("Monday\nName 19:00").
  let currentDay = null;
  let firstDay = null;
  if (lines.length) {
    const [firstToken, ...rest] = lines[0].split(/\s+/);
    const day = resolveScheduleDay(firstToken);
    if (day) {
      currentDay = day;
      firstDay = day;
      const remainder = rest.join(' ').trim();
      if (!remainder) lines.shift();
      else lines[0] = remainder;
      if (lines.length && !lines[0].trim()) lines.shift();
    }
  }

  for (const line of lines) {
    if (!line) continue;
    // A line that is only a day name switches the active day.
    const standaloneDay = resolveScheduleDay(line);
    if (standaloneDay) {
      currentDay = standaloneDay;
      firstDay ||= standaloneDay;
      continue;
    }
    if (!currentDay) {
      errors.push('Start with the day first, e.g. /schedule Monday and then one donghua per line.');
      break;
    }
    for (const segment of splitEntrySegments(line)) {
      const parsed = parseScheduleLine(segment);
      if (!parsed) continue;
      if (parsed.error) {
        errors.push(parsed.error);
        continue;
      }
      if (entries.length >= MAX_SCHEDULE_ENTRIES_PER_DAY * SCHEDULE_DAYS.length) {
        errors.push('That is more schedule entries than the site can show in one week.');
        break;
      }
      entries.push({ day: currentDay, ...parsed });
    }
  }

  return { firstDay, entries, errors };
}

/** A stable key so re-sending the same donghua on the same day updates its time. */
export function scheduleEntryKey(day, title) {
  const resolved = resolveScheduleDay(day) || String(day || '').trim();
  const slug = String(title || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'untitled';
  return `${resolved.toLowerCase()}|${slug}`;
}

/** Group entries by day, week order first, then by clock time. */
export function groupScheduleByDay(entries) {
  const groups = new Map(SCHEDULE_DAYS.map((day) => [day, []]));
  for (const entry of Array.isArray(entries) ? entries : []) {
    const day = resolveScheduleDay(entry?.day);
    if (!day || !entry?.title) continue;
    groups.get(day).push(entry);
  }
  for (const list of groups.values()) {
    list.sort((left, right) => {
      const leftMinutes = Number.isFinite(left?.minutes) ? left.minutes : normalizeScheduleTime(left?.time)?.minutes ?? 24 * 60;
      const rightMinutes = Number.isFinite(right?.minutes) ? right.minutes : normalizeScheduleTime(right?.time)?.minutes ?? 24 * 60;
      return leftMinutes - rightMinutes || String(left.title).localeCompare(String(right.title));
    });
  }
  return groups;
}

/** The confirmation the bot sends back, one block per day. */
export function formatScheduleReport(entries, { siteUrl = '' } = {}) {
  const groups = groupScheduleByDay(entries);
  const lines = [];
  for (const day of SCHEDULE_DAYS) {
    const list = groups.get(day);
    if (!list.length) continue;
    lines.push(`▸ ${day}`);
    for (const entry of list) {
      const time = formatScheduleTime(entry.time, entry.timezone);
      lines.push(`   • ${entry.title} — ${time}`);
    }
  }
  if (!lines.length) return 'No schedule entries are saved yet.';
  const link = siteUrl ? `\n\n${siteUrl.replace(/\/$/, '')}/schedule` : '';
  return `${lines.join('\n')}${link}`;
}

/** What `/schedule` with no arguments answers. */
export const SCHEDULE_USAGE_TEXT = [
  'Weekly schedule — permanent until you remove it.',
  '',
  'Send the day first, then one donghua per line with its time:',
  '',
  '/schedule Monday',
  'Battle Through The Heavens 19:00',
  'Swallowed Star 20:30',
  'Perfect World 21:00',
  '',
  'Then do the same for Tuesday, Wednesday, and the rest of the week.',
  'You can also put a whole week in one message by starting a new line with the day name.',
  '',
  'Times accept 19:30, 7:30 PM, or 7pm, with an optional zone (e.g. 19:30 BST).',
  'Remove with /removeschedule Monday, /removeschedule Monday Swallowed Star, or /removeschedule all.',
  'See the current week with /schedule list.',
].join('\n');
