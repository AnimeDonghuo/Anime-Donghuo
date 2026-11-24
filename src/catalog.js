const catalog = [
  {
    id: 'perfect-world', title: 'Perfect World', type: 'donghua', format: 'series', status: 'ongoing', episodeCount: 200,
    rating: 9.4, genres: ['Action', 'Fantasy', 'Cultivation'], sections: ['featured', 'trending'],
    description: 'Born into a world of ancient powers, one young hero sets out on a journey beyond the limits of destiny.',
  },
  {
    id: 'battle-through-the-heavens', title: 'Battle Through the Heavens', type: 'donghua', format: 'series', status: 'ongoing', episodeCount: 112,
    rating: 9.1, genres: ['Action', 'Fantasy', 'Cultivation'], sections: ['trending', 'continue'],
    description: 'A fallen prodigy trains to reclaim his strength and protect the people he cares about.',
  },
  {
    id: 'soul-land', title: 'Soul Land', type: 'donghua', format: 'series', status: 'completed', episodeCount: 264,
    rating: 9.0, genres: ['Action', 'Adventure', 'Fantasy'], sections: ['trending'],
    description: 'A martial-arts student is reborn in a world where spirit power shapes every destiny.',
  },
  {
    id: 'one-piece', title: 'One Piece', type: 'anime', format: 'series', status: 'ongoing', episodeCount: 1091,
    rating: 9.2, genres: ['Adventure', 'Action', 'Comedy'], sections: ['trending', 'continue'],
    description: 'A spirited crew sails the Grand Line in pursuit of the legendary One Piece.',
  },
  {
    id: 'jujutsu-kaisen', title: 'Jujutsu Kaisen', type: 'anime', format: 'series', status: 'ongoing', episodeCount: 47,
    rating: 8.8, genres: ['Action', 'Supernatural', 'Fantasy'], sections: ['trending'],
    description: 'A student joins a hidden world of sorcerers to confront dangerous curses.',
  },
  {
    id: 'demon-slayer', title: 'Demon Slayer', type: 'anime', format: 'series', status: 'ongoing', episodeCount: 63,
    rating: 8.7, genres: ['Action', 'Adventure', 'Fantasy'], sections: ['trending'],
    description: 'A determined young swordsman searches for a cure for his sister after tragedy strikes.',
  },
  {
    id: 'throne-of-seal', title: 'Throne of Seal', type: 'donghua', format: 'series', status: 'ongoing', episodeCount: 139,
    rating: 8.6, genres: ['Action', 'Fantasy', 'Adventure'], sections: ['donghua', 'updates'],
    description: 'A young knight rises through a dangerous world to defend humanity.',
  },
  {
    id: 'apotheosis', title: 'Apotheosis', type: 'donghua', format: 'series', status: 'ongoing', episodeCount: 116,
    rating: 8.4, genres: ['Action', 'Fantasy', 'Cultivation'], sections: ['donghua', 'updates'],
    description: 'A former noble fights his way toward a new life and the limits of divine power.',
  },
  {
    id: 'a-record-of-a-mortals-journey', title: "A Record of a Mortal's Journey", type: 'donghua', format: 'series', status: 'ongoing', episodeCount: 100,
    rating: 8.8, genres: ['Adventure', 'Fantasy', 'Cultivation'], sections: ['donghua'],
    description: 'An ordinary young man navigates a perilous cultivation world through patience and resolve.',
  },
  {
    id: 'daily-life-of-the-immortal-king', title: 'The Daily Life of the Immortal King', type: 'donghua', format: 'series', status: 'ongoing', episodeCount: 52,
    rating: 8.2, genres: ['Comedy', 'Fantasy', 'School'], sections: ['donghua'],
    description: 'A powerful immortal tries to keep a low profile while navigating everyday school life.',
  },
  {
    id: 'soul-land-ii', title: 'Soul Land II', type: 'donghua', format: 'series', status: 'ongoing', episodeCount: 100,
    rating: 8.5, genres: ['Action', 'Fantasy', 'Adventure'], sections: ['donghua'],
    description: 'A new generation discovers its place in a changing world of spirit masters.',
  },
  {
    id: 'swallowed-star', title: 'Swallowed Star', type: 'donghua', format: 'series', status: 'ongoing', episodeCount: 150,
    rating: 8.7, genres: ['Action', 'Sci-Fi', 'Adventure'], sections: ['donghua'],
    description: 'In a future threatened by monsters, one fighter looks beyond Earth for humanity’s survival.',
  },
  {
    id: 'attack-on-titan', title: 'Attack on Titan', type: 'anime', format: 'series', status: 'completed', episodeCount: 89,
    rating: 9.0, genres: ['Action', 'Drama', 'Fantasy'], sections: ['anime'],
    description: 'Humanity struggles to survive behind enormous walls in a world ruled by Titans.',
  },
  {
    id: 'solo-leveling', title: 'Solo Leveling', type: 'anime', format: 'series', status: 'ongoing', episodeCount: 12,
    rating: 8.9, genres: ['Action', 'Fantasy', 'Adventure'], sections: ['anime'],
    description: 'The weakest hunter receives a mysterious chance to grow stronger without limits.',
  },
  {
    id: 'bleach-tybw', title: 'Bleach: TYBW', type: 'anime', format: 'series', status: 'ongoing', episodeCount: 27,
    rating: 9.1, genres: ['Action', 'Supernatural', 'Adventure'], sections: ['anime', 'updates'],
    description: 'The Soul Reapers face an overwhelming threat to the balance between worlds.',
  },
  {
    id: 'chainsaw-man', title: 'Chainsaw Man', type: 'anime', format: 'series', status: 'ongoing', episodeCount: 12,
    rating: 8.5, genres: ['Action', 'Horror', 'Supernatural'], sections: ['anime'],
    description: 'A young devil hunter is pulled into a brutal world of contracts and consequences.',
  },
  {
    id: 'haikyu', title: 'Haikyu!!', type: 'anime', format: 'series', status: 'completed', episodeCount: 85,
    rating: 8.8, genres: ['Sports', 'Comedy', 'Drama'], sections: ['anime'],
    description: 'A determined volleyball team grows stronger one match at a time.',
  },
  {
    id: 'spy-x-family', title: 'Spy × Family', type: 'anime', format: 'series', status: 'ongoing', episodeCount: 37,
    rating: 8.6, genres: ['Comedy', 'Action', 'Family'], sections: ['anime'],
    description: 'A spy, an assassin, and a telepath form an unusual family with secrets of their own.',
  },
  {
    id: 'your-name', title: 'Your Name', type: 'anime', format: 'movie', status: 'completed', episodeCount: 1,
    rating: 8.8, genres: ['Romance', 'Drama', 'Fantasy'], sections: ['movies'],
    description: 'Two teenagers discover an extraordinary connection across distance and time.',
  },
  {
    id: 'spirited-away', title: 'Spirited Away', type: 'anime', format: 'movie', status: 'completed', episodeCount: 1,
    rating: 9.0, genres: ['Adventure', 'Fantasy', 'Family'], sections: ['movies'],
    description: 'A young girl enters a mysterious spirit world and searches for a way home.',
  },
  {
    id: 'big-fish-and-begonia', title: 'Big Fish & Begonia', type: 'donghua', format: 'movie', status: 'completed', episodeCount: 1,
    rating: 8.2, genres: ['Fantasy', 'Adventure', 'Drama'], sections: ['movies'],
    description: 'A young spirit crosses worlds to repay a life-changing debt.',
  },
];

export const catalogItems = Object.freeze(catalog.map((item) => Object.freeze({
  ...item,
  genres: Object.freeze([...item.genres]),
  sections: Object.freeze([...item.sections]),
})));

export const catalogById = new Map(catalogItems.map((item) => [item.id, item]));

export function publicTitle(item) {
  return {
    id: item.id,
    title: item.title,
    type: item.type,
    format: item.format,
    status: item.status,
    episodeCount: item.episodeCount,
    rating: item.rating,
    genres: [...item.genres],
    description: item.description,
  };
}
