// ============================================================
//  pvp.js — Matchmaking, State Polling, and PvP Game Loop
// ============================================================
const PVP_DC_TIMEOUT_MS = 25000;

let pvpState = {
  battleId: null,
  role: null, // 'player1' or 'player2' (host = player1)
  opponentId: null,
  opponentName: null,
  myHp: 100,
  opponentHp: 100,
  maxHp: 100, // Scaling maximum starting HP
  opponentGuesses: [],
  currentRound: 1,
  matchTimer: null,
  pollTimer: null,
  queueTimer: null,
  isWaitingForOpponent: false,
  lastHeartbeatSent: 0,
  formattedTime: "03:00",
  maxGuesses: 5,
  damageMultiplier: 1,
  isFFA: false,
  allPlayers: [],
  mySlot: 0,
  prevHpMap: {},
  roundTimeLimitMin: 3,
  roundExpiresAt: null,
  roundTimeoutHandled: false,
  isResolvingRound: false,
  hardModeActive: false,
  isShowingRoundResolution: false, // Tracks visual round resolution sequence
  suddenDeathRound: 6 // Added customizable Sudden Death fallback round
};

// Ready check state tracking
let readyCheckState = {
  battleId: null,
  role: null,
  pollTimer: null,
  countdownTimer: null,
  secondsLeft: 20
};

// --- Server-Calibrated Timing System (Option 1) ---
let serverTimeOffsetMs = 0;

/**
 * Calibrates the client clock against the database server's time
 * by fetching HTTP response headers from the Supabase API endpoint.
 * This resolves clock drift issues across different device timezones.
 */
async function calibrateServerTime() {
  const start = Date.now();
  try {
    const url = typeof SUPABASE_URL !== 'undefined' ? SUPABASE_URL : '';
    if (!url) return;

    const response = await fetch(url, { method: 'HEAD' });
    const serverDateHeader = response.headers.get('date');
    
    if (serverDateHeader) {
      const serverTime = new Date(serverDateHeader).getTime();
      const rtt = Date.now() - start;
      // Estimate server time adjusted for half of the round trip time
      const estimatedServerTime = serverTime + Math.floor(rtt / 2);
      serverTimeOffsetMs = estimatedServerTime - Date.now();
    }
  } catch (err) {
    console.warn('Unable to calibrate server time, using local clock fallback:', err);
  }
}

/**
 * Returns the estimated current server time in milliseconds.
 */
function getServerTime() {
  return Date.now() + serverTimeOffsetMs;
}

function calculatePlayerRoundPower(state, guesses, maxG, dmgMult) {
  if (state && state.startsWith('finished_won')) {
    const parts = state.split(':');
    const timeRemaining = parts.length === 2 ? parseFloat(parts[1]) : 0;
    const remainingGuesses = maxG - parseGuessesArray(guesses).length;

    // Cap time bonus to maxG * 3 to target ~20 max power per round (~5 avg rounds).
    const timeBonus = Math.min(1.2 * (timeRemaining / 5), maxG * 3);
    return Math.round((remainingGuesses + timeBonus) * dmgMult);
  }
  return 0;
}

// Check standard utilities helper
function isStatePlaying(stateStr) {
  return typeof stateStr === 'string' && stateStr.startsWith('playing');
}

/**
 * Returns true only when a player is actively in-game (not backgrounded).
 * Used to determine whether the round can resolve (both sides must be done,
 * not just backgrounded).
 */
function isStatePlayingActive(stateStr) {
  return typeof stateStr === 'string' && stateStr.startsWith('playing:');
}

/**
 * Computes how stale a heartbeat really is, accounting for any time the player
 * spent with the tab backgrounded.  If the state is playing_bg:<ts>, the player
 * paused at <ts> and hasn't come back yet — we forgive that entire elapsed gap so
 * only pre-background absence counts against the disconnect timer.
 *
 * @param {string} stateStr  - e.g. "playing:1718000000000" or "playing_bg:1718000000000"
 * @returns {number}          - effective milliseconds since last known-active heartbeat
 */
function computeEffectiveHeartbeatAge(stateStr) {
  if (typeof stateStr !== 'string') return Infinity;
  const now = getServerTime();

  if (stateStr.startsWith('playing_bg:')) {
    // Player went to background at bgTs.  We only count the age up to that
    // moment — everything after is forgiven background time.
    const bgTs = parseInt(stateStr.slice('playing_bg:'.length), 10) || 0;
    return now - bgTs;
  }

  if (stateStr.startsWith('playing:')) {
    const ts = parseInt(stateStr.slice('playing:'.length), 10) || 0;
    return now - ts;
  }

  return Infinity;
}

function parseGuessesArray(guesses) {
  if (Array.isArray(guesses)) return guesses;
  if (typeof guesses === 'string') {
    try { return JSON.parse(guesses); } catch (e) { return []; }
  }
  return [];
}

function parseBattlePlayers(battle) {
  const isFFA = isMultiplayerBattle(battle);
  const battleSettings = battle.settings || {};
  const initialMaxHp = battleSettings.startingHp || 100;
  
  if (isFFA && battle.players && Array.isArray(battle.players) && battle.players.length > 0) {
    return battle.players.map(p => ({
      ...p,
      hp: p.hp ?? initialMaxHp,
      guesses: parseGuessesArray(p.guesses)
    }));
  }
  
  return [
    {
      id: battle.player1_id,
      username: battle.player1_username,
      hp: battle.player1_hp ?? initialMaxHp,
      state: battle.player1_state,
      guesses: parseGuessesArray(battle.player1_guesses)
    },
    {
      id: battle.player2_id,
      username: battle.player2_username,
      hp: battle.player2_hp ?? initialMaxHp,
      state: battle.player2_state,
      guesses: parseGuessesArray(battle.player2_guesses)
    }
  ];
}

function isMultiplayerBattle(battle) {
  const count = battle.player_count || (battle.players?.length) || 2;
  return count > 2;
}

function syncLegacyFieldsFromPlayers(players) {
  const p1 = players[0] || {};
  const p2 = players[1] || {};
  return {
    player1_id: p1.id,
    player1_username: p1.username,
    player1_hp: p1.hp,
    player1_state: p1.state,
    player1_guesses: p1.guesses || [],
    player2_id: p2.id,
    player2_username: p2.username,
    player2_hp: p2.hp,
    player2_state: p2.state,
    player2_guesses: p2.guesses || []
  };
}

function buildPlayersPayload(players) {
  return {
    players,
    player_count: players.length,
    ...syncLegacyFieldsFromPlayers(players)
  };
}

function getRoundTimeLimitMin(battle) {
  return (battle?.settings?.timeLimit) || pvpState.roundTimeLimitMin || 3;
}

// --------------- Matchmaking Queue Operations ---------------

async function joinPvPQueue() {
  const userId = getOrCreateUserId();
  const username = localStorage.getItem('tracendle_nickname') || 'Anonymous';
  const gameType = currentGameType;

  showQueueModal(true);

  try {
    await calibrateServerTime(); // Perform clock calibration upon queueing
    await supabaseClient.from('pvp_queue_uma').delete().eq('user_id', userId);

    const { error } = await supabaseClient.from('pvp_queue_uma').insert({
      user_id: userId,
      username: username,
      game_type: gameType
    });

    if (error) throw error;

    startMatchmakingPoll();
  } catch (err) {
    console.error('Error joining queue:', err);
    showSaveTransferToast('❌ Failed to join matchmaking queue.');
    showQueueModal(false);
  }
}

async function leavePvPQueue() {
  const userId = getOrCreateUserId();
  stopQueuePoll();
  try {
    await supabaseClient.from('pvp_queue_uma').delete().eq('user_id', userId);
  } catch (err) {
    console.error('Error leaving queue:', err);
  }
  showQueueModal(false);
}

function startMatchmakingPoll() {
  stopQueuePoll();
  pvpState.queueTimer = setInterval(async () => {
    const userId = getOrCreateUserId();
    const gameType = currentGameType;

    try {
      const { data: queue, error } = await supabaseClient
        .from('pvp_queue_uma')
        .select('*')
        .eq('game_type', gameType)
        .neq('user_id', userId)
        .order('created_at', { ascending: true })
        .limit(1);

      if (error) throw error;

      if (queue && queue.length > 0) {
        const opponent = queue[0];
        stopQueuePoll();
        await setupPvPBattle(opponent);
      } else {
        const { data: battle, error: bError } = await supabaseClient
          .from('pvp_battles_uma')
          .select('*')
          .eq('status', 'active')
          .or(`player1_id.eq.${userId},player2_id.eq.${userId}`)
          .limit(1)
          .maybeSingle();

        if (bError) throw bError;

        if (battle) {
          stopQueuePoll();
          if (battle.player1_state === 'matched:waiting_ready' || battle.player2_state === 'matched:waiting_ready') {
            startReadyCheck(battle);
          } else {
            initializePvPGame(battle);
          }
        }
      }
    } catch (err) {
      console.error('Queue polling error:', err);
    }
  }, 2000);
}

function stopQueuePoll() {
  if (pvpState.queueTimer) {
    clearInterval(pvpState.queueTimer);
    pvpState.queueTimer = null;
  }
}

// --------------- Ready Check System ---------------

function startReadyCheck(battle) {
  const userId = getOrCreateUserId();
  showQueueModal(false);

  readyCheckState.battleId = battle.id;
  readyCheckState.role = userId === battle.player1_id ? 'player1' : 'player2';
  readyCheckState.secondsLeft = 20;

  showReadyCheckModal(battle);

  if (readyCheckState.countdownTimer) clearInterval(readyCheckState.countdownTimer);
  readyCheckState.countdownTimer = setInterval(() => {
    readyCheckState.secondsLeft--;
    const timerEl = document.getElementById('ready-check-countdown');
    if (timerEl) {
      timerEl.textContent = readyCheckState.secondsLeft;
    }

    if (readyCheckState.secondsLeft <= 0) {
      handleReadyCheckTimeout();
    }
  }, 1000);

  if (readyCheckState.pollTimer) clearInterval(readyCheckState.pollTimer);
  readyCheckState.pollTimer = setInterval(async () => {
    try {
      const { data: b, error } = await supabaseClient
        .from('pvp_battles_uma')
        .select('*')
        .eq('id', readyCheckState.battleId)
        .single();

      if (error || !b || b.status === 'finished') {
        abortReadyCheck('Match declined or cancelled.');
        return;
      }

      const meState = readyCheckState.role === 'player1' ? b.player1_state : b.player2_state;
      const oppState = readyCheckState.role === 'player1' ? b.player2_state : b.player1_state;

      const meIndicator = document.getElementById('ready-status-me');
      const oppIndicator = document.getElementById('ready-status-opp');

      const isMeReady = meState === 'matched:ready' || isStatePlaying(meState);
      const isOppReady = oppState === 'matched:ready' || isStatePlaying(oppState);

      if (meIndicator) {
        if (isMeReady) {
          meIndicator.className = 'text-xs font-bold text-green-600 dark:text-green-400';
          meIndicator.textContent = 'READY';
          const readyBtn = document.getElementById('ready-check-btn');
          if (readyBtn) {
            readyBtn.disabled = true;
            readyBtn.textContent = 'WAITING FOR OPPONENT...';
            readyBtn.className = 'w-full py-2.5 rounded-xl font-bold bg-slate-400 dark:bg-slate-700 text-slate-200 text-sm cursor-not-allowed';
          }
        } else {
          meIndicator.className = 'text-xs font-bold text-slate-500 dark:text-slate-400 animate-pulse';
          meIndicator.textContent = 'WAITING...';
        }
      }

      if (oppIndicator) {
        if (isOppReady) {
          oppIndicator.className = 'text-xs font-bold text-green-600 dark:text-green-400';
          oppIndicator.textContent = 'READY';
        } else {
          oppIndicator.className = 'text-xs font-bold text-slate-500 dark:text-slate-400 animate-pulse';
          oppIndicator.textContent = 'WAITING...';
        }
      }

      if (isMeReady && isOppReady) {
        clearInterval(readyCheckState.pollTimer);
        clearInterval(readyCheckState.countdownTimer);

        const alreadyPlaying = isStatePlaying(meState) && isStatePlaying(oppState);

        if (alreadyPlaying) {
          hideReadyCheckModal();
          initializePvPGame(b);
        } else {
          if (readyCheckState.role === 'player1') {
            const now = getServerTime();
            const freshExpires = new Date(now + 3 * 60 * 1000).toISOString();
            await supabaseClient
              .from('pvp_battles_uma')
              .update({
                player1_state: `playing:${now}`,
                player2_state: `playing:${now}`,
                expires_at: freshExpires,
                round_expires_at: freshExpires
              })
              .eq('id', readyCheckState.battleId);
          }

          setTimeout(async () => {
            const { data: updatedBattle, error: fetchErr } = await supabaseClient
              .from('pvp_battles_uma')
              .select('*')
              .eq('id', readyCheckState.battleId)
              .single();

            if (fetchErr || !updatedBattle) {
              abortReadyCheck('Failed to load match updates.');
              return;
            }

            hideReadyCheckModal();
            initializePvPGame(updatedBattle);
          }, 800);
        }
      }
    } catch (err) {
      console.error('Ready check state retrieval error:', err);
    }
  }, 1000);
}

async function submitReadyCheck() {
  const stateKey = readyCheckState.role === 'player1' ? 'player1_state' : 'player2_state';
  try {
    await supabaseClient
      .from('pvp_battles_uma')
      .update({ [stateKey]: 'matched:ready' })
      .eq('id', readyCheckState.battleId);
  } catch (err) {
    console.error('Error submitting ready flag:', err);
  }
}

async function declineReadyCheck() {
  abortReadyCheck('You declined the match.');
  try {
    await supabaseClient
      .from('pvp_battles_uma')
      .update({ status: 'finished' })
      .eq('id', readyCheckState.battleId);
  } catch (err) {
    console.error('Error cancelling match instance:', err);
  }
}

async function handleReadyCheckTimeout() {
  abortReadyCheck('Matchmaking timed out due to inactive response.');
  try {
    await supabaseClient
      .from('pvp_battles_uma')
      .update({ status: 'finished' })
      .eq('id', readyCheckState.battleId);
  } catch (err) {
    console.error('Error writing matchmaking timeout event:', err);
  }
}

function abortReadyCheck(message) {
  if (readyCheckState.pollTimer) clearInterval(readyCheckState.pollTimer);
  if (readyCheckState.countdownTimer) clearInterval(readyCheckState.countdownTimer);
  hideReadyCheckModal();
  if (message) {
    showSaveTransferToast(`❌ ${message}`);
  }
  cleanupPvPSession();
}

function showReadyCheckModal(battle) {
  let modal = document.getElementById('pvp-ready-check-modal');
  const opponentName = readyCheckState.role === 'player1' ? battle.player2_username : battle.player1_username;

  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'pvp-ready-check-modal';
    modal.className = 'fixed inset-0 bg-black/75 backdrop-blur-sm z-[250] flex items-center justify-center p-4';
    document.body.appendChild(modal);
  }

  modal.innerHTML = `
    <div class="bg-white dark:bg-slate-800 rounded-2xl max-w-sm w-full p-6 text-center border-t-8 border-red-700 shadow-2xl flex flex-col gap-4">
      <div class="text-4xl animate-pulse">🎯</div>
      <h2 class="text-xl font-black text-slate-800 dark:text-slate-100 uppercase tracking-wide">Match Found!</h2>
      <p class="text-xs text-slate-500 dark:text-slate-400">Match opponent detected: <strong class="text-red-700 dark:text-red-400 font-bold">${escapeHtml(opponentName)}</strong></p>
      
      <div class="flex flex-col gap-2 p-3 bg-slate-50 dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700">
        <div class="flex justify-between items-center text-xs text-slate-600 dark:text-slate-300">
          <span>You:</span>
          <span id="ready-status-me" class="font-bold text-slate-500">WAITING...</span>
        </div>
        <div class="flex justify-between items-center text-xs text-slate-600 dark:text-slate-300">
          <span>Opponent:</span>
          <span id="ready-status-opp" class="font-bold text-slate-500">WAITING...</span>
        </div>
      </div>

      <div class="text-sm font-bold text-red-600 dark:text-red-400">
        Time to respond: <span id="ready-check-countdown" class="font-mono text-base font-black">20</span>s
      </div>

      <div class="flex gap-2">
        <button id="ready-check-btn" onclick="submitReadyCheck()" class="btn-primary flex-1 py-2.5 rounded-xl font-bold transition-all text-sm">Accept</button>
        <button onclick="declineReadyCheck()" class="btn-secondary py-2.5 px-4 rounded-xl font-bold transition-all text-sm border-2 border-slate-200 dark:border-slate-700">Decline</button>
      </div>
    </div>
  `;
}

function hideReadyCheckModal() {
  const modal = document.getElementById('pvp-ready-check-modal');
  if (modal) modal.remove();
}

// --------------- Setup & Initialisation ---------------

async function createBattleFromLobby(allPlayers, gameType, modSettings = {}, lobbyId = null) {
  const dataList = GAME_CONFIG[gameType].data();
  const target = dataList[Math.floor(Math.random() * dataList.length)];
  const timeLimitMin = modSettings?.timeLimit || 3;
  
  await calibrateServerTime(); // Perform baseline sync
  const expiresAt = new Date(getServerTime() + timeLimitMin * 60 * 1000).toISOString();
  const now = getServerTime();
  const startingHp = modSettings?.startingHp || 100;

  const players = allPlayers.map(p => ({
    id: p.user_id,
    username: p.username,
    hp: startingHp,
    state: `playing:${now}`,
    guesses: []
  }));

  try {
    const { data: battle, error } = await supabaseClient
      .from('pvp_battles_uma')
      .insert({
        target_name: target.name,
        game_type: gameType,
        expires_at: expiresAt,
        round_expires_at: expiresAt,
        lobby_id: lobbyId,
        settings: modSettings || {},
        ...buildPlayersPayload(players)
      })
      .select()
      .single();

    if (error) throw error;
    return battle;
  } catch (err) {
    console.error('Error creating lobby battle:', err);
    showSaveTransferToast('❌ Failed to create battle.');
    return null;
  }
}

async function setupPvPBattle(opponent) {
  const userId = getOrCreateUserId();
  const username = localStorage.getItem('tracendle_nickname') || 'Anonymous';
  const gameType = currentGameType;
  const dataList = GAME_CONFIG[gameType].data();
  
  const target = dataList[Math.floor(Math.random() * dataList.length)];
  
  await calibrateServerTime(); // Perform baseline sync
  const roundExpiresAt = new Date(getServerTime() + 3 * 60 * 1000).toISOString();

  try {
    await supabaseClient.from('pvp_queue_uma').delete().in('user_id', [userId, opponent.user_id]);

    const { data: battle, error } = await supabaseClient
      .from('pvp_battles_uma')
      .insert({
        player1_id: userId,
        player1_username: username,
        player2_id: opponent.user_id,
        player2_username: opponent.username,
        target_name: target.name,
        game_type: gameType,
        expires_at: roundExpiresAt,
        round_expires_at: roundExpiresAt,
        player1_state: 'matched:waiting_ready',
        player2_state: 'matched:waiting_ready',
        player1_hp: 100,
        player2_hp: 100
      })
      .select()
      .single();

    if (error) throw error;

    startReadyCheck(battle);
  } catch (err) {
    console.error('Error creating battle:', err);
    joinPvPQueue();
  }
}

function initializePvPGame(battle) {
  const userId = getOrCreateUserId();
  showQueueModal(false);

  if (typeof switchGameType === 'function') {
    switchGameType(battle.game_type);
  } else {
    currentGameType = battle.game_type;
  }

  const battleSettings = battle.settings || {};
  pvpState.hardModeActive = !!battleSettings.hardMode;
  pvpState.maxHp = battleSettings.startingHp || 100;
  
  // Set customizable Sudden Death settings
  pvpState.suddenDeathRound = battleSettings.suddenDeathRound !== undefined ? battleSettings.suddenDeathRound : 6;

  pvpState.isFFA = isMultiplayerBattle(battle);
  pvpState.allPlayers = parseBattlePlayers(battle);
  pvpState.mySlot = pvpState.allPlayers.findIndex(p => p.id === userId);
  if (pvpState.mySlot < 0) pvpState.mySlot = 0;

  const me = pvpState.allPlayers[pvpState.mySlot];
  const firstOpponent = pvpState.allPlayers.find((p, i) => i !== pvpState.mySlot);

  if (pvpState.mySlot === 0) {
    pvpState.role = 'player1';
  } else if (pvpState.mySlot === 1) {
    pvpState.role = 'player2';
  } else {
    pvpState.role = `player${pvpState.mySlot + 1}`;
  }

  pvpState.opponentId = firstOpponent?.id || battle.player2_id;
  pvpState.opponentName = firstOpponent?.username || battle.player2_username;
  pvpState.opponentGuesses = firstOpponent?.guesses || [];

  pvpState.battleId = battle.id;
  pvpState.myHp = me?.hp ?? pvpState.maxHp;
  pvpState.opponentHp = firstOpponent?.hp ?? pvpState.maxHp;
  pvpState.prevHpMap = {};
  pvpState.allPlayers.forEach(p => { pvpState.prevHpMap[p.id] = p.hp; });

  pvpState.currentRound = battle.round_number || 1;
  pvpState.isWaitingForOpponent = false;
  pvpState.lastHeartbeatSent = getServerTime();
  pvpState.formattedTime = "03:00";

  sessionState.active = true;
  sessionState.mode = 'pvp';
  sessionState.isGameOver = false;
  sessionState.guesses = [];
  sessionState.knownStats = {};
  
  const config = GAME_CONFIG[battle.game_type];
  const dataList = config.data();
  sessionState.target = dataList.find(item => item.name === battle.target_name);

  sessionState.clues = [];
  if (pvpState.hardModeActive && battle.game_type !== 'voicedle') {
    const otherItems = dataList.filter(item => item.name !== battle.target_name);
    sessionState.clues = otherItems.sort(() => 0.5 - Math.random()).slice(0, 3);
  }

  renderGameLayout();
  injectPvPHeaders();

  if (pvpState.hardModeActive && battle.game_type !== 'voicedle') {
    sessionState.clues.forEach(c => addGuessRow(c, true));
  }

  pvpState.roundTimeLimitMin = battleSettings.timeLimit || 3;
  if (battleSettings.maxGuesses && battleSettings.maxGuesses !== 5) {
    pvpState.maxGuesses = battleSettings.maxGuesses;
  } else {
    pvpState.maxGuesses = 5;
  }
  if (battleSettings.damageMultiplier) {
    pvpState.damageMultiplier = battleSettings.damageMultiplier;
  } else {
    pvpState.damageMultiplier = 1;
  }

  pvpState.roundTimeoutHandled = false;
  const roundExpiry = battle.round_expires_at
    ? new Date(battle.round_expires_at)
    : new Date(getServerTime() + pvpState.roundTimeLimitMin * 60 * 1000);
  startPvPTimer(roundExpiry);

  startBattlePoll();
}

// --------------- UI Decoration for PvP ---------------

function injectPvPHeaders() {
  const container = document.getElementById('game-toolbar');
  if (!container) return;

  let pvpBar = document.getElementById('pvp-hp-interface');
  if (!pvpBar) {
    pvpBar = document.createElement('div');
    pvpBar.id = 'pvp-hp-interface';
    container.after(pvpBar);
  }
  pvpBar.className = pvpState.isFFA
    ? 'w-full flex flex-col gap-3 pvp-interface-panel p-3 rounded-xl border my-2'
    : 'w-full flex flex-col md:flex-row justify-between items-center gap-4 pvp-interface-panel p-3 rounded-xl border my-2';

  updateHpDisplay();
}

function updateHpDisplay() {
  const pvpBar = document.getElementById('pvp-hp-interface');
  if (!pvpBar) return;

  if (pvpState.isFFA) {
    updateFFAHPDisplay(pvpBar);
    updateGuessCountUI();
    return;
  }

  const username = localStorage.getItem('tracendle_nickname') || 'You';
  const targetName = sessionState.target?.name || '';
  
  let opponentGuesses = pvpState.opponentGuesses;
  if (typeof opponentGuesses === 'string') {
    try { opponentGuesses = JSON.parse(opponentGuesses); } catch (e) { opponentGuesses = []; }
  }
  if (!Array.isArray(opponentGuesses)) { opponentGuesses = []; }
  const opponentGuessCount = opponentGuesses.length;

  let opponentProgressionHtml = '';
  if (pvpState.opponentId) {
    const oppDots = Array.from({ length: pvpState.maxGuesses }, (_, i) => {
      if (i < opponentGuessCount) {
        const guess = opponentGuesses[i];
        const isCorrect = guess && targetName && (guess.name === targetName);
        if (isCorrect) {
          return `<span style="display: inline-block; width: 14px; height: 14px; border-radius: 4px; background-color: #22c55e; border: 1.5px solid #16a34a; transition: all 0.3s;"></span>`;
        }
        return `<span style="display: inline-block; width: 14px; height: 14px; border-radius: 4px; background-color: #ef4444; border: 1.5px solid #dc2626; transition: all 0.3s;"></span>`;
      }
      return `<span style="display: inline-block; width: 14px; height: 14px; border-radius: 4px; background-color: #09090b; border: 1.5px solid #27272a; transition: all 0.3s;"></span>`;
    }).join('');

    opponentProgressionHtml = `
      <div style="display: flex; align-items: center; gap: 4px; margin-top: 4px; justify-content: flex-end;">
        <span style="font-size: 10px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em; margin-right: 4px;">Guesses:</span>
        ${oppDots}
      </div>
    `;
  }

  let myGuesses = sessionState.guesses;
  if (typeof myGuesses === 'string') {
    try { myGuesses = JSON.parse(myGuesses); } catch (e) { myGuesses = []; }
  }
  if (!Array.isArray(myGuesses)) { myGuesses = []; }
  const myGuessCount = myGuesses.length;

  const myDots = Array.from({ length: pvpState.maxGuesses }, (_, i) => {
    if (i < myGuessCount) {
      const guess = myGuesses[i];
      const isCorrect = guess && targetName && (guess.name === targetName);
      if (isCorrect) {
        return `<span style="display: inline-block; width: 14px; height: 14px; border-radius: 4px; background-color: #22c55e; border: 1.5px solid #16a34a; transition: all 0.3s;"></span>`;
      }
      return `<span style="display: inline-block; width: 14px; height: 14px; border-radius: 4px; background-color: #ef4444; border: 1.5px solid #dc2626; transition: all 0.3s;"></span>`;
    }
    return `<span style="display: inline-block; width: 14px; height: 14px; border-radius: 4px; background-color: #09090b; border: 1.5px solid #27272a; transition: all 0.3s;"></span>`;
  }).join('');

  const myProgressionHtml = `
    <div style="display: flex; align-items: center; gap: 4px; margin-top: 4px; justify-content: flex-start;">
      <span style="font-size: 10px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em; margin-right: 4px;">Guesses:</span>
      ${myDots}
    </div>
  `;

  const myHpPercent = (pvpState.myHp / pvpState.maxHp) * 100;
  const oppHpPercent = (pvpState.opponentHp / pvpState.maxHp) * 100;

  // Render customizable Sudden Death indicator
  const suddenDeathActive = pvpState.suddenDeathRound > 0 && pvpState.currentRound >= pvpState.suddenDeathRound;
  const roundDisplayHtml = suddenDeathActive
    ? `<div class="tracking-widest text-red-600 dark:text-red-500 font-extrabold animate-pulse pvp-sudden-death-glow text-[11px] md:text-xs">⚡ SUDDEN DEATH (R${pvpState.currentRound})</div>`
    : `<div class="tracking-widest">ROUND ${pvpState.currentRound}</div>`;

  pvpBar.innerHTML = `
    <!-- Left Column: You -->
    <div id="pvp-player-col" class="flex-1 w-full p-2">
      <div class="flex justify-between text-xs font-bold mb-1">
        <span class="text-green-700 dark:text-green-400">${username} (You)</span>
        <span>${pvpState.myHp} / ${pvpState.maxHp} HP</span>
      </div>
      <div class="w-full bg-slate-300 dark:bg-slate-700 h-4 rounded-full overflow-hidden">
        <div class="bg-green-600 h-full transition-all duration-500" style="width: ${myHpPercent}%"></div>
      </div>
      ${myProgressionHtml}
    </div>
    
    <!-- Middle Column: Stats -->
    <div class="flex flex-col items-center justify-center px-4 font-black text-red-600 dark:text-red-400 text-sm text-center">
      ${roundDisplayHtml}
      <div id="pvp-match-timer" class="text-xs font-mono text-slate-500 dark:text-slate-400 mt-0.5">${pvpState.formattedTime}</div>
    </div>
    
    <!-- Right Column: Opponent -->
    <div id="pvp-opponent-col" class="flex-1 w-full p-2">
      <div class="flex justify-between text-xs font-bold mb-1">
        <span class="text-red-700 dark:text-red-400">${pvpState.opponentName}</span>
        <span>${pvpState.opponentHp} / ${pvpState.maxHp} HP</span>
      </div>
      <div class="w-full bg-slate-300 dark:bg-slate-700 h-4 rounded-full overflow-hidden">
        <div class="bg-red-600 h-full transition-all duration-500" style="width: ${oppHpPercent}%"></div>
      </div>
      ${opponentProgressionHtml}
    </div>
  `;

  updateGuessCountUI();
}

function updateFFAHPDisplay(pvpBar) {
  const username = localStorage.getItem('tracendle_nickname') || 'You';
  const me = pvpState.allPlayers[pvpState.mySlot];
  const myGuesses = sessionState.guesses || [];
  const showProgress = pvpState.allPlayers.length <= 4;
  const targetName = sessionState.target?.name || '';

  const opponentsHtml = pvpState.allPlayers
    .map((p, i) => {
      if (i === pvpState.mySlot) return '';
      const guesses = parseGuessesArray(p.guesses);
      const isEliminated = p.hp <= 0 || p.state === 'exited';
      const oppHpPercent = (p.hp / pvpState.maxHp) * 100;
      return `
        <div id="pvp-opp-col-${i}" class="pvp-ffa-opponent p-2 rounded-lg border border-slate-200 dark:border-slate-600 ${isEliminated ? 'opacity-40' : ''}">
          <div class="flex justify-between text-[10px] font-bold mb-1">
            <span class="text-red-700 dark:text-red-400 truncate">${p.username}</span>
            <span>${p.hp} / ${pvpState.maxHp} HP</span>
          </div>
          <div class="w-full bg-slate-300 dark:bg-slate-700 h-3 rounded-full overflow-hidden">
            <div class="bg-red-600 h-full transition-all duration-500" style="width: ${oppHpPercent}%"></div>
          </div>
          ${showProgress ? renderGuessDots(guesses, pvpState.maxGuesses, 'end', targetName) : ''}
        </div>`;
    })
    .join('');

  const myHpPercent = ((me?.hp ?? pvpState.myHp) / pvpState.maxHp) * 100;

  // Custom header banner when FFA hits Sudden Death
  const suddenDeathActive = pvpState.suddenDeathRound > 0 && pvpState.currentRound >= pvpState.suddenDeathRound;
  
  const ffaHeaderTitle = suddenDeathActive
    ? `<div class="text-xs font-black text-red-600 dark:text-red-500 uppercase tracking-widest animate-pulse pvp-sudden-death-glow">⚡ SUDDEN DEATH FFA · ${pvpState.allPlayers.length} Players</div>`
    : `<div class="text-xs font-black text-red-600 dark:text-red-400 uppercase tracking-widest">FFA · ${pvpState.allPlayers.length} Players</div>`;

  const roundDisplayHtml = suddenDeathActive
    ? `<div class="tracking-widest text-xs text-red-600 dark:text-red-500 font-extrabold animate-pulse text-right">SUDDEN DEATH (R${pvpState.currentRound})</div>`
    : `<div class="tracking-widest text-xs">ROUND ${pvpState.currentRound}</div>`;

  pvpBar.innerHTML = `
    <div class="flex items-center justify-between w-full">
      ${ffaHeaderTitle}
      <div class="flex flex-col items-end font-black text-red-600 dark:text-red-400 text-sm">
        ${roundDisplayHtml}
        <div id="pvp-match-timer" class="text-xs font-mono text-slate-500 dark:text-slate-400">${pvpState.formattedTime}</div>
      </div>
    </div>
    <div id="pvp-player-col" class="w-full p-2 rounded-lg border-2 border-green-600/40 bg-green-50/50 dark:bg-green-950/20">
      <div class="flex justify-between text-xs font-bold mb-1">
        <span class="text-green-700 dark:text-green-400">${username} (You)</span>
        <span>${me?.hp ?? pvpState.myHp} / ${pvpState.maxHp} HP</span>
      </div>
      <div class="w-full bg-slate-300 dark:bg-slate-700 h-4 rounded-full overflow-hidden">
        <div class="bg-green-600 h-full transition-all duration-500" style="width: ${myHpPercent}%"></div>
      </div>
      ${renderGuessDots(myGuesses, pvpState.maxGuesses, 'start', targetName)}
    </div>
    <div class="grid grid-cols-2 md:grid-cols-3 gap-2 w-full">
      ${opponentsHtml}
    </div>
  `;
}

function renderGuessDots(guesses, max, align = 'start', targetName = '') {
  const justify = align === 'end' ? 'justify-content: flex-end;' : 'justify-content: flex-start;';
  const guessesArr = parseGuessesArray(guesses);
  const count = guessesArr.length;

  const dotsHtml = Array.from({ length: max }, (_, i) => {
    if (i < count) {
      const guess = guessesArr[i];
      const isCorrect = guess && targetName && (guess.name === targetName);
      if (isCorrect) {
        return `<span style="display: inline-block; width: 14px; height: 14px; border-radius: 4px; background-color: #22c55e; border: 1.5px solid #16a34a; transition: all 0.3s;"></span>`;
      }
      return `<span style="display: inline-block; width: 14px; height: 14px; border-radius: 4px; background-color: #ef4444; border: 1.5px solid #dc2626; transition: all 0.3s;"></span>`;
    }
    return `<span style="display: inline-block; width: 14px; height: 14px; border-radius: 4px; background-color: #09090b; border: 1.5px solid #27272a; transition: all 0.3s;"></span>`;
  }).join('');

  return `
    <div style="display: flex; align-items: center; gap: 4px; margin-top: 4px; ${justify}">
      <span style="font-size: 10px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em; margin-right: 4px;">Guesses:</span>
      ${dotsHtml}
    </div>`;
}

function startPvPTimer(expiresTime) {
  if (pvpState.matchTimer) clearInterval(pvpState.matchTimer);

  pvpState.roundExpiresAt = expiresTime instanceof Date ? expiresTime : new Date(expiresTime);
  pvpState.formattedTime = formatTimerFromMs(pvpState.roundExpiresAt - getServerTime());

  pvpState.matchTimer = setInterval(() => {
    const diff = pvpState.roundExpiresAt - getServerTime();

    if (diff <= 0) {
      clearInterval(pvpState.matchTimer);
      pvpState.matchTimer = null;
      pvpState.formattedTime = '00:00';
      const timerEl = document.getElementById('pvp-match-timer');
      if (timerEl) timerEl.textContent = '00:00';
      handlePvPRoundTimeout();
      return;
    }

    pvpState.formattedTime = formatTimerFromMs(diff);
    const timerEl = document.getElementById('pvp-match-timer');
    if (timerEl) timerEl.textContent = pvpState.formattedTime;
  }, 1000);
}

async function markPvPPlayerTimedOut() {
  if (!pvpState.battleId) return;

  try {
    const { data: battle } = await supabaseClient
      .from('pvp_battles_uma')
      .select('*')
      .eq('id', pvpState.battleId)
      .single();

    if (!battle || battle.status !== 'active') return;

    if (pvpState.isFFA) {
      const players = parseBattlePlayers(battle);
      const me = players[pvpState.mySlot];
      if (!me || !isStatePlaying(me.state)) return;
      players[pvpState.mySlot] = { ...me, state: 'finished_lost' };
      await supabaseClient.from('pvp_battles_uma')
        .update(buildPlayersPayload(players))
        .eq('id', pvpState.battleId);
      pvpState.allPlayers = players;
    } else {
      const key = pvpState.role === 'player1' ? 'player1_state' : 'player2_state';
      if (!isStatePlaying(battle[key])) return;
      await supabaseClient.from('pvp_battles_uma')
        .update({ [key]: 'finished_lost' })
        .eq('id', pvpState.battleId);
    }
  } catch (err) {
    console.error('Mark timed out error:', err);
  }
}

async function processTimeoutRoundAsHost() {
  if (pvpState.mySlot !== 0 || !pvpState.battleId) return;

  try {
    const { data: battle } = await supabaseClient
      .from('pvp_battles_uma')
      .select('*')
      .eq('id', pvpState.battleId)
      .single();

    if (!battle || battle.status !== 'active') return;

    let battleForResolution = battle;

    if (pvpState.isFFA) {
      const players = parseBattlePlayers(battle).map(p => {
        if (p.hp > 0 && p.state !== 'exited' && isStatePlaying(p.state)) {
          return { ...p, state: 'finished_lost' };
        }
        return p;
      });
      battleForResolution = { ...battle, ...buildPlayersPayload(players) };
      await supabaseClient.from('pvp_battles_uma')
        .update(buildPlayersPayload(players))
        .eq('id', pvpState.battleId);
    } else {
      const updates = {};
      if (isStatePlaying(battle.player1_state)) updates.player1_state = 'finished_lost';
      if (isStatePlaying(battle.player2_state)) updates.player2_state = 'finished_lost';
      if (Object.keys(updates).length > 0) {
        await supabaseClient.from('pvp_battles_uma').update(updates).eq('id', pvpState.battleId);
        battleForResolution = { ...battle, ...updates };
      }
    }

    await processRoundResolution(battleForResolution);
  } catch (err) {
    console.error('Host timeout resolution error:', err);
  }
}

async function handlePvPRoundTimeout() {
  if (!pvpState.battleId || pvpState.roundTimeoutHandled) return;
  pvpState.roundTimeoutHandled = true;

  pvpState.isWaitingForOpponent = true;
  document.getElementById('input-container')?.classList.add('hidden');
  showPvPWaitingScreen(true, '⏱️ Round time expired! Resolving round...');

  await markPvPPlayerTimedOut();

  if (pvpState.mySlot === 0) {
    setTimeout(() => processTimeoutRoundAsHost(), 600);
  }
}

// --------------- PvP Battle Loop / Real-time Sync ---------------

function startBattlePoll() {
  if (pvpState.pollTimer) clearInterval(pvpState.pollTimer);

  pvpState.pollTimer = setInterval(async () => {
    if (!pvpState.battleId) return;
    if (pvpState.isShowingRoundResolution) return;

    try {
      const { data: battle, error } = await supabaseClient
        .from('pvp_battles_uma')
        .select('*')
        .eq('id', pvpState.battleId)
        .single();

      if (error) throw error;

      const players = parseBattlePlayers(battle);
      const userId = getOrCreateUserId();
      const myPlayer = players[pvpState.mySlot];

      // INTERCEPT ROUND TRANSITION IMMEDIATELY
      if (battle.round_number > pvpState.currentRound && battle.status === 'active') {
        const oldRound = pvpState.currentRound;
        pvpState.currentRound = battle.round_number;
        pvpState.isShowingRoundResolution = true;

        let newMyHp, newOppHp;
        let ffaPlayersData = [];

        if (pvpState.isFFA) {
          const oldPlayers = [...pvpState.allPlayers];
          const newPlayers = players;
          
          const myP = newPlayers[pvpState.mySlot];
          const firstOpp = newPlayers.find((p, idx) => idx !== pvpState.mySlot);
          newMyHp = myP ? myP.hp : pvpState.myHp;
          newOppHp = firstOpp ? firstOpp.hp : pvpState.opponentHp;

          ffaPlayersData = newPlayers.map((p, idx) => {
            const oldP = oldPlayers[idx] || p;
            return {
              username: p.username,
              oldHp: oldP.hp,
              newHp: p.hp,
              dmg: Math.max(0, oldP.hp - p.hp),
              isMe: idx === pvpState.mySlot
            };
          });
        } else {
          const isP1 = pvpState.role === 'player1';
          newMyHp = isP1 ? battle.player1_hp : battle.player2_hp;
          newOppHp = isP1 ? battle.player2_hp : battle.player1_hp;
        }

        const myOldHp = pvpState.myHp;
        const oppOldHp = pvpState.opponentHp;

        showPvPRoundResolutionModal({
          round: oldRound,
          isFFA: pvpState.isFFA,
          myOldHp: myOldHp,
          myNewHp: newMyHp,
          myDmg: Math.max(0, myOldHp - newMyHp),
          oppOldHp: oppOldHp,
          oppNewHp: newOppHp,
          oppDmg: Math.max(0, oppOldHp - newOppHp),
          oppName: pvpState.opponentName,
          ffaPlayers: ffaPlayersData
        }, () => {
          pvpState.myHp = newMyHp;
          pvpState.opponentHp = newOppHp;
          if (pvpState.isFFA) {
            pvpState.allPlayers = players;
            pvpState.allPlayers.forEach(p => { pvpState.prevHpMap[p.id] = p.hp; });
          }
          pvpState.isShowingRoundResolution = false;
          handleRoundReset(
            battle.round_number, battle.target_name, battle.game_type, battle.round_expires_at
          );
        });
        return;
      }

      if (pvpState.isFFA) {
        pvpState.allPlayers = players;

        if (myPlayer?.state === 'exited') {
          clearInterval(pvpState.pollTimer);
          clearInterval(pvpState.matchTimer);
          const winner = players.find(p => p.hp > 0 && p.state !== 'exited');
          showPvPResultModal({
            battle,
            winnerId: winner?.id || 'draw',
            reason: 'forfeit'
          });
          document.getElementById('input-container').classList.add('hidden');
          return;
        }

        const alive = players.filter(p => p.hp > 0 && p.state !== 'exited');
        if (alive.length === 1 && alive[0].id === userId && battle.status === 'active') {
          await supabaseClient.from('pvp_battles_uma').update({
            status: 'finished', winner_id: userId
          }).eq('id', pvpState.battleId);
          clearInterval(pvpState.pollTimer);
          clearInterval(pvpState.matchTimer);
          declarePvPWinner(userId, battle);
          return;
        }

        // DYNAMIC HOST HANDOVER: Lowest active, non-timed-out player index assumes cleanup duty
        const dynamicHostIdx = players.findIndex(p => {
          if (p.hp <= 0 || p.state === 'exited') return false;
          if (isStatePlaying(p.state)) {
            // Use effective age so a backgrounded player isn't wrongly excluded
            if (computeEffectiveHeartbeatAge(p.state) > PVP_DC_TIMEOUT_MS) {
              return false; // Timed out player cannot be dynamic host
            }
          }
          return true;
        });

        if (pvpState.mySlot === dynamicHostIdx && dynamicHostIdx !== -1) {
          let stateChanged = false;
          for (let i = 0; i < players.length; i++) {
            if (i === pvpState.mySlot) continue;
            const opp = players[i];
            if (opp.state === 'exited' || opp.hp <= 0) continue;
            if (isStatePlaying(opp.state)) {
              if (computeEffectiveHeartbeatAge(opp.state) > PVP_DC_TIMEOUT_MS) {
                players[i] = { ...opp, state: 'exited' };
                stateChanged = true;
              }
            }
          }

          if (stateChanged) {
            const stillAlive = players.filter(p => p.hp > 0 && p.state !== 'exited');
            const payload = { ...buildPlayersPayload(players) };
            if (stillAlive.length === 1) {
              payload.status = 'finished';
              payload.winner_id = stillAlive[0].id;
            } else if (stillAlive.length === 0) {
              payload.status = 'finished';
              payload.winner_id = 'draw';
            }
            await supabaseClient.from('pvp_battles_uma').update(payload).eq('id', pvpState.battleId);
          }
        }

        // Heartbeat verification guard: Avoid rewriting states if the user is finished
        const nowMs = getServerTime();
        if (nowMs - pvpState.lastHeartbeatSent > 4000 && !sessionState.isGameOver && !pvpState.isWaitingForOpponent) {
          pvpState.lastHeartbeatSent = nowMs;
          const updated = [...players];
          updated[pvpState.mySlot] = { ...updated[pvpState.mySlot], state: `playing:${nowMs}` };
          supabaseClient.from('pvp_battles_uma')
            .update(buildPlayersPayload(updated))
            .eq('id', pvpState.battleId)
            .then(({ error }) => { if (error) pvpState.lastHeartbeatSent = 0; });
        }

        players.forEach((p, i) => {
          const prev = pvpState.prevHpMap[p.id] ?? p.hp;
          if (prev > p.hp) {
            if (i === pvpState.mySlot) triggerDamageAnimation('player', prev - p.hp);
            else triggerDamageAnimation(`opp-${i}`, prev - p.hp);
          }
          pvpState.prevHpMap[p.id] = p.hp;
        });

        pvpState.myHp = myPlayer?.hp ?? pvpState.myHp;
        const firstOpp = players.find((p, i) => i !== pvpState.mySlot);
        pvpState.opponentHp = firstOpp?.hp ?? 0;
        pvpState.opponentGuesses = firstOpp?.guesses || [];

        updateHpDisplay();

        const activeInRound = players.filter(p => p.hp > 0 && p.state !== 'exited');
        const anyPlaying = activeInRound.some(p => isStatePlaying(p.state));
        if (!anyPlaying && activeInRound.length > 0 && battle.status === 'active') {
          processRoundResolution(battle);
        }
      } else {
        if (battle.player1_state === 'exited' || battle.player2_state === 'exited') {
          clearInterval(pvpState.pollTimer);
          clearInterval(pvpState.matchTimer);
          const isOpponentExit = (pvpState.role === 'player1' && battle.player2_state === 'exited') ||
                                 (pvpState.role === 'player2' && battle.player1_state === 'exited');
          showPvPResultModal({
            battle,
            winnerId: isOpponentExit ? userId : battle[pvpState.role === 'player1' ? 'player2_id' : 'player1_id'],
            reason: isOpponentExit ? 'opponent_left' : 'forfeit'
          });
          document.getElementById('input-container').classList.add('hidden');
          return;
        }

        const opponentState = pvpState.role === 'player1' ? battle.player2_state : battle.player1_state;
        if (isStatePlaying(opponentState)) {
          if (computeEffectiveHeartbeatAge(opponentState) > PVP_DC_TIMEOUT_MS) {
            clearInterval(pvpState.pollTimer);
            clearInterval(pvpState.matchTimer);
            await supabaseClient.from('pvp_battles_uma').update({
              status: 'finished',
              winner_id: userId,
              [pvpState.role === 'player1' ? 'player2_state' : 'player1_state']: 'exited'
            }).eq('id', pvpState.battleId);
            showPvPResultModal({ battle, winnerId: userId, reason: 'disconnect' });
            return;
          }
        }

        // Heartbeat verification guard: Avoid rewriting states if the user is finished
        const nowMs = getServerTime();
        if (nowMs - pvpState.lastHeartbeatSent > 4000 && !sessionState.isGameOver && !pvpState.isWaitingForOpponent) {
          pvpState.lastHeartbeatSent = nowMs;
          const myStateKey = pvpState.role === 'player1' ? 'player1_state' : 'player2_state';
          supabaseClient.from('pvp_battles_uma')
            .update({ [myStateKey]: `playing:${nowMs}` })
            .eq('id', pvpState.battleId)
            .then(({ error }) => { if (error) pvpState.lastHeartbeatSent = 0; });
        }

        const newMyHp = pvpState.role === 'player1' ? battle.player1_hp : battle.player2_hp;
        const newOpponentHp = pvpState.role === 'player1' ? battle.player2_hp : battle.player1_hp;
        if (pvpState.myHp - newMyHp > 0) triggerDamageAnimation('player', pvpState.myHp - newMyHp);
        if (pvpState.opponentHp - newOpponentHp > 0) triggerDamageAnimation('opponent', pvpState.opponentHp - newOpponentHp);
        pvpState.myHp = newMyHp;
        pvpState.opponentHp = newOpponentHp;
        pvpState.opponentGuesses = (pvpState.role === 'player1' ? battle.player2_guesses : battle.player1_guesses) || [];

        updateHpDisplay();

        const p1Active = isStatePlaying(battle.player1_state);
        const p2Active = isStatePlaying(battle.player2_state);
        if (!p1Active && !p2Active && battle.status === 'active') {
          processRoundResolution(battle);
        }
      }

      if (battle.status === 'finished') {
        clearInterval(pvpState.pollTimer);
        clearInterval(pvpState.matchTimer);
        declarePvPWinner(battle.winner_id, battle);
      }
    } catch (err) {
      console.error('Battle polling error:', err);
    }
  }, 1500);
}

// --------------- Tab Visibility Heartbeat ---------------

(function setupPvPVisibilityHeartbeat() {
  document.addEventListener('visibilitychange', () => {
    // Return early if the player is waiting for an opponent to complete their turns.
    if (!pvpState.battleId || sessionState.isGameOver || pvpState.isWaitingForOpponent) return;

    if (document.visibilityState === 'hidden') {
      // Write a "paused" timestamp so opponents can see exactly when we backgrounded.
      // State format: playing_bg:<backgrounded_at_ms>
      // This lets the disconnect detector subtract the backgrounded duration before
      // flagging a disconnect, preventing false-positive forfeits from brief app switches.
      const nowMs = getServerTime();
      pvpState.lastHeartbeatSent = nowMs;
      if (pvpState.isFFA) {
        const updated = pvpState.allPlayers.map((p, i) =>
          i === pvpState.mySlot ? { ...p, state: `playing_bg:${nowMs}` } : p
        );
        supabaseClient.from('pvp_battles_uma')
          .update(buildPlayersPayload(updated))
          .eq('id', pvpState.battleId).then(() => {});
      } else {
        const myStateKey = pvpState.role === 'player1' ? 'player1_state' : 'player2_state';
        supabaseClient.from('pvp_battles_uma')
          .update({ [myStateKey]: `playing_bg:${nowMs}` })
          .eq('id', pvpState.battleId).then(() => {});
      }
    } else if (document.visibilityState === 'visible') {
      // Tab is foregrounded: fire an immediate heartbeat to close the gap and
      // restart the poll so state is refreshed without waiting for the next tick.
      pvpState.lastHeartbeatSent = 0; // Force heartbeat on the very next poll tick
      const nowMs = getServerTime();
      if (pvpState.isFFA) {
        const updated = pvpState.allPlayers.map((p, i) =>
          i === pvpState.mySlot ? { ...p, state: `playing:${nowMs}` } : p
        );
        supabaseClient.from('pvp_battles_uma')
          .update(buildPlayersPayload(updated))
          .eq('id', pvpState.battleId).then(() => {});
      } else {
        const myStateKey = pvpState.role === 'player1' ? 'player1_state' : 'player2_state';
        supabaseClient.from('pvp_battles_uma')
          .update({ [myStateKey]: `playing:${nowMs}` })
          .eq('id', pvpState.battleId).then(() => {});
      }
      // Restart the poll so it fires immediately rather than waiting for the frozen interval
      startBattlePoll();
    }
  });
})();

// --------------- Intercepting Existing Guess Mechanics ---------------

async function submitPvPGuess(guessItem) {
  if (sessionState.isGameOver || pvpState.isWaitingForOpponent) return;

  sessionState.guesses.push(guessItem);
  updateKnownStats(guessItem);
  addGuessRow(guessItem, false, true);
  updateGuessCountUI();

  const isWin = guessItem.name === sessionState.target.name;
  const isLoss = sessionState.guesses.length >= pvpState.maxGuesses;

  let stateUpdate;
  if (isWin) {
    const msRemaining = pvpState.roundExpiresAt ? (pvpState.roundExpiresAt - getServerTime()) : 0;
    const secRemaining = Math.max(0, Math.floor(msRemaining / 1000));
    stateUpdate = `finished_won:${secRemaining}`;
  } else if (isLoss) {
    stateUpdate = 'finished_lost';
  } else {
    stateUpdate = `playing:${getServerTime()}`;
  }

  const currentGuesses = sessionState.guesses;

  let updatePayload;
  if (pvpState.isFFA) {
    const players = [...pvpState.allPlayers];
    players[pvpState.mySlot] = {
      ...players[pvpState.mySlot],
      guesses: currentGuesses,
      state: stateUpdate
    };
    updatePayload = buildPlayersPayload(players);
    pvpState.allPlayers = players;
  } else {
    updatePayload = {};
    if (pvpState.role === 'player1') {
      updatePayload.player1_guesses = currentGuesses;
      updatePayload.player1_state = stateUpdate;
    } else {
      updatePayload.player2_guesses = currentGuesses;
      updatePayload.player2_state = stateUpdate;
    }
  }

  try {
    await supabaseClient
      .from('pvp_battles_uma')
      .update(updatePayload)
      .eq('id', pvpState.battleId);

    updateHpDisplay();

    if (isWin || isLoss) {
      pvpState.isWaitingForOpponent = true;
      document.getElementById('input-container').classList.add('hidden');
      showPvPWaitingScreen(true);
    }
  } catch (err) {
    console.error('Error synchronising guess update:', err);
  }
}

// --------------- Game Exit / Abandonment Operations ---------------

async function exitPvPBattle() {
  if (!pvpState.battleId) return;

  try {
    if (pvpState.isFFA) {
      const players = [...pvpState.allPlayers];
      players[pvpState.mySlot] = { ...players[pvpState.mySlot], state: 'exited' };
      const alive = players.filter(p => p.hp > 0 && p.state !== 'exited');
      const payload = { ...buildPlayersPayload(players) };
      if (alive.length === 1) {
        payload.status = 'finished';
        payload.winner_id = alive[0].id;
      } else if (alive.length === 0) {
        payload.status = 'finished';
        payload.winner_id = 'draw';
      }
      await supabaseClient.from('pvp_battles_uma').update(payload).eq('id', pvpState.battleId);
    } else {
      await supabaseClient.from('pvp_battles_uma').update({
        status: 'finished',
        winner_id: pvpState.opponentId,
        [pvpState.role === 'player1' ? 'player1_state' : 'player2_state']: 'exited'
      }).eq('id', pvpState.battleId);
    }
  } catch (err) {
    console.error('Error exiting battle room:', err);
  } finally {
    cleanupPvPSession();
  }
}

function exitPvPBattleBeacon() {
  if (!pvpState.battleId) return;

  const url = `${SUPABASE_URL}/rest/v1/pvp_battles_uma?id=eq.${pvpState.battleId}`;
  const headers = {
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=minimal'
  };
  let body;
  if (pvpState.isFFA) {
    const players = [...pvpState.allPlayers];
    players[pvpState.mySlot] = { ...players[pvpState.mySlot], state: 'exited' };
    const alive = players.filter(p => p.hp > 0 && p.state !== 'exited');
    body = JSON.stringify({
      ...buildPlayersPayload(players),
      status: 'finished',
      winner_id: alive.length === 1 ? alive[0].id : pvpState.opponentId
    });
  } else {
    body = JSON.stringify({
      status: 'finished',
      winner_id: pvpState.opponentId,
      [pvpState.role === 'player1' ? 'player1_state' : 'player2_state']: 'exited'
    });
  }

  fetch(url, { method: 'PATCH', headers, body, keepalive: true }).catch(() => {});
}

window.addEventListener('beforeunload', () => {
  if (sessionState.active && sessionState.mode === 'pvp' && pvpState.battleId) {
    exitPvPBattleBeacon();
  }
});

if (window.showMenu) {
  const originalShowMenu = window.showMenu;
  window.showMenu = function() {
    if (sessionState.active && sessionState.mode === 'pvp' && pvpState.battleId) {
      if (confirm("Are you sure you want to leave the PvP match? This will count as an automatic forfeit/defeat.")) {
        exitPvPBattle();
        originalShowMenu();
      }
    } else {
      originalShowMenu();
    }
  };
}

// --------------- Game Rules & Damage Processor ---------------

async function processRoundResolution(battle) {
  // Allow non-host players to resolve after a fallback delay if the host hasn't.
  const isHost = pvpState.mySlot === 0;
  if (!isHost) {
    await new Promise(resolve => setTimeout(resolve, 3000));
    // Re-fetch battle to see if the host already resolved (round_number advanced)
    try {
      const { data: refreshed } = await supabaseClient
        .from('pvp_battles_uma')
        .select('round_number, status')
        .eq('id', battle.id)
        .single();
      if (
        refreshed &&
        (refreshed.status === 'finished' ||
          (refreshed.round_number || 1) > (battle.round_number || 1))
      ) {
        // Host already resolved — bail out
        return;
      }
    } catch (_) { /* network hiccup; fall through and try to resolve */ }
  }

  if (pvpState.isResolvingRound) return;
  pvpState.isResolvingRound = true;

  const currentRoundNum = battle.round_number || 1;
  const maxG = (battle.settings?.maxGuesses) || pvpState.maxGuesses || 5;
  const baseDmgMult = (battle.settings?.damageMultiplier) || pvpState.damageMultiplier || 1;

  // Calculate Sudden Death Damage Escalation dynamically based on configuration
  const sdRound = pvpState.suddenDeathRound !== undefined ? pvpState.suddenDeathRound : 6;
  const isSdActive = sdRound > 0 && currentRoundNum >= sdRound;
  let roundDamageMultiplier = baseDmgMult;
  
  if (isSdActive) {
    const suddenDeathFactor = 1.5 + (currentRoundNum - sdRound) * 0.5; // Starts at 2.0x, adds 0.5x each round after
    roundDamageMultiplier = baseDmgMult * suddenDeathFactor;
  }

  const now = getServerTime();

  // ==========================================
  //  FREE-FOR-ALL (MULTIPLAYER) MITIGATION
  // ==========================================
  if (pvpState.isFFA) {
    const players = parseBattlePlayers(battle);
    const damageMap = {};
    const powerMap = {};
    
    players.forEach(p => { 
      damageMap[p.id] = 0; 
      powerMap[p.id] = calculatePlayerRoundPower(p.state, p.guesses, maxG, roundDamageMultiplier);
    });

    players.forEach(p => {
      if (p.state === 'exited' || p.hp <= 0) return;

      if (p.state && p.state.startsWith('finished_won')) {
        const attackerPower = powerMap[p.id];

        players.forEach(other => {
          if (other.id === p.id) return;
          if (other.hp <= 0 || other.state === 'exited') return;
          if (other.state && other.state.startsWith('finished_won')) return; // winners don't hurt each other

          const defenderPower = powerMap[other.id] || 0;
          const netDmg = Math.max(0, attackerPower - defenderPower);
          damageMap[other.id] = Math.max(damageMap[other.id], netDmg); // highest hit wins, no stacking
        });
      } else if (p.state === 'finished_lost') {
        // Only apply loss penalty if no net damage was already assigned
        if (damageMap[p.id] === 0) {
          const lossPenalty = Math.round(20 * roundDamageMultiplier);
          const mitigation = Math.min(powerMap[p.id] || 0, lossPenalty);
          damageMap[p.id] = Math.max(0, lossPenalty - mitigation);
        }
      }
    });

    // Enforce escalated minimum damage floor during Sudden Death so mirror matches end quickly.
    const baselineFloor = isSdActive ? 10 : 5;
    const finalFloor = Math.round(baselineFloor * (isSdActive ? (1 + (currentRoundNum - sdRound) * 0.5) : 1));

    players.forEach(p => {
      if (p.hp > 0 && p.state !== 'exited' && !(p.state && p.state.startsWith('finished_won'))) {
        damageMap[p.id] = Math.max(damageMap[p.id], finalFloor);
      }
    });

    const updated = players.map(p => {
      const newHp = Math.max(0, p.hp - (damageMap[p.id] || 0));
      return {
        ...p,
        hp: newHp,
        state: newHp <= 0 ? 'exited' : (p.state === 'exited' ? 'exited' : `playing:${now}`),
        guesses: []
      };
    });

    const alive = updated.filter(p => p.hp > 0 && p.state !== 'exited');
    const payload = {
      ...buildPlayersPayload(updated),
      last_update: new Date(getServerTime()).toISOString()
    };

    if (alive.length <= 1) {
      payload.status = 'finished';
      payload.winner_id = alive.length === 1 ? alive[0].id : 'draw';
    } else {
      const config = GAME_CONFIG[battle.game_type];
      const nextTarget = config.data()[Math.floor(Math.random() * config.data().length)];
      payload.target_name = nextTarget.name;
      payload.round_number = (battle.round_number || 1) + 1;
      payload.round_expires_at = computeRoundExpiresAt(battle);
    }

    try {
      await supabaseClient.from('pvp_battles_uma').update(payload).eq('id', battle.id);
    } catch (err) {
      console.error('Failed FFA round resolution:', err);
    } finally {
      setTimeout(() => { pvpState.isResolvingRound = false; }, 1200);
    }
    return;
  }

  // ==========================================
  //  1v1 MITIGATION LOGIC
  // ==========================================
  
  // 1. Calculate raw power for both players (using dynamic round escalation)
  const p1Power = calculatePlayerRoundPower(battle.player1_state, battle.player1_guesses, maxG, roundDamageMultiplier);
  const p2Power = calculatePlayerRoundPower(battle.player2_state, battle.player2_guesses, maxG, roundDamageMultiplier);

  // 2. Apply mitigation (Net Damage = Opponent Power - Own Power)
  let player1Damage = Math.max(0, p2Power - p1Power);
  let player2Damage = Math.max(0, p1Power - p2Power);

  // 3. Apply failure penalty ONLY if the player took zero net damage already.
  if (battle.player1_state === 'finished_lost' && player1Damage === 0) {
    player1Damage = Math.round(20 * roundDamageMultiplier);
  }
  if (battle.player2_state === 'finished_lost' && player2Damage === 0) {
    player2Damage = Math.round(20 * roundDamageMultiplier);
  }

  // 4. Enforce scaled minimum damage floor so even mirror matches don't drag on.
  const p1Active = battle.player1_state && battle.player1_state !== 'exited';
  const p2Active = battle.player2_state && battle.player2_state !== 'exited';
  
  const baselineFloor = isSdActive ? 10 : 5;
  const finalFloor = Math.round(baselineFloor * (isSdActive ? (1 + (currentRoundNum - sdRound) * 0.5) : 1));

  const p1Won = battle.player1_state && battle.player1_state.startsWith('finished_won');
  const p2Won = battle.player2_state && battle.player2_state.startsWith('finished_won');

  if (p1Active && !p1Won) player1Damage = Math.max(player1Damage, finalFloor);
  if (p2Active && !p2Won) player2Damage = Math.max(player2Damage, finalFloor);

  // 4. Update HP values
  const p1FinalHp = Math.max(0, battle.player1_hp - player1Damage);
  const p2FinalHp = Math.max(0, battle.player2_hp - player2Damage);
  const isBattleOver = p1FinalHp <= 0 || p2FinalHp <= 0;
  let winner = null;

  if (isBattleOver) {
    if (p1FinalHp > p2FinalHp) winner = battle.player1_id;
    else if (p2FinalHp > p1FinalHp) winner = battle.player2_id;
    else winner = 'draw';
  }

  const payload = {
    player1_hp: p1FinalHp,
    player2_hp: p2FinalHp,
    player1_state: `playing:${now}`,
    player2_state: `playing:${now}`,
    player1_guesses: [],
    player2_guesses: [],
    last_update: new Date(getServerTime()).toISOString()
  };

  if (isBattleOver) {
    payload.status = 'finished';
    payload.winner_id = winner;
  } else {
    const config = GAME_CONFIG[battle.game_type];
    const nextTarget = config.data()[Math.floor(Math.random() * config.data().length)];
    payload.target_name = nextTarget.name;
    payload.round_number = (battle.round_number || 1) + 1;
    payload.round_expires_at = computeRoundExpiresAt(battle);
  }

  try {
    await supabaseClient.from('pvp_battles_uma').update(payload).eq('id', battle.id);
  } catch (err) {
    console.error('Failed to resolve active round state:', err);
  } finally {
    setTimeout(() => { pvpState.isResolvingRound = false; }, 1200);
  }
}

// --------------- Sudden Death Warnings ---------------

function triggerSuddenDeathAnnouncement(roundNumber) {
  let overlay = document.getElementById('pvp-sudden-death-overlay');
  if (overlay) overlay.remove(); // Clear any existing instance

  overlay = document.createElement('div');
  overlay.id = 'pvp-sudden-death-overlay';
  
  // Calculate dynamic Sudden Death factor
  const sdRound = pvpState.suddenDeathRound !== undefined ? pvpState.suddenDeathRound : 6;
  const multiplier = 2 + (roundNumber - sdRound) * 0.5;

  // Use pointer-events-none so the overlay does not block gameplay interactions
  overlay.className = 'fixed inset-0 z-[310] flex flex-col items-center justify-center pointer-events-none';
  
  // Set initial transition state: invisible and scaled down
  overlay.style.opacity = '0';
  overlay.style.transform = 'scale(0.75)';
  overlay.style.transition = 'opacity 1.5s cubic-bezier(0.25, 1, 0.5, 1), transform 1.5s cubic-bezier(0.25, 1, 0.5, 1)';

  // Inline styling details:
  // - "-webkit-text-stroke" creates a crisp black border around the text.
  // - Multiple overlapping "text-shadow" layers produce the intense glowing effect.
  overlay.innerHTML = `
    <div class="text-center font-black select-none p-4">
      <div class="text-4xl md:text-6xl tracking-widest uppercase mb-2 font-black"
           style="color: #ef4444; 
                  -webkit-text-stroke: 2.5px #000000; 
                  text-shadow: 0 0 10px rgba(239, 68, 68, 0.95), 0 0 25px rgba(239, 68, 68, 0.8), 0 0 50px rgba(239, 68, 68, 0.6);">
        SUDDEN DEATH
      </div>
      <div class="text-lg md:text-2xl tracking-widest uppercase font-black"
           style="color: #ffffff; 
                  -webkit-text-stroke: 1.5px #000000; 
                  text-shadow: 0 0 8px rgba(239, 68, 68, 0.9), 0 0 20px rgba(239, 68, 68, 0.7);">
        ${multiplier}x Damage
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // Force reflow to ensure transitions execute properly
  void overlay.offsetWidth;

  // Slowly fade in and bring closer to the screen
  overlay.style.opacity = '1';
  overlay.style.transform = 'scale(1.15)';

  // Hold, then slowly fade out while continuing to move closer
  setTimeout(() => {
    const el = document.getElementById('pvp-sudden-death-overlay');
    if (el) {
      el.style.opacity = '0';
      el.style.transform = 'scale(1.3)';
      
      // Remove element from DOM once fade transition is complete
      setTimeout(() => el.remove(), 1500);
    }
  }, 2500);
}

function handleRoundReset(nextRoundNumber, newTargetName, gameType, roundExpiresAt) {
  pvpState.isWaitingForOpponent = false;
  pvpState.roundTimeoutHandled = false;
  pvpState.isResolvingRound = false;
  showPvPWaitingScreen(false);

  pvpState.currentRound = nextRoundNumber;
  pvpState.opponentGuesses = [];
  if (pvpState.isFFA) {
    pvpState.allPlayers = pvpState.allPlayers.map(p => ({ ...p, guesses: [] }));
  }
  sessionState.guesses = [];
  sessionState.isGameOver = false;
  sessionState.knownStats = {};
  sessionState.clues = [];
  
  const config = GAME_CONFIG[gameType];
  sessionState.target = config.data().find(item => item.name === newTargetName);

  if (pvpState.hardModeActive && gameType !== 'voicedle') {
    const otherItems = config.data().filter(item => item.name !== newTargetName);
    sessionState.clues = otherItems.sort(() => 0.5 - Math.random()).slice(0, 3);
  }

  document.getElementById('guess-grid').innerHTML = '';
  document.getElementById('uma-input').value = '';
  document.getElementById('input-container').classList.remove('hidden');

  const expiry = roundExpiresAt
    ? new Date(roundExpiresAt)
    : new Date(getServerTime() + pvpState.roundTimeLimitMin * 60 * 1000);
  startPvPTimer(expiry);

  updateHpDisplay();
  updateGuessCountUI();
  renderSuggestions('');

  if (pvpState.hardModeActive && gameType !== 'voicedle') {
    sessionState.clues.forEach(c => addGuessRow(c, true));
  }

  // Trigger the customizable Sudden Death warning overlay
  const sdRound = pvpState.suddenDeathRound !== undefined ? pvpState.suddenDeathRound : 6;
  if (sdRound > 0 && nextRoundNumber >= sdRound) {
    triggerSuddenDeathAnnouncement(nextRoundNumber);
  }
}

// --------------- Dynamic Damage Visual Effects ---------------

function injectPvPDamageStyles() {
  if (document.getElementById('pvp-damage-styles')) return;
  const style = document.createElement('style');
  style.id = 'pvp-damage-styles';
  style.textContent = `
    @keyframes pvpDamageFloat {
      0% { opacity: 0; transform: translate(-50%, 10px) scale(0.8); }
      15% { opacity: 1; transform: translate(-50%, -10px) scale(1.2); }
      80% { opacity: 1; transform: translate(-50%, -25px) scale(1); }
      100% { opacity: 0; transform: translate(-50%, -40px) scale(0.9); }
    }
    @keyframes pvpShieldAbsorb {
      0% { opacity: 0; transform: translate(-50%, 25px) scale(0.6); }
      15% { opacity: 1; transform: translate(-50%, 5px) scale(1.1); filter: drop-shadow(0 0 8px rgba(59, 130, 246, 0.8)); }
      80% { opacity: 1; transform: translate(-50%, -5px) scale(1); }
      100% { opacity: 0; transform: translate(-50%, -15px) scale(0.9); }
    }
    @keyframes pvpSwordSlash {
      0% { opacity: 0; transform: translate(-50%, -35px) scale(0.5) rotate(-15deg); }
      15% { opacity: 1; transform: translate(-50%, -15px) scale(1.2) rotate(5deg); filter: drop-shadow(0 0 8px rgba(234, 179, 8, 0.8)); }
      80% { opacity: 1; transform: translate(-50%, -20px) scale(1) rotate(5deg); }
      100% { opacity: 0; transform: translate(-50%, -30px) scale(0.9) rotate(15deg); }
    }
    @keyframes pvpColumnShake {
      0%, 100% { transform: translateX(0); }
      10%, 30%, 50%, 70%, 90% { transform: translateX(-4px); }
      20%, 40%, 60%, 80% { transform: translateX(4px); }
    }
    @keyframes pvpFlashRed {
      0%, 100% { background-color: transparent; }
      50% { background-color: rgba(239, 68, 68, 0.2); }
    }
    @keyframes pvpFlashBlue {
      0%, 100% { background-color: transparent; }
      50% { background-color: rgba(59, 130, 246, 0.15); }
    }
    @keyframes pvpPulseRedGlow {
      0%, 100% { filter: drop-shadow(0 0 2px rgba(239, 68, 68, 0.4)); }
      50% { filter: drop-shadow(0 0 10px rgba(239, 68, 68, 0.8)); }
    }
    @keyframes pvpBounceShort {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.03); }
    }
    .pvp-damage-indicator {
      position: absolute;
      top: -15px;
      left: 50%;
      transform: translateX(-50%);
      font-size: 26px;
      font-weight: 900;
      color: #ef4444;
      text-shadow: 0 0 4px #000, 0 2px 4px rgba(0, 0, 0, 0.8);
      pointer-events: none;
      z-index: 105;
      animation: pvpDamageFloat 1.8s cubic-bezier(0.25, 1, 0.5, 1) forwards;
      font-family: 'Impact', 'Arial Black', sans-serif;
    }
    .pvp-shield-indicator {
      position: absolute;
      top: -20px;
      left: 50%;
      transform: translateX(-50%);
      font-size: 18px;
      font-weight: 900;
      color: #3b82f6;
      text-shadow: 0 0 4px #000, 0 2px 4px rgba(0, 0, 0, 0.8);
      pointer-events: none;
      z-index: 104;
      animation: pvpShieldAbsorb 1.8s cubic-bezier(0.25, 1, 0.5, 1) forwards;
      font-family: 'Impact', 'Arial Black', sans-serif;
    }
    .pvp-atk-indicator {
      position: absolute;
      top: -45px;
      left: 50%;
      transform: translateX(-50%);
      font-size: 18px;
      font-weight: 900;
      color: #eab308;
      text-shadow: 0 0 4px #000, 0 2px 4px rgba(0, 0, 0, 0.8);
      pointer-events: none;
      z-index: 103;
      animation: pvpSwordSlash 1.8s cubic-bezier(0.25, 1, 0.5, 1) forwards;
      font-family: 'Impact', 'Arial Black', sans-serif;
    }
    .pvp-shake-active { animation: pvpColumnShake 0.5s ease-in-out; }
    .pvp-flash-red-active { animation: pvpFlashRed 0.6s ease-in-out; }
    .pvp-flash-blue-active { animation: pvpFlashBlue 0.6s ease-in-out; }
    .pvp-sudden-death-glow { animation: pvpPulseRedGlow 1.8s infinite ease-in-out; }
    .animate-bounce-short { animation: pvpBounceShort 1.5s infinite ease-in-out; }
    
    #pvp-player-col, #pvp-opponent-col, .pvp-ffa-opponent {
      position: relative;
      transition: transform 0.2s ease;
    }
  `;
  document.head.appendChild(style);
}

function triggerDamageAnimation(targetType, amount) {
  if (amount <= 0) return;
  injectPvPDamageStyles();

  let colId = 'pvp-opponent-col';
  if (targetType === 'player') {
    colId = 'pvp-player-col';
  } else if (String(targetType).startsWith('opp-')) {
    colId = `pvp-opp-col-${targetType.split('-')[1]}`;
  }

  const colEl = document.getElementById(colId);
  if (!colEl) return;

  colEl.classList.remove('pvp-shake-active', 'pvp-flash-red-active', 'pvp-flash-blue-active');
  void colEl.offsetWidth; // Force layout recalculation to restart animations

  const outcomeEl = document.createElement('div');
  outcomeEl.className = 'pvp-damage-indicator';
  outcomeEl.textContent = `-${amount} HP`;
  outcomeEl.style.color = '#ef4444';

  colEl.classList.add('pvp-shake-active', 'pvp-flash-red-active');
  colEl.appendChild(outcomeEl);
  outcomeEl.addEventListener('animationend', () => outcomeEl.remove());
}

function triggerCombatAnimation(targetType, incomingAttack, ownDefense, finalDamage) {
  injectPvPDamageStyles();
  
  let colId = 'pvp-opponent-col';
  if (targetType === 'player') colId = 'pvp-player-col';
  else if (String(targetType).startsWith('opp-')) colId = `pvp-opp-col-${targetType.split('-')[1]}`;
  
  const colEl = document.getElementById(colId);
  if (!colEl) return;

  // Clear previous active anim classes
  colEl.classList.remove('pvp-shake-active', 'pvp-flash-red-active', 'pvp-flash-blue-active');
  void colEl.offsetWidth; // Force CSS reflow

  // 1. Create Incoming Attack Floating Text
  if (incomingAttack > 0) {
    const atkEl = document.createElement('div');
    atkEl.className = 'pvp-atk-indicator';
    atkEl.innerHTML = `⚔️ ATK ${incomingAttack}`;
    colEl.appendChild(atkEl);
    atkEl.addEventListener('animationend', () => atkEl.remove());
  }

  // 2. Create Defense Mitigation Shield Pop
  if (ownDefense > 0) {
    const defEl = document.createElement('div');
    defEl.className = 'pvp-shield-indicator';
    defEl.innerHTML = `🛡️ DEF ${ownDefense}`;
    colEl.appendChild(defEl);
    defEl.addEventListener('animationend', () => defEl.remove());
  }

  // 3. Render Final Outcome
  setTimeout(() => {
    const outcomeEl = document.createElement('div');
    outcomeEl.className = 'pvp-damage-indicator';
    
    if (finalDamage > 0) {
      outcomeEl.textContent = `-${finalDamage} HP`;
      outcomeEl.style.color = '#ef4444'; // Red for damage
      colEl.classList.add('pvp-shake-active', 'pvp-flash-red-active');
    } else {
      outcomeEl.innerHTML = `🛡️ BLOCKED`;
      outcomeEl.style.color = '#3b82f6'; // Blue for blocked
      colEl.classList.add('pvp-flash-blue-active');
    }
    
    colEl.appendChild(outcomeEl);
    outcomeEl.addEventListener('animationend', () => outcomeEl.remove());
  }, 450); // Small delay so clash effect flows sequentially
}

// --------------- UI Overlays ---------------

function showQueueModal(show) {
  let modal = document.getElementById('pvp-queue-modal');
  if (!modal && show) {
    modal = document.createElement('div');
    modal.id = 'pvp-queue-modal';
    modal.className = 'fixed inset-0 bg-black/70 backdrop-blur-sm z-[250] flex items-center justify-center p-4';
    modal.innerHTML = `
      <div class="bg-white dark:bg-slate-800 rounded-2xl max-w-sm w-full p-6 text-center border-t-8 border-red-700 shadow-2xl flex flex-col gap-4">
        <div class="text-4xl animate-bounce">⚡</div>
        <h2 class="text-xl font-black text-slate-800 dark:text-slate-100 uppercase tracking-wide">Looking for Opponent</h2>
        <p class="text-xs text-slate-500 dark:text-slate-400">Searching the matchmaking server for another Trainer...</p>
        <div class="flex items-center justify-center py-2">
          <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-red-700"></div>
        </div>
        <button onclick="leavePvPQueue()" class="btn-secondary w-full py-2.5 rounded-xl font-bold transition-all text-sm">Cancel Matchmaking</button>
      </div>
    `;
    document.body.appendChild(modal);
  } else if (modal && !show) {
    modal.remove();
  }
}

function showPvPWaitingScreen(show, customMsg = null) {
  let pane = document.getElementById('pvp-waiting-overlay');
  if (!pane && show) {
    pane = document.createElement('div');
    pane.id = 'pvp-waiting-overlay';
    pane.className = 'w-full max-w-md bg-amber-50 dark:bg-slate-900 border border-amber-200 dark:border-amber-950 p-4 rounded-xl text-center text-xs font-bold text-amber-800 dark:text-amber-400 my-3 animate-pulse';
    const grid = document.getElementById('guesses');
    if (grid) grid.after(pane);
  }
  if (pane && show) {
    pane.innerHTML = customMsg || (pvpState.isFFA
      ? `⏳ Board complete. Waiting for other players to finish...`
      : `⏳ Board complete. Waiting for opponent to finish their escape attempts...`);
  } else if (pane && !show) {
    pane.remove();
  }
}

// --------------- Cleanup & Exit Operations ---------------

function declarePvPWinner(winnerId, battle) {
  showPvPResultModal({ battle, winnerId, reason: 'normal' });
  document.getElementById('input-container')?.classList.add('hidden');
}

function showPvPResultModal({ battle, winnerId, reason = 'normal' }) {
  const modal = document.getElementById('pvp-result-modal');
  if (!modal) return;

  const userId = getOrCreateUserId();
  const isWin = winnerId === userId;
  const isDraw = winnerId === 'draw';
  const players = battle ? parseBattlePlayers(battle) : [...pvpState.allPlayers];
  const rounds = battle?.round_number || pvpState.currentRound || 1;
  const isFFA = battle ? isMultiplayerBattle(battle) : pvpState.isFFA;

  const titles = {
    normal: { win: isFFA ? 'FFA VICTORY' : 'VICTORY', lose: 'DEFEAT', draw: 'DRAW' },
    forfeit: { win: 'OPPONENT FORFEIT', lose: 'FORFEIT', draw: 'DRAW' },
    disconnect: { win: 'OPPONENT DISCONNECTED', lose: 'DISCONNECTED', draw: 'DRAW' },
    opponent_left: { win: 'OPPONENT LEFT', lose: 'FORFEIT', draw: 'DRAW' }
  };
  const t = titles[reason] || titles.normal;

  let title = t.lose;
  let subtitle = 'Better luck on the next investigation.';
  if (isWin) {
    title = t.win;
    subtitle = isFFA
      ? 'You outlasted all opponents in the free-for-all!'
      : 'You deduced the targets and claimed victory.';
    setTimeout(launchConfetti, 100);
  } else if (isDraw) {
    title = t.draw;
    subtitle = 'No single victor remained standing.';
  } else if (reason === 'forfeit') {
    subtitle = 'A player left the match before it concluded.';
  } else if (reason === 'disconnect') {
    subtitle = 'Connection was lost during the battle.';
  }

  const winnerPlayer = players.find(p => p.id === winnerId);
  const winnerName = winnerPlayer?.username || (isDraw ? '—' : 'Unknown');

  const standingsHtml = players.map(p => {
    const isMe = p.id === userId;
    const isWinner = p.id === winnerId;
    const barColor = isWinner ? 'bg-amber-500' : (isMe ? 'bg-green-600' : 'bg-red-600');
    const playerHpPercent = (p.hp / pvpState.maxHp) * 100;
    return `
      <div class="pvp-result-player ${isWinner ? 'is-winner' : ''}">
        <div class="flex justify-between text-xs font-bold mb-1">
          <span>${p.username}${isMe ? ' (You)' : ''}${isWinner ? ' 👑' : ''}</span>
          <span>${p.hp} / ${pvpState.maxHp} HP</span>
        </div>
        <div class="w-full bg-slate-300 dark:bg-slate-700 h-2.5 rounded-full overflow-hidden">
          <div class="${barColor} h-full" style="width:${playerHpPercent}%"></div>
        </div>
      </div>`;
  }).join('');

  const titleEl = document.getElementById('pvp-result-title');
  if (titleEl) titleEl.textContent = title;

  const subtitleEl = document.getElementById('pvp-result-subtitle');
  if (subtitleEl) subtitleEl.textContent = subtitle;

  const roundsEl = document.getElementById('pvp-result-rounds');
  if (roundsEl) roundsEl.textContent = `Rounds played: ${rounds}`;

  const winnerEl = document.getElementById('pvp-result-winner');
  if (winnerEl) {
    winnerEl.textContent = isDraw
      ? 'Result: Stalemate'
      : `Winner: ${winnerName}`;
  }

  const standingsEl = document.getElementById('pvp-result-shadows-or-standings') || document.getElementById('pvp-result-standings');
  if (standingsEl) {
    standingsEl.innerHTML = standingsHtml;
  }

  const iconEl = document.getElementById('pvp-result-icon');
  if (iconEl) {
    iconEl.textContent = isWin ? '🏆' : isDraw ? '🤝' : '💀';
  }

  modal.classList.remove('hidden');
  if (pvpState.pollTimer) clearInterval(pvpState.pollTimer);
  if (pvpState.matchTimer) clearInterval(pvpState.matchTimer);
}

function closePvPResultModal() {
  const modal = document.getElementById('pvp-result-modal');
  if (modal) modal.classList.add('hidden');
  cleanupPvPSession();
  if (typeof showMenu === 'function') showMenu();
}

function cleanupPvPSession() {
  if (pvpState.pollTimer) clearInterval(pvpState.pollTimer);
  if (pvpState.matchTimer) clearInterval(pvpState.matchTimer);

  pvpState.battleId = null;
  pvpState.isFFA = false;
  pvpState.allPlayers = [];
  pvpState.mySlot = 0;
  pvpState.prevHpMap = {};
  pvpState.maxHp = 100;
  pvpState.roundExpiresAt = null;
  pvpState.roundTimeoutHandled = false;
  pvpState.isResolvingRound = false;
  pvpState.isShowingRoundResolution = false;

  const interfacePanel = document.getElementById('pvp-hp-interface');
  if (interfacePanel) interfacePanel.remove();
  
  const resolutionModal = document.getElementById('pvp-round-resolution-modal');
  if (resolutionModal) resolutionModal.remove();

  showPvPWaitingScreen(false);
}

function showPvPRoundResolutionModal(data, onComplete) {
  let modal = document.getElementById('pvp-round-resolution-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'pvp-round-resolution-modal';
    modal.className = 'fixed inset-0 bg-black/85 backdrop-blur-md z-[300] flex items-center justify-center p-4 transition-opacity duration-300';
    document.body.appendChild(modal);
  }

  const nextRound = data.round + 1;
  let contentHtml = '';

  if (data.isFFA) {
    const playersHtml = data.ffaPlayers.map((p, idx) => {
      const borderCol = p.isMe ? 'border-green-600/50 bg-green-950/20' : 'border-red-900/50 bg-red-950/10';
      const textCol = p.isMe ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400';
      const barBg = p.isMe ? 'bg-green-600' : 'bg-red-600';
      const oldHpPercent = (p.oldHp / pvpState.maxHp) * 100;
      const newHpPercent = (p.newHp / pvpState.maxHp) * 100;
      return `
        <div class="p-3 rounded-xl border-2 ${borderCol} relative flex flex-col gap-1 overflow-hidden">
          <div class="flex justify-between text-xs font-black">
            <span class="${textCol}">${escapeHtml(p.username)} ${p.isMe ? '(You)' : ''}</span>
            <span class="font-mono"><span id="res-hp-val-${idx}">${p.oldHp}</span> / ${pvpState.maxHp} HP</span>
          </div>
          <div class="w-full bg-slate-300 dark:bg-slate-700 h-3 rounded-full overflow-hidden relative">
            <div id="res-bar-${idx}" class="${barBg} h-full" style="width: ${oldHpPercent}%; data-target-width="${newHpPercent}%"; transition: width 0.8s cubic-bezier(0.4, 0, 0.2, 1);"></div>
          </div>
          <div id="res-dmg-indicator-${idx}" class="absolute inset-0 flex items-center justify-center pointer-events-none opacity-0 transform scale-75 transition-all duration-300">
            <span class="text-2xl font-black text-red-600 dark:text-red-500 drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)]">-${p.dmg} HP</span>
          </div>
        </div>
      `;
    }).join('');

    contentHtml = `
      <div class="grid grid-cols-1 gap-3 w-full max-w-sm">
        ${playersHtml}
      </div>
    `;
  } else {
    const myOldPercent = (data.myOldHp / pvpState.maxHp) * 100;
    const myNewPercent = (data.myNewHp / pvpState.maxHp) * 100;
    const oppOldPercent = (data.oppOldHp / pvpState.maxHp) * 100;
    const oppNewPercent = (data.oppNewHp / pvpState.maxHp) * 100;

    contentHtml = `
      <div class="flex flex-col md:flex-row gap-4 w-full max-w-md">
        <!-- Player Column -->
        <div class="flex-1 p-3 rounded-xl border-2 border-green-600/50 bg-green-950/20 relative flex flex-col gap-1 overflow-hidden">
          <div class="flex justify-between text-xs font-black">
            <span class="text-green-700 dark:text-green-400">You</span>
            <span class="font-mono"><span id="res-hp-val-me">${data.myOldHp}</span> / ${pvpState.maxHp} HP</span>
          </div>
          <div class="w-full bg-slate-300 dark:bg-slate-700 h-4 rounded-full overflow-hidden relative">
            <div id="res-bar-me" class="bg-green-600 h-full" style="width: ${myOldPercent}%; data-target-width="${myNewPercent}%"; transition: width 0.8s cubic-bezier(0.4, 0, 0.2, 1);"></div>
          </div>
          <div id="res-dmg-indicator-me" class="absolute inset-0 flex items-center justify-center pointer-events-none opacity-0 transform scale-75 transition-all duration-300">
            <span class="text-3xl font-black text-red-600 dark:text-red-500 drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)]">-${data.myDmg} HP</span>
          </div>
        </div>

        <!-- Opponent Column -->
        <div class="flex-1 p-3 rounded-xl border-2 border-red-900/50 bg-red-950/10 relative flex flex-col gap-1 overflow-hidden">
          <div class="flex justify-between text-xs font-black">
            <span class="text-red-700 dark:text-red-400">${escapeHtml(data.oppName)}</span>
            <span class="font-mono"><span id="res-hp-val-opp">${data.oppOldHp}</span> / ${pvpState.maxHp} HP</span>
          </div>
          <div class="w-full bg-slate-300 dark:bg-slate-700 h-4 rounded-full overflow-hidden relative">
            <div id="res-bar-opp" class="bg-red-600 h-full" style="width: ${oppOldPercent}%; data-target-width="${oppNewPercent}%"; transition: width 0.8s cubic-bezier(0.4, 0, 0.2, 1);"></div>
          </div>
          <div id="res-dmg-indicator-opp" class="absolute inset-0 flex items-center justify-center pointer-events-none opacity-0 transform scale-75 transition-all duration-300">
            <span class="text-3xl font-black text-red-600 dark:text-red-500 drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)]">-${data.oppDmg} HP</span>
          </div>
        </div>
      </div>
    `;
  }

  // Display custom round details on resolution
  const sdRound = pvpState.suddenDeathRound !== undefined ? pvpState.suddenDeathRound : 6;
  const isNextSd = sdRound > 0 && nextRound >= sdRound;

  modal.innerHTML = `
    <div class="bg-white dark:bg-slate-800 rounded-2xl max-w-lg w-full p-6 text-center border-t-8 border-red-700 shadow-2xl flex flex-col gap-4 animate-fade-in">
      <div class="text-3xl">⚔️</div>
      <h2 class="text-xl font-black text-slate-800 dark:text-slate-100 uppercase tracking-wide">Round ${data.round} Resolved!</h2>
      <p class="text-xs text-slate-500 dark:text-slate-400">Applying damage and calculating updates...</p>
      
      <div class="my-2">
        ${contentHtml}
      </div>

      <div id="res-next-round-status" class="text-sm font-bold text-amber-600 dark:text-amber-400 animate-pulse">
        Calculating damage indicators...
      </div>
    </div>
  `;

  setTimeout(() => {
    if (data.isFFA) {
      data.ffaPlayers.forEach((p, idx) => {
        if (p.dmg > 0) {
          const el = document.getElementById(`res-dmg-indicator-${idx}`);
          if (el) el.classList.replace('opacity-0', 'opacity-100'), el.classList.replace('scale-75', 'scale-100');
        }
      });
    } else {
      if (data.myDmg > 0) {
        const el = document.getElementById('res-dmg-indicator-me');
        if (el) el.classList.replace('opacity-0', 'opacity-100'), el.classList.replace('scale-75', 'scale-100');
      }
      if (data.oppDmg > 0) {
        const el = document.getElementById('res-dmg-indicator-opp');
        if (el) el.classList.replace('opacity-0', 'opacity-100'), el.classList.replace('scale-75', 'scale-100');
      }
    }
  }, 400);

  setTimeout(() => {
    if (data.isFFA) {
      data.ffaPlayers.forEach((p, idx) => {
        const bar = document.getElementById(`res-bar-${idx}`);
        const val = document.getElementById(`res-hp-val-${idx}`);
        const targetPercent = (p.newHp / pvpState.maxHp) * 100;
        if (bar) bar.style.width = `${targetPercent}%`;
        if (val) animateHPValue(val, p.oldHp, p.newHp, 800);
      });
    } else {
      const myBar = document.getElementById('res-bar-me');
      const myVal = document.getElementById('res-hp-val-me');
      const oppBar = document.getElementById('res-bar-opp');
      const oppVal = document.getElementById('res-hp-val-opp');

      const myTargetPercent = (data.myNewHp / pvpState.maxHp) * 100;
      const oppTargetPercent = (data.oppNewHp / pvpState.maxHp) * 100;

      if (myBar) myBar.style.width = `${myTargetPercent}%`;
      if (myVal) animateHPValue(myVal, data.myOldHp, data.myNewHp, 800);

      if (oppBar) oppBar.style.width = `${oppTargetPercent}%`;
      if (oppVal) animateHPValue(oppVal, data.oppOldHp, data.oppNewHp, 800);
    }

    const statusText = document.getElementById('res-next-round-status');
    if (statusText) {
      statusText.textContent = isNextSd
        ? `Preparing Sudden Death Round ${nextRound}...`
        : `Preparing Round ${nextRound}...`;
    }
  }, 1200);

  setTimeout(() => {
    modal.classList.add('opacity-0');
    setTimeout(() => {
      modal.remove();
      if (typeof onComplete === 'function') onComplete();
    }, 300);
  }, 3500);
}

function animateHPValue(element, start, end, duration) {
  let startTimestamp = null;
  const step = (timestamp) => {
    if (!startTimestamp) startTimestamp = timestamp;
    const progress = Math.min((timestamp - startTimestamp) / duration, 1);
    element.textContent = Math.floor(start - progress * (start - end));
    if (progress < 1) {
      window.requestAnimationFrame(step);
    } else {
      element.textContent = end;
    }
  };
  window.requestAnimationFrame(step);
}

// --------------- Utilities ---------------

function formatTimerFromMs(ms) {
  if (ms <= 0) return "00:00";
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function computeRoundExpiresAt(battle) {
  const limitMin = getRoundTimeLimitMin(battle);
  return new Date(getServerTime() + limitMin * 60 * 1000).toISOString();
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}