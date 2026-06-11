// ============================================================
//  config.js — Constants, game configuration, and shared state
// ============================================================

const SUPABASE_URL = 'https://arjlihlurgfjdrnrjefi.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFyamxpaGx1cmdmamRybnJqZWZpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkxODY2OTMsImV4cCI6MjA5NDc2MjY5M30.SJNQr8lL726tEaba83y6OaNxHZdt2lsdsDZGrXoYC48';
const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// --------------- Data lists (populated by loadGameData) ---------------
let UMAS = [];
let COURSES = [];
let VOICEDLE = [];

// --------------- Rank map ---------------
const RANK_MAP = {
  'S': 6, 'A': 5, 'B': 4, 'C': 3, 'D': 2, 'E': 1, 'F': 0, 'G': -1
};

const GRADES = ["G", "F", "E", "D", "C", "B", "A", "S"];
const POINTS_PER_TIER = 200;
const DIV_THRESHOLD = 100;

// --------------- Game configuration ---------------
const GAME_CONFIG = {
  uma: {
    keys: ['sprint', 'mile', 'med', 'long', 'front', 'pace', 'late', 'end', 'turf', 'dirt'],
    headers: ['Spr', 'Mil', 'Med', 'Lon', 'Fro', 'Pac', 'Lat', 'End', 'Trf', 'Drt'],
    data: () => UMAS,
    placeholder: "Enter Umamusume name...",
    resultTitle: "Winning Umamusume",
    storageKey: 'uma_wordle_stats',
    helpDesc: "Guess the Umamusume based on their base Aptitudes!",
    shareTitle: "TRACENDLE",
    sections: [
      { title: "Distance", keys: ['sprint', 'mile', 'med', 'long'], color: 'blue' },
      { title: "Strategy", keys: ['front', 'pace', 'late', 'end'], color: 'purple' },
      { title: "Track",    keys: ['turf', 'dirt'],                  color: 'orange' }
    ]
  },
  course: {
    keys: ['length', 'surface', 'turn', 'location', 'schedule'],
    headers: ['Length', 'Surface', 'Turn', 'Location', 'Schedule'],
    data: () => COURSES,
    placeholder: "Enter G1 Race name...",
    resultTitle: "Winning G1 Race",
    storageKey: 'course_wordle_stats',
    helpDesc: "Guess the G1 Race based on its course features!",
    shareTitle: "TRACENDLE",
    sections: [
      { title: "Course Info", keys: ['length', 'surface', 'turn', 'location', 'schedule'], color: 'green' }
    ]
  },
  voicedle: {
    keys: [],
    headers: [],
    data: () => VOICEDLE,
    placeholder: "Guess the Umamusume from the voice line...",
    resultTitle: "Winning Umamusume",
    storageKey: 'voicedle_stats',
    helpDesc: "Guess the Umamusume from their voice line! Each wrong guess unlocks more audio.",
    shareTitle: "TRACENDLE VOICEDLE",
    sections: []
  }
};

// --------------- Active game type ---------------
let currentGameType = 'uma';

// --------------- Persistent player data ---------------
let allPersistentData = {
  uma: {
    dailyStreak: 0, easyStreak: 0, unlimitedStreak: 0, hardStreak: 0,
    lastPlayedDate: null,
    dailyGuesses: [], dailyStatus: 'playing',
    rankedGuesses: [], rankedStatus: 'playing', rankedTargetName: null,
    unlimitedSession: null, hardSession: null, easySession: null, lbSubmittedKey: null
  },
  course: {
    dailyStreak: 0, easyStreak: 0, unlimitedStreak: 0, hardStreak: 0,
    lastPlayedDate: null,
    dailyGuesses: [], dailyStatus: 'playing',
    rankedGuesses: [], rankedStatus: 'playing', rankedTargetName: null,
    unlimitedSession: null, hardSession: null, lbSubmittedKey: null
  },
  voicedle: {
    dailyStreak: 0, easyStreak: 0, unlimitedStreak: 0, hardStreak: 0,
    lastPlayedDate: null,
    dailyGuesses: [], dailyStatus: 'playing',
    rankedGuesses: [], rankedStatus: 'playing', rankedTargetName: null,
    unlimitedSession: null, hardSession: null, easySession: null, lbSubmittedKey: null
  }
};

// --------------- In-memory session state ---------------
let sessionState = {
  active: false,
  mode: null,
  target: null,
  guesses: [],
  clues: [],
  unlimitedScore: 0,
  isGameOver: false,
  knownStats: {},
  pendingStreakReset: false,
  streakAtLoss: 0,
  sessionKey: null,
  _leaderboardSynced: false
};

// --------------- Leaderboard UI state ---------------
let currentLbTab = 'uma';
let currentLbType = 'dailyStreak';
let activeLbCategory = 'normal';
let activeLbTimeWindow = 'weekly';

// --------------- Stats modal state ---------------
let currentStatsTab = 'uma';

// --------------- Versioning ---------------
const CURRENT_VERSION = '1.3.5';
