const catalog = [
  {
    id: 'perfect-world', title: 'Perfect World', type: 'donghua', format: 'series', status: 'ongoing', imageUrl: '/assets/aniverse-blue-dragon.png',
    genres: ['Action', 'Fantasy', 'Cultivation'], sections: ['featured', 'trending'],
    description: 'Born into a world of ancient powers, one young hero sets out on a journey beyond the limits of destiny.',
  },
  {
    id: 'battle-through-the-heavens', title: 'Battle Through the Heavens', type: 'donghua', format: 'series', status: 'ongoing',
    genres: ['Action', 'Fantasy', 'Cultivation'], sections: ['trending', 'continue'],
    description: 'A fallen prodigy trains to reclaim his strength and protect the people he cares about.',
  },
  {
    id: 'soul-land', title: 'Soul Land', type: 'donghua', format: 'series', status: 'completed',
    genres: ['Action', 'Adventure', 'Fantasy'], sections: ['trending'],
    description: 'A martial-arts student is reborn in a world where spirit power shapes every destiny.',
  },
  {
    id: 'one-piece', title: 'One Piece', type: 'anime', format: 'series', status: 'ongoing',
    genres: ['Adventure', 'Action', 'Comedy'], sections: ['trending', 'continue'],
    description: 'A spirited crew sails the Grand Line in pursuit of the legendary One Piece.',
  },
  {
    id: 'jujutsu-kaisen', title: 'Jujutsu Kaisen', type: 'anime', format: 'series', status: 'ongoing',
    genres: ['Action', 'Supernatural', 'Fantasy'], sections: ['trending'],
    description: 'A student joins a hidden world of sorcerers to confront dangerous curses.',
  },
  {
    id: 'demon-slayer', title: 'Demon Slayer', type: 'anime', format: 'series', status: 'ongoing',
    genres: ['Action', 'Adventure', 'Fantasy'], sections: ['trending'],
    description: 'A determined young swordsman searches for a cure for his sister after tragedy strikes.',
  },
  {
    id: 'throne-of-seal', title: 'Throne of Seal', type: 'donghua', format: 'series', status: 'ongoing',
    genres: ['Action', 'Fantasy', 'Adventure'], sections: ['donghua', 'updates'],
    description: 'A young knight rises through a dangerous world to defend humanity.',
  },
  {
    id: 'apotheosis', title: 'Apotheosis', type: 'donghua', format: 'series', status: 'ongoing',
    genres: ['Action', 'Fantasy', 'Cultivation'], sections: ['donghua', 'updates'],
    description: 'A former noble fights his way toward a new life and the limits of divine power.',
  },
  {
    id: 'a-record-of-a-mortals-journey', title: "A Record of a Mortal's Journey", type: 'donghua', format: 'series', status: 'ongoing',
    genres: ['Adventure', 'Fantasy', 'Cultivation'], sections: ['donghua'],
    description: 'An ordinary young man navigates a perilous cultivation world through patience and resolve.',
  },
  {
    id: 'daily-life-of-the-immortal-king', title: 'The Daily Life of the Immortal King', type: 'donghua', format: 'series', status: 'ongoing',
    genres: ['Comedy', 'Fantasy', 'School'], sections: ['donghua'],
    description: 'A powerful immortal tries to keep a low profile while navigating everyday school life.',
  },
  {
    id: 'soul-land-ii', title: 'Soul Land II', type: 'donghua', format: 'series', status: 'ongoing',
    genres: ['Action', 'Fantasy', 'Adventure'], sections: ['donghua'],
    description: 'A new generation discovers its place in a changing world of spirit masters.',
  },
  {
    id: 'swallowed-star', title: 'Swallowed Star', type: 'donghua', format: 'series', status: 'ongoing',
    genres: ['Action', 'Sci-Fi', 'Adventure'], sections: ['donghua'],
    description: 'In a future threatened by monsters, one fighter looks beyond Earth for humanity’s survival.',
  },
  {
    id: 'attack-on-titan', title: 'Attack on Titan', type: 'anime', format: 'series', status: 'completed',
    genres: ['Action', 'Drama', 'Fantasy'], sections: ['anime'],
    description: 'Humanity struggles to survive behind enormous walls in a world ruled by Titans.',
  },
  {
    id: 'solo-leveling', title: 'Solo Leveling', type: 'anime', format: 'series', status: 'ongoing',
    genres: ['Action', 'Fantasy', 'Adventure'], sections: ['anime'],
    description: 'The weakest hunter receives a mysterious chance to grow stronger without limits.',
  },
  {
    id: 'bleach-tybw', title: 'Bleach: TYBW', type: 'anime', format: 'series', status: 'ongoing',
    genres: ['Action', 'Supernatural', 'Adventure'], sections: ['anime', 'updates'],
    description: 'The Soul Reapers face an overwhelming threat to the balance between worlds.',
  },
  {
    id: 'chainsaw-man', title: 'Chainsaw Man', type: 'anime', format: 'series', status: 'ongoing',
    genres: ['Action', 'Horror', 'Supernatural'], sections: ['anime'],
    description: 'A young devil hunter is pulled into a brutal world of contracts and consequences.',
  },
  {
    id: 'haikyu', title: 'Haikyu!!', type: 'anime', format: 'series', status: 'completed',
    genres: ['Sports', 'Comedy', 'Drama'], sections: ['anime'],
    description: 'A determined volleyball team grows stronger one match at a time.',
  },
  {
    id: 'spy-x-family', title: 'Spy × Family', type: 'anime', format: 'series', status: 'ongoing',
    genres: ['Comedy', 'Action', 'Family'], sections: ['anime'],
    description: 'A spy, an assassin, and a telepath form an unusual family with secrets of their own.',
  },
  {
    id: 'your-name', title: 'Your Name', type: 'anime', format: 'movie', status: 'completed',
    genres: ['Romance', 'Drama', 'Fantasy'], sections: ['movies'],
    description: 'Two teenagers discover an extraordinary connection across distance and time.',
  },
  {
    id: 'spirited-away', title: 'Spirited Away', type: 'anime', format: 'movie', status: 'completed',
    genres: ['Adventure', 'Fantasy', 'Family'], sections: ['movies'],
    description: 'A young girl enters a mysterious spirit world and searches for a way home.',
  },
  {
    id: 'big-fish-and-begonia', title: 'Big Fish & Begonia', type: 'donghua', format: 'movie', status: 'completed',
    genres: ['Fantasy', 'Adventure', 'Drama'], sections: ['movies'],
    description: 'A young spirit crosses worlds to repay a life-changing debt.',
  },
];

export const catalogItems = Object.freeze(catalog.map((item) => Object.freeze({
  ...item,
  genres: Object.freeze([...item.genres]),
  sections: Object.freeze([...item.sections]),
})));

export const catalogById = new Map(catalogItems.map((item) => [item.id, item]));

function cleanPublicStrings(values, maxItems = 12, maxLength = 100) {
  if (!Array.isArray(values)) return [];
  return values
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim().slice(0, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function isoDate(value) {
  if (typeof value !== 'string' && !(value instanceof Date)) return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}

export function publicTitle(item) {
  const imageUrl = item.imageUrl || item.artworkUrl || (typeof item.artwork === 'string' ? item.artwork : item.artwork?.url);
  const addedAt = isoDate(item.addedAt || item.createdAt);
  const upcomingReleaseAt = isoDate(item.upcomingReleaseAt);
  const episodeReleaseAt = isoDate(item.latestEpisode?.releaseAt);
  const latestEpisode = item.latestEpisode && typeof item.latestEpisode === 'object'
    ? {
      ...(Number.isInteger(item.latestEpisode.number) && item.latestEpisode.number > 0 ? { number: item.latestEpisode.number } : {}),
      ...(Number.isInteger(item.latestEpisode.season) && item.latestEpisode.season > 0 ? { season: item.latestEpisode.season } : {}),
      ...(typeof item.latestEpisode.title === 'string' ? { title: item.latestEpisode.title.trim().slice(0, 160) } : {}),
      ...(episodeReleaseAt ? { releaseAt: episodeReleaseAt } : {}),
    }
    : undefined;
  const releaseSchedule = Array.isArray(item.releaseSchedule)
    ? item.releaseSchedule.slice(0, 14).flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const day = typeof entry.day === 'string' ? entry.day.trim() : '';
      const time = typeof entry.time === 'string' ? entry.time.trim() : '';
      if (!/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/i.test(day) || !/^([01]?\d|2[0-3]):[0-5]\d(?:\s?[A-Z]{2,5})?$/.test(time)) return [];
      const normalizedDay = `${day[0].toUpperCase()}${day.slice(1).toLowerCase()}`;
      return [{ day: normalizedDay, time, ...(Number.isInteger(entry.episode) && entry.episode > 0 ? { episode: entry.episode } : {}) }];
    })
    : [];
  return {
    id: item.id,
    title: item.title,
    type: item.type,
    format: item.format,
    status: item.status,
    genres: [...item.genres],
    sections: [...(item.sections || [])],
    description: item.description,
    ...(typeof imageUrl === 'string' && imageUrl.length <= 2048 ? { imageUrl } : {}),
    ...(addedAt ? { addedAt } : {}),
    ...(upcomingReleaseAt ? { upcomingReleaseAt } : {}),
    ...(Number.isInteger(item.year) && item.year >= 1900 && item.year <= 2100 ? { year: item.year } : {}),
    ...(cleanPublicStrings(item.alternativeTitles).length ? { alternativeTitles: cleanPublicStrings(item.alternativeTitles) } : {}),
    ...(cleanPublicStrings(item.languages, 8, 40).length ? { languages: cleanPublicStrings(item.languages, 8, 40) } : {}),
    ...(cleanPublicStrings(item.subtitles, 8, 40).length ? { subtitles: cleanPublicStrings(item.subtitles, 8, 40) } : {}),
    ...(Number.isInteger(item.episodeCount) && item.episodeCount > 0 ? { episodeCount: item.episodeCount } : {}),
    ...(Number.isFinite(item.rating) && item.rating >= 0 && item.rating <= 10 ? { rating: item.rating } : {}),
    ...(latestEpisode && Object.keys(latestEpisode).length ? { latestEpisode } : {}),
    ...(releaseSchedule.length ? { releaseSchedule } : {}),
  };
}
