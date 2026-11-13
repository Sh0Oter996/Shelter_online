'use strict';

// ============================================================================
//  ИГРОВОЙ ДВИЖОК
//  Чистые функции над сериализуемым состоянием. Движок не знает про DOM,
//  Firebase и таймеры: хост вызывает applyCommand(), получает новое состояние
//  и сохраняет его в облако. Клиенты видят только buildPublicState()/buildHand().
// ============================================================================

import {
    CUSTOM_MARKER,
    POOLS,
    FIELDS,
    REVEALABLE_FIELDS,
    RESOURCE_META,
    SCENARIOS,
    PROFESSION_EFFECTS,
    HEALTH_GOOD,
    HEALTH_MILD,
    HEALTH_MODERATE,
    HEALTH_SEVERE,
    HEALTH_NEUTRAL,
    HOBBY_EFFECTS,
    PHOBIA_SEVERE,
    SKILL_EFFECTS,
    CHARACTER_POSITIVE,
    CHARACTER_NEGATIVE,
    CHARACTER_EXTRA_EFFECTS,
    LUGGAGE_EFFECTS,
    FACT_EFFECTS,
    ACTION_CARDS,
    CONDITION_CARDS
} from '../config.js';

import {
    shuffle,
    randomItem,
    ensurePoolSize,
    clamp,
    toArray,
    toObject,
    safeJsonClone
} from '../utils.js';

export const MIN_PLAYERS = 4;
export const MAX_PLAYERS = 15;
export const LOG_LIMIT = 120;
export const STATE_VERSION = 1;

// ---------------------------------------------------------------------------
//  Справочники
// ---------------------------------------------------------------------------

export function getScenario(id) {
    return SCENARIOS.find(s => s.id === id) || null;
}

export function getActionCard(id) {
    return ACTION_CARDS.find(c => c.id === id) || null;
}

export function getConditionCard(id) {
    return CONDITION_CARDS.find(c => c.id === id) || null;
}

export function displayValue(field, player) {
    const raw = player ? player[field.key] : undefined;
    if (raw === CUSTOM_MARKER) return '✏️ Придумай сам';
    if (raw == null || raw === '') return '—';
    if (field.key === 'age') return `${raw} лет`;
    return raw;
}

// ---------------------------------------------------------------------------
//  Начальное состояние комнаты
// ---------------------------------------------------------------------------

export function createLobbyState({ code = '', hostUid = '' } = {}) {
    return {
        version: STATE_VERSION,
        code,
        hostUid,
        status: 'lobby',
        phase: 'lobby',
        scenarioId: null,
        settings: { survivors: 2 },
        players: [],
        round: 0,
        currentUid: null,
        voteRounds: [],
        voteQuotas: {},
        survivorsTarget: 2,
        votes: {},
        voteOrder: [],
        voteCursor: 0,
        voteQuotaTotal: 0,
        voteElimsRemaining: 0,
        voteStep: 1,
        isTiebreak: false,
        voteCandidates: null,
        deciderCandidates: null,
        currentVoterUid: null,
        voteTally: null,
        lastVoteOutcome: '',
        baseResources: {},
        baseStability: 0,
        discoveredRoomIds: [],
        openedRoomIds: [],
        final: null,
        ending: null,
        log: [],
        logSeq: 0,
        processedCommands: [],
        createdAt: Date.now(),
        startedAt: null,
        updatedAt: Date.now()
    };
}

export function normalizeState(raw) {
    if (!raw || typeof raw !== 'object') return null;

    const state = Object.assign(
        createLobbyState({ code: raw.code || '', hostUid: raw.hostUid || '' }),
        raw
    );

    state.settings = toObject(raw.settings);
    state.players = toArray(raw.players).map(normalizePlayer);
    state.voteRounds = toArray(raw.voteRounds).map(Number).filter(n => n > 0);
    state.voteQuotas = toObject(raw.voteQuotas);
    state.votes = toObject(raw.votes);
    state.voteOrder = toArray(raw.voteOrder);
    state.voteCandidates = raw.voteCandidates ? toArray(raw.voteCandidates) : null;
    state.deciderCandidates = raw.deciderCandidates ? toArray(raw.deciderCandidates) : null;
    state.voteTally = raw.voteTally ? toArray(raw.voteTally) : null;
    state.baseResources = toObject(raw.baseResources);
    state.discoveredRoomIds = toArray(raw.discoveredRoomIds);
    state.openedRoomIds = toArray(raw.openedRoomIds);
    state.log = toArray(raw.log).map(entry => ({
        id: Number(entry && entry.id) || 0,
        text: String((entry && entry.text) || ''),
        type: String((entry && entry.type) || 'info')
    }));
    state.processedCommands = toArray(raw.processedCommands).map(String).slice(-100);
    state.final = raw.final || null;
    state.ending = raw.ending || null;
    state.logSeq = Number(raw.logSeq) || 0;
    state.round = Number(raw.round) || 0;
    state.voteStep = Number(raw.voteStep) || 1;
    state.voteCursor = Number(raw.voteCursor) || 0;
    state.voteQuotaTotal = Number(raw.voteQuotaTotal) || 0;
    state.voteElimsRemaining = Number(raw.voteElimsRemaining) || 0;
    state.survivorsTarget = Number(raw.survivorsTarget) || 1;
    state.baseStability = Number(raw.baseStability) || 0;
    state.currentUid = raw.currentUid || null;
    state.currentVoterUid = raw.currentVoterUid || null;
    state.isTiebreak = !!raw.isTiebreak;
    state.createdAt = Number(raw.createdAt) || Date.now();
    state.startedAt = raw.startedAt || null;

    return state;
}

function normalizePlayer(raw) {
    const player = Object.assign({}, raw);
    player.uid = String(raw.uid || '');
    player.name = String(raw.name || 'Игрок');
    player.seat = Number(raw.seat) || 0;
    player.alive = raw.alive !== false;
    player.revealed = toObject(raw.revealed);
    player.bonusLuggage = toArray(raw.bonusLuggage);
    player.acted = !!raw.acted;
    player.actionCardUsed = !!raw.actionCardUsed;
    player.conditionCardTriggered = !!raw.conditionCardTriggered;
    player.actionCardId = raw.actionCardId || null;
    player.conditionCardId = raw.conditionCardId || null;
    return player;
}

// ---------------------------------------------------------------------------
//  Раздача карт
// ---------------------------------------------------------------------------

function canOpenRoomForGuarantee(room, player) {
    const professions = (room.unlock && room.unlock.professions) || [];
    const skills = (room.unlock && room.unlock.skills) || [];
    return professions.includes(player.profession) || skills.includes(player.skill);
}

function ensureRoomOpeners(list, scenario) {
    if (!scenario) return;
    const rooms = scenario.rooms.filter(room => (room.locked || room.broken) && room.unlock);

    rooms.forEach(room => {
        if (list.some(p => canOpenRoomForGuarantee(room, p))) return;

        const isSoleOpener = player => rooms.some(other => {
            if (other === room) return false;
            if (!canOpenRoomForGuarantee(other, player)) return false;
            return !list.some(q => q !== player && canOpenRoomForGuarantee(other, q));
        });

        let candidates = list.filter(p => !isSoleOpener(p));
        if (candidates.length === 0) candidates = list;
        if (candidates.length === 0) return;

        const chosen = randomItem(candidates);
        const professions = (room.unlock.professions || []);
        const skills = (room.unlock.skills || []);
        if (professions.length > 0) chosen.profession = randomItem(professions);
        else if (skills.length > 0) chosen.skill = randomItem(skills);
    });
}

function generatePlayers(entries, scenario) {
    const players = entries.map((entry, index) => ({
        uid: entry.uid,
        name: entry.name,
        seat: index,
        alive: true,
        acted: false,
        revealed: { profession: true, sex: true },
        bonusLuggage: [],
        actionCardId: null,
        actionCardUsed: false,
        conditionCardId: null,
        conditionCardTriggered: false
    }));

    // По каждому полю отдельно раздаём значения: уникальные — без повторов,
    // неуникальные — независимо. Часть игроков получает «придумай сам».
    for (const key of Object.keys(POOLS)) {
        const fieldMeta = FIELDS.find(f => f.key === key) || {};
        const isUnique = fieldMeta.unique !== false;
        const customChance = fieldMeta.customChance || 0;

        const customPlayers = [];
        const normalPlayers = [];
        for (let i = 0; i < players.length; i++) {
            if (customChance > 0 && Math.random() < customChance) customPlayers.push(i);
            else normalPlayers.push(i);
        }

        if (isUnique) {
            const pool = ensurePoolSize(POOLS[key], normalPlayers.length, 'Вариант');
            const shuffled = shuffle(pool).slice(0, normalPlayers.length);
            normalPlayers.forEach((playerIndex, j) => {
                players[playerIndex][key] = shuffled[j];
            });
        } else {
            normalPlayers.forEach(playerIndex => {
                players[playerIndex][key] = randomItem(POOLS[key]);
            });
        }

        customPlayers.forEach(playerIndex => {
            players[playerIndex][key] = CUSTOM_MARKER;
        });
    }

    ensureRoomOpeners(players, scenario);

    const actionDeck = shuffle(ACTION_CARDS);
    const conditionDeck = shuffle(CONDITION_CARDS);
    players.forEach((player, index) => {
        player.actionCardId = actionDeck[index % actionDeck.length].id;
        player.conditionCardId = conditionDeck[index % conditionDeck.length].id;
    });

    return players;
}

// ---------------------------------------------------------------------------
//  Голосование: план и подсчёт
// ---------------------------------------------------------------------------

function computeVoteRounds(totalPlayers, survivorsWanted) {
    const eliminationsNeeded = Math.max(0, totalPlayers - survivorsWanted);
    if (eliminationsNeeded === 0) return [];

    const maxRounds = REVEALABLE_FIELDS.length;
    if (eliminationsNeeded >= maxRounds) {
        const result = [];
        for (let r = 1; r <= maxRounds; r++) result.push(r);
        return result;
    }
    const startRound = Math.max(1, maxRounds - eliminationsNeeded + 1);
    const result = [];
    for (let r = startRound; r <= maxRounds; r++) result.push(r);
    return result;
}

export function computeVotePlan(totalPlayers, survivorsWanted) {
    const needed = Math.max(0, totalPlayers - survivorsWanted);
    if (needed === 0) return { rounds: [], quotas: {} };

    const maxRounds = REVEALABLE_FIELDS.length;
    if (needed > maxRounds) {
        const rounds = [];
        const quotas = {};
        for (let r = 1; r <= maxRounds; r++) rounds.push(r);
        const base = Math.floor(needed / maxRounds);
        const extra = needed % maxRounds;
        rounds.forEach((r, index) => {
            quotas[r] = base + (index < extra ? 1 : 0);
        });
        return { rounds, quotas };
    }

    const rounds = computeVoteRounds(totalPlayers, survivorsWanted);
    const quotas = {};
    rounds.forEach(r => { quotas[r] = 1; });
    return { rounds, quotas };
}

// ---------------------------------------------------------------------------
//  Логи
// ---------------------------------------------------------------------------

export function addLog(state, text, type = 'info') {
    state.logSeq = (Number(state.logSeq) || 0) + 1;
    state.log.push({ id: state.logSeq, text: String(text), type });
    if (state.log.length > LOG_LIMIT) {
        state.log.splice(0, state.log.length - LOG_LIMIT);
    }
}

// ---------------------------------------------------------------------------
//  Бункер и комнаты
// ---------------------------------------------------------------------------

export function isRoomDiscovered(state, room) {
    return !room.discoverRound || state.discoveredRoomIds.includes(room.id);
}

export function canPlayerOpenRoom(room, player) {
    if (!room.unlock) return false;
    const professions = room.unlock.professions || [];
    const skills = room.unlock.skills || [];
    return professions.includes(player.profession) || skills.includes(player.skill);
}

export function isRoomOpenAtEnd(state, room) {
    if (!isRoomDiscovered(state, room)) return false;
    if (!room.locked && !room.broken) return true;
    return state.players.some(p => p.alive && canPlayerOpenRoom(room, p));
}

function roomGameStatus(state, room) {
    if (!isRoomDiscovered(state, room)) return 'hidden';
    if (!room.locked && !room.broken) return 'open';
    return room.broken ? 'broken' : 'locked';
}

function checkRoomEvents(state) {
    const scenario = getScenario(state.scenarioId);
    if (!scenario) return;

    scenario.rooms.forEach(room => {
        if (isRoomDiscovered(state, room)) return;
        if (!room.discoverRound || state.round < room.discoverRound) return;

        state.discoveredRoomIds.push(room.id);
        addLog(state, `🔍 Новое помещение: «${room.name}». ${room.desc}`, 'room');
        if (room.locked || room.broken) {
            const text = room.unlock ? room.unlock.text : 'нужен особый доступ';
            addLog(state, `Дверь ${room.broken ? 'неисправна' : 'заперта'}: ${text}.`, 'room');
        }
    });
}

// ---------------------------------------------------------------------------
//  Старт игры
// ---------------------------------------------------------------------------

function membersToArray(members) {
    if (Array.isArray(members)) {
        return members
            .filter(m => m && m.uid)
            .map(m => ({ uid: String(m.uid), name: m.name, joinedAt: Number(m.joinedAt) || 0 }));
    }
    return Object.entries(members || {})
        .map(([uid, member]) => ({
            uid,
            name: member && member.name,
            joinedAt: Number(member && member.joinedAt) || 0
        }));
}

export function startGame(state, members, settings = {}) {
    if (state.status !== 'lobby') return { ok: false, error: 'Игра уже началась.' };

    const list = membersToArray(members).sort((a, b) => {
        if (a.joinedAt !== b.joinedAt) return a.joinedAt - b.joinedAt;
        return a.uid.localeCompare(b.uid);
    });

    if (list.length < MIN_PLAYERS) {
        return { ok: false, error: `Нужно минимум ${MIN_PLAYERS} игрока. Сейчас в комнате: ${list.length}.` };
    }
    if (list.length > MAX_PLAYERS) {
        return { ok: false, error: `Максимум ${MAX_PLAYERS} игроков.` };
    }

    const used = new Set();
    const entries = list.map((member, index) => {
        let base = String(member.name || '').replace(/\s+/g, ' ').trim() || `Игрок ${index + 1}`;
        base = base.slice(0, 20);
        let name = base;
        let suffix = 2;
        while (used.has(name)) name = `${base} (${suffix++})`;
        used.add(name);
        return { uid: member.uid, name };
    });

    let scenario = null;
    if (settings.scenarioId && settings.scenarioId !== 'random') {
        scenario = getScenario(settings.scenarioId);
    }
    if (!scenario) scenario = randomItem(SCENARIOS);

    const survivorsTarget = clamp(
        parseInt(settings.survivors, 10) || 2,
        1,
        entries.length - 1
    );
    const plan = computeVotePlan(entries.length, survivorsTarget);

    state.status = 'playing';
    state.phase = 'story';
    state.scenarioId = scenario.id;
    state.settings = { survivors: survivorsTarget, maxPlayers: MAX_PLAYERS };
    state.survivorsTarget = survivorsTarget;
    state.players = generatePlayers(entries, scenario);
    state.round = 1;
    state.currentUid = null;
    state.currentVoterUid = null;
    state.votes = {};
    state.voteOrder = [];
    state.voteCursor = 0;
    state.voteCandidates = null;
    state.deciderCandidates = null;
    state.isTiebreak = false;
    state.voteStep = 1;
    state.voteQuotaTotal = 0;
    state.voteElimsRemaining = 0;
    state.voteTally = null;
    state.lastVoteOutcome = '';
    state.voteRounds = plan.rounds;
    state.voteQuotas = plan.quotas;
    state.baseResources = Object.assign({}, scenario.startResources || {});
    state.baseStability = 0;
    state.discoveredRoomIds = [];
    state.openedRoomIds = [];
    state.final = null;
    state.ending = null;
    state.log = [];
    state.logSeq = 0;
    state.startedAt = Date.now();
    state.updatedAt = Date.now();

    state.players.forEach(p => {
        p.bonusLuggage = [];
        p.actionCardUsed = false;
        p.conditionCardTriggered = false;
        p.acted = false;
    });

    checkRoomEvents(state);

    const planText = state.voteRounds.length
        ? state.voteRounds.map(r => `после раунда ${r} — изгнать ${state.voteQuotas[r]}`).join('; ')
        : 'голосований нет';

    addLog(state, `=== ${scenario.title} ===`, 'title');
    addLog(state, scenario.apocalypse, 'scenario');
    addLog(state, scenario.bunkerDesc, 'scenario');
    addLog(state, `Размеры бункера: ${scenario.bunkerSize}`, 'scenario');
    addLog(state, `=== Игра началась! Игроков: ${entries.length} ===`, 'title');
    addLog(state, `Должно выжить: ${survivorsTarget}.`, 'info');
    addLog(state, 'Профессии всех игроков открыты с начала игры.', 'info');
    addLog(state, `Голосования: ${planText}.`, 'info');
    addLog(state, 'Раунд 1: каждый игрок раскрывает одну характеристику на свой выбор.', 'info');

    return { ok: true, state };
}

// ---------------------------------------------------------------------------
//  Раскрытие характеристик
// ---------------------------------------------------------------------------

function hasUnrevealed(player) {
    return REVEALABLE_FIELDS.some(field => !player.revealed[field.key]);
}

function startRevealTurn(state) {
    if (state.status !== 'playing') return;
    const alive = state.players.filter(p => p.alive);
    if (alive.length <= state.survivorsTarget) {
        endGame(state);
        return;
    }

    alive.forEach(p => {
        if (!hasUnrevealed(p)) p.acted = true;
    });

    const next = state.players.find(p => p.alive && !p.acted);
    if (!next) {
        finishRevealPhase(state);
        return;
    }

    state.phase = 'reveal';
    state.currentUid = next.uid;
}

function finishRevealPhase(state) {
    state.currentUid = null;
    if (state.players.filter(p => p.alive).length <= state.survivorsTarget) {
        endGame(state);
        return;
    }
    if (state.voteRounds.includes(state.round)) startVoteRound(state);
    else nextRound(state);
}

export function beginPlay(state) {
    if (state.status !== 'playing') return { ok: false, error: 'Игра не запущена.' };
    if (state.phase !== 'story') return { ok: false, error: 'Игра уже идёт.' };

    state.phase = 'reveal';
    state.round = 1;
    state.players.forEach(p => { p.acted = !p.alive; });
    startRevealTurn(state);
    return { ok: true, state };
}

export function revealTrait(state, uid, key, customValue) {
    if (state.phase !== 'reveal') return { ok: false, error: 'Сейчас нельзя раскрывать характеристики.' };
    if (state.currentUid !== uid) return { ok: false, error: 'Сейчас ход другого игрока.' };

    const player = state.players.find(p => p.uid === uid);
    if (!player || !player.alive) return { ok: false, error: 'Игрок не найден.' };

    const field = REVEALABLE_FIELDS.find(f => f.key === key);
    if (!field) return { ok: false, error: 'Неизвестная характеристика.' };
    if (player.revealed[key]) return { ok: false, error: 'Эта характеристика уже раскрыта.' };

    if (player[key] === CUSTOM_MARKER) {
        const value = String(customValue == null ? '' : customValue).replace(/\s+/g, ' ').trim();
        if (!value) return { ok: false, error: 'Введите своё значение характеристики.' };
        if (value.length > 60) return { ok: false, error: 'Слишком длинное значение (максимум 60 символов).' };
        player[key] = field.key === 'age' && /^\d{1,3}$/.test(value) ? Number(value) : value;
    }

    player.revealed[key] = true;
    player.acted = true;

    addLog(state, `${player.name} раскрывает ${field.label}: ${displayValue(field, player)}.`, 'reveal');
    advanceAfterActor(state, uid);
    return { ok: true, state };
}

function advanceAfterActor(state, uid) {
    const index = state.players.findIndex(p => p.uid === uid);
    for (let step = 1; step <= state.players.length; step++) {
        const candidate = state.players[(index + step) % state.players.length];
        if (candidate.alive && !candidate.acted && hasUnrevealed(candidate)) {
            state.currentUid = candidate.uid;
            return;
        }
    }
    finishRevealPhase(state);
}

// Хост может пропустить ход игрока, который отключился и не отвечает.
// Пропуск не раскрывает характеристики и не добавляет голос.
export function skipCurrentActor(state) {
    if (state.phase === 'reveal') {
        const player = state.players.find(p => p.uid === state.currentUid);
        if (!player) return { ok: false, error: 'Нет активного игрока.' };
        player.acted = true;
        addLog(state, `${player.name} пропускает ход (нет ответа).`, 'reveal');
        advanceAfterActor(state, player.uid);
        return { ok: true, state };
    }

    if (state.phase === 'vote') {
        const voter = state.players.find(p => p.uid === state.currentVoterUid);
        if (!voter) return { ok: false, error: 'Нет активного голосующего.' };
        addLog(state, `${voter.name} пропускает голосование (нет ответа).`, 'vote');
        state.voteCursor += 1;
        if (state.voteCursor >= state.voteOrder.length) completeVote(state);
        else state.currentVoterUid = state.voteOrder[state.voteCursor];
        return { ok: true, state };
    }

    return { ok: false, error: 'Пропуск доступен только в фазе раскрытия или голосования.' };
}

function nextRound(state) {
    if (state.status !== 'playing') return;
    if (state.players.filter(p => p.alive).length <= state.survivorsTarget) {
        endGame(state);
        return;
    }

    state.round += 1;
    if (state.round > REVEALABLE_FIELDS.length + 1) {
        endGame(state);
        return;
    }

    state.phase = 'reveal';
    state.players.forEach(p => { p.acted = !p.alive; });
    state.currentUid = null;
    checkRoomEvents(state);
    addLog(state, `--- Раунд ${state.round}: каждый раскрывает ещё одну характеристику ---`, 'round');
    startRevealTurn(state);
}

// ---------------------------------------------------------------------------
//  Голосование
// ---------------------------------------------------------------------------

function startVoteRound(state) {
    const alive = state.players.filter(p => p.alive);
    if (alive.length <= state.survivorsTarget) {
        endGame(state);
        return;
    }

    const planned = Math.max(1, parseInt(state.voteQuotas[state.round], 10) || 1);
    state.voteQuotaTotal = Math.max(0, Math.min(planned, alive.length - state.survivorsTarget));
    state.voteElimsRemaining = state.voteQuotaTotal;
    state.voteStep = 1;
    state.lastVoteOutcome = '';

    if (state.voteQuotaTotal <= 0) {
        nextRound(state);
        return;
    }

    addLog(state, `--- Раунд ${state.round}: голосование. Нужно изгнать: ${state.voteQuotaTotal} ---`, 'vote');
    startVote(state, null);
}

function startVote(state, candidates) {
    if (state.players.filter(p => p.alive).length <= state.survivorsTarget) {
        endGame(state);
        return;
    }

    state.phase = 'vote';
    state.votes = {};
    state.voteCandidates = candidates ? candidates.slice() : null;
    state.deciderCandidates = null;
    state.isTiebreak = !!(candidates && candidates.length);
    state.voteOrder = state.players.filter(p => p.alive).map(p => p.uid);
    state.voteCursor = 0;
    state.voteTally = null;

    if (state.isTiebreak) {
        const names = candidates.map(uid => (state.players.find(p => p.uid === uid) || {}).name).filter(Boolean);
        addLog(state, `--- Раунд ${state.round}: переголосование среди лидеров (${names.join(', ')}) ---`, 'vote');
    } else {
        addLog(state, `--- Раунд ${state.round}: анонимное голосование ${state.voteStep} из ${state.voteQuotaTotal} ---`, 'vote');
    }

    state.currentVoterUid = state.voteOrder[0] || null;
    if (!state.currentVoterUid) completeVote(state);
}

export function castVote(state, uid, targetUid) {
    if (state.phase !== 'vote') return { ok: false, error: 'Сейчас нет голосования.' };
    if (state.currentVoterUid !== uid) return { ok: false, error: 'Сейчас голосует другой игрок.' };

    const voter = state.players.find(p => p.uid === uid);
    const target = state.players.find(p => p.uid === targetUid);
    if (!voter || !voter.alive) return { ok: false, error: 'Игрок не найден.' };
    if (!target || !target.alive) return { ok: false, error: 'Нельзя голосовать против выбывшего.' };
    if (target.uid === voter.uid) return { ok: false, error: 'Нельзя голосовать против себя.' };
    if (state.voteCandidates && !state.voteCandidates.includes(target.uid)) {
        return { ok: false, error: 'При переголосовании можно выбрать только лидеров.' };
    }

    state.votes[targetUid] = (Number(state.votes[targetUid]) || 0) + 1;
    addLog(state, `${voter.name} проголосовал(а) анонимно.`, 'vote');

    state.voteCursor += 1;
    if (state.voteCursor >= state.voteOrder.length) {
        completeVote(state);
    } else {
        state.currentVoterUid = state.voteOrder[state.voteCursor];
    }
    return { ok: true, state };
}

function completeVote(state) {
    state.phase = 'vote-result';
    state.currentVoterUid = null;

    const tally = [];
    Object.keys(state.votes || {}).forEach(targetUid => {
        const player = state.players.find(p => p.uid === targetUid);
        if (!player) return;
        tally.push({ uid: targetUid, name: player.name, count: Number(state.votes[targetUid]) || 0 });
    });
    tally.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    state.voteTally = tally;
    addLog(state, 'Голосование завершено. Результаты показаны на экране.', 'vote');
}

export function castDeciderVote(state, uid, targetUid) {
    if (state.phase !== 'decider') return { ok: false, error: 'Сейчас нет решающего голоса.' };

    const player = state.players.find(p => p.uid === uid);
    if (!player || player.alive) return { ok: false, error: 'Решающий голос отдают только выбывшие игроки.' };
    if (!state.deciderCandidates || !state.deciderCandidates.includes(targetUid)) {
        return { ok: false, error: 'Можно выбрать только одного из лидеров.' };
    }

    const target = state.players.find(p => p.uid === targetUid);
    if (!target) return { ok: false, error: 'Кандидат не найден.' };

    state.votes[targetUid] = (Number(state.votes[targetUid]) || 0) + 1;
    addLog(state, `🗳️ Выбывшие игроки отдали общий решающий голос за ${target.name}.`, 'vote');
    completeVote(state);
    return { ok: true, state };
}

export function resolveVoteResults(state) {
    if (state.phase !== 'vote-result') return { ok: false, error: 'Сейчас нет результатов голосования.' };

    let max = 0;
    let candidates = [];
    Object.keys(state.votes || {}).forEach(targetUid => {
        const count = Number(state.votes[targetUid]) || 0;
        if (count > max) {
            max = count;
            candidates = [targetUid];
        } else if (count === max) {
            candidates.push(targetUid);
        }
    });

    if (candidates.length === 0) {
        addLog(state, 'Никто не голосовал. Пропуск.', 'vote');
        afterVoteStep(state);
        return { ok: true, state };
    }

    if (candidates.length > 1 && candidates.length === state.voteElimsRemaining) {
        const names = candidates.map(uid => (state.players.find(p => p.uid === uid) || {}).name).filter(Boolean);
        addLog(state, `⚖️ Голоса разделились ровно между ${candidates.length} лидерами: ${names.join(', ')}. Изгоняем всех сразу.`, 'vote');
        eliminateSeveral(state, candidates);
        return { ok: true, state };
    }

    if (candidates.length === 1) {
        eliminate(state, candidates[0]);
        return { ok: true, state };
    }

    const eliminatedPlayers = state.players.filter(p => !p.alive);
    const names = candidates.map(uid => (state.players.find(p => p.uid === uid) || {}).name).filter(Boolean);

    if (eliminatedPlayers.length > 0) {
        addLog(state, `⚖️ Равенство голосов среди: ${names.join(', ')}. Решающий голос отдают выбывшие игроки.`, 'vote');
        state.phase = 'decider';
        state.deciderCandidates = candidates.slice();
        state.currentVoterUid = null;
    } else {
        addLog(state, `⚖️ Равенство голосов среди: ${names.join(', ')}. Переголосование только среди них.`, 'vote');
        startVote(state, candidates);
    }

    return { ok: true, state };
}

function markEliminated(state, uid) {
    const player = state.players.find(p => p.uid === uid);
    if (!player || !player.alive) return;
    player.alive = false;
    player.acted = true;
    addLog(state, `❌ ${player.name} изгнан(а) из убежища.`, 'elimination');
}

function eliminate(state, uid) {
    const player = state.players.find(p => p.uid === uid);
    if (!player) return;
    markEliminated(state, uid);
    state.voteElimsRemaining = Math.max(0, state.voteElimsRemaining - 1);
    state.lastVoteOutcome = `На предыдущем голосовании изгнан(а): ${player.name}.`;
    afterEliminationStep(state);
}

function eliminateSeveral(state, uids) {
    const names = [];
    uids.forEach(uid => {
        const player = state.players.find(p => p.uid === uid);
        if (!player) return;
        markEliminated(state, uid);
        names.push(player.name);
    });
    state.voteElimsRemaining = Math.max(0, state.voteElimsRemaining - names.length);
    state.lastVoteOutcome = `На предыдущем голосовании изгнаны: ${names.join(', ')}.`;
    afterEliminationStep(state);
}

function afterEliminationStep(state) {
    const aliveCount = state.players.filter(p => p.alive).length;
    if (aliveCount <= state.survivorsTarget) {
        endGame(state);
        return;
    }

    if (state.voteElimsRemaining > 0) {
        state.voteStep += 1;
        addLog(state, `🗳️ Нужно изгнать ещё ${state.voteElimsRemaining}. Запускается голосование ${state.voteStep} из ${state.voteQuotaTotal}.`, 'vote');
        startVote(state, null);
        return;
    }

    afterVoteStep(state);
}

function afterVoteStep(state) {
    nextRound(state);
}

// ---------------------------------------------------------------------------
//  Карты действий
// ---------------------------------------------------------------------------

export function useActionCard(state, uid, payload = {}) {
    if (state.phase !== 'reveal') return { ok: false, error: 'Карту можно использовать только в свой ход.' };
    if (state.currentUid !== uid) return { ok: false, error: 'Сейчас ход другого игрока.' };

    const owner = state.players.find(p => p.uid === uid);
    if (!owner || !owner.alive) return { ok: false, error: 'Игрок не найден.' };
    if (!owner.actionCardId) return { ok: false, error: 'У вас нет карты действия.' };
    if (owner.actionCardUsed) return { ok: false, error: 'Эта карта уже использована.' };

    const card = getActionCard(owner.actionCardId);
    if (!card) return { ok: false, error: 'Карта не найдена.' };

    const target = state.players.find(p => p.uid === payload.targetUid && p.alive && p.uid !== uid);
    if (!target) return { ok: false, error: 'Выберите другого живого игрока.' };

    const field = card.field ? FIELDS.find(f => f.key === card.field) : null;

    if (card.kind === 'reveal') {
        if (!field) return { ok: false, error: 'Неизвестная характеристика карты.' };
        if (target.revealed[field.key]) return { ok: false, error: 'Эта характеристика уже раскрыта.' };
        if (target[field.key] === CUSTOM_MARKER) {
            return { ok: false, error: 'Игрок ещё не придумал значение этой характеристики.' };
        }
        target.revealed[field.key] = true;
        addLog(state, `🃏 ${owner.name} использует «${card.name}» и раскрывает у ${target.name} ${field.label}: ${displayValue(field, target)}.`, 'action');
    } else if (card.kind === 'swap') {
        if (!field) return { ok: false, error: 'Неизвестная характеристика карты.' };
        if (!owner.revealed[field.key] || !target.revealed[field.key]) {
            return { ok: false, error: 'Обменять можно только уже открытую у обоих характеристику.' };
        }
        if (owner[field.key] === target[field.key]) {
            return { ok: false, error: 'У вас одинаковые значения — обмен ничего не изменит.' };
        }
        const ownerValue = owner[field.key];
        owner[field.key] = target[field.key];
        target[field.key] = ownerValue;
        addLog(state, `🃏 ${owner.name} использует «${card.name}» и меняется с ${target.name} характеристикой ${field.label}. Теперь у ${owner.name}: ${displayValue(field, owner)}, у ${target.name}: ${displayValue(field, target)}.`, 'action');
    } else if (card.kind === 'steal') {
        const slot = ['luggage1', 'luggage2'].find(key => {
            const value = target[key];
            return value && value !== CUSTOM_MARKER && value !== '—';
        });
        if (!slot) return { ok: false, error: 'У этого игрока нет подходящего багажа.' };
        const item = target[slot];
        owner.bonusLuggage = owner.bonusLuggage || [];
        owner.bonusLuggage.push(item);
        target[slot] = '—';
        target.revealed[slot] = true;
        addLog(state, `🃏 ${owner.name} использует «${card.name}» и забирает у ${target.name} багаж: ${item}.`, 'action');
    } else {
        return { ok: false, error: 'Неизвестная карта действия.' };
    }

    owner.actionCardUsed = true;
    return { ok: true, state };
}

// ---------------------------------------------------------------------------
//  Финальный расчёт
// ---------------------------------------------------------------------------

function emptyEffects() {
    return {};
}

function addEffect(target, key, value) {
    if (!value) return;
    target[key] = (target[key] || 0) + value;
}

function mergeEffects(target, source) {
    Object.keys(source || {}).forEach(key => addEffect(target, key, source[key]));
}

function effectsNotEmpty(effects) {
    return !!effects && Object.values(effects).some(value => value !== 0);
}

export function effectSum(effects) {
    return Object.values(effects || {}).reduce((sum, value) => sum + value, 0);
}

function getHealthEffects(value) {
    if (HEALTH_GOOD.includes(value)) return { medicine: 1, stability: 1 };
    if (HEALTH_NEUTRAL.includes(value)) return {};
    if (HEALTH_SEVERE.includes(value)) return { medicine: -2, stability: -2 };
    if (HEALTH_MODERATE.includes(value)) return { medicine: -1, stability: -1 };
    if (HEALTH_MILD.includes(value)) return { medicine: -1 };
    return {};
}

function getPhobiaEffects(value) {
    if (value === 'Нет фобий') return { stability: 1 };
    if (PHOBIA_SEVERE.includes(value)) return { stability: -1 };
    return {};
}

function getCharacterEffects(value) {
    const effects = emptyEffects();
    if (CHARACTER_POSITIVE.includes(value)) addEffect(effects, 'stability', 1);
    if (CHARACTER_NEGATIVE.includes(value)) addEffect(effects, 'stability', -1);
    mergeEffects(effects, CHARACTER_EXTRA_EFFECTS[value] || {});
    return effects;
}

function getAgeEffects(age) {
    const years = Number(age);
    if (!Number.isFinite(years)) return {};
    if (years <= 15) return { food: -1, medicine: -1 };
    if (years <= 17) return { power: -1 };
    if (years <= 55) return { power: 1 };
    if (years <= 65) return { medicine: -1 };
    return { medicine: -1, power: -1, stability: -1 };
}

function getTraitEffectEntries(player) {
    const entries = [];
    const push = (fieldKey, fieldLabel, label, effects) => {
        if (!effectsNotEmpty(effects)) return;
        entries.push({ field: fieldKey, fieldLabel, label: String(label), effects });
    };

    push('profession', 'Профессия', player.profession, PROFESSION_EFFECTS[player.profession] || {});
    push('health', 'Здоровье', player.health, getHealthEffects(player.health));
    push('age', 'Возраст', `${player.age} лет`, getAgeEffects(player.age));
    push('hobby', 'Хобби', player.hobby, HOBBY_EFFECTS[player.hobby] || {});
    push('phobia', 'Фобия', player.phobia, getPhobiaEffects(player.phobia));
    push('skill', 'Навык', player.skill, SKILL_EFFECTS[player.skill] || {});
    push('character', 'Характер', player.character, getCharacterEffects(player.character));
    push('luggage1', 'Багаж 1', player.luggage1, LUGGAGE_EFFECTS[player.luggage1] || {});
    push('luggage2', 'Багаж 2', player.luggage2, LUGGAGE_EFFECTS[player.luggage2] || {});
    push('fact1', 'Факт 1', player.fact1, FACT_EFFECTS[player.fact1] || {});
    push('fact2', 'Факт 2', player.fact2, FACT_EFFECTS[player.fact2] || {});

    return entries;
}

function inventoryItemEffects(item) {
    const effects = emptyEffects();
    (item.effects || []).forEach(effect => {
        if (effect.resource) addEffect(effects, effect.resource, effect.delta);
        if (effect.stability) addEffect(effects, 'stability', effect.stability);
    });
    return effects;
}

export function computeFinalState(state) {
    const scenario = getScenario(state.scenarioId);
    const final = {
        scenarioId: state.scenarioId,
        base: Object.assign({}, state.baseResources),
        baseStability: state.baseStability,
        resources: Object.assign({}, state.baseResources),
        stability: state.baseStability,
        traitEntries: [],
        roomEntries: [],
        conditionEntries: [],
        luggageEntries: [],
        openedRoomIds: [],
        openedRoomNames: [],
        closedRoomNames: [],
        unknownRoomCount: 0
    };

    const survivors = state.players.filter(p => p.alive);

    survivors.forEach(player => {
        getTraitEffectEntries(player).forEach(entry => {
            mergeEffects(final.resources, entry.effects);
            final.stability += entry.effects.stability || 0;
            final.traitEntries.push({ source: player.name, sourceType: 'player', ...entry });
        });
    });

    if (scenario) {
        scenario.rooms.forEach(room => {
            if (!isRoomDiscovered(state, room)) {
                final.unknownRoomCount += 1;
                return;
            }
            if (isRoomOpenAtEnd(state, room)) {
                final.openedRoomIds.push(room.id);
                final.openedRoomNames.push(room.name);
                (room.inventory || []).forEach(item => {
                    const effects = inventoryItemEffects(item);
                    if (!effectsNotEmpty(effects)) return;
                    mergeEffects(final.resources, effects);
                    final.stability += effects.stability || 0;
                    final.roomEntries.push({
                        source: room.name,
                        sourceType: 'room',
                        field: 'room',
                        fieldLabel: 'Комната',
                        label: item.name,
                        effects
                    });
                });
            } else {
                final.closedRoomNames.push(room.name);
            }
        });
    }

    state.players.forEach(player => {
        const card = getConditionCard(player.conditionCardId);
        if (!card) return;
        const applies = (card.trigger === 'entry' && player.alive) ||
                        (card.trigger === 'elimination' && !player.alive);
        player.conditionCardTriggered = applies;
        if (!applies) return;

        const effects = emptyEffects();
        if (card.effect.resources) mergeEffects(effects, card.effect.resources);
        if (card.effect.stability) addEffect(effects, 'stability', card.effect.stability);

        if (effectsNotEmpty(effects)) {
            mergeEffects(final.resources, effects);
            final.stability += effects.stability || 0;
        }

        if (card.effect.luggage) {
            player.bonusLuggage = player.bonusLuggage || [];
            player.bonusLuggage.push(card.effect.luggage);
        }

        final.conditionEntries.push({
            source: player.name,
            sourceType: 'condition',
            field: 'condition',
            fieldLabel: card.trigger === 'entry' ? 'Условие входа' : 'Условие изгнания',
            label: card.name,
            effects,
            luggage: card.effect.luggage || null
        });
    });

    survivors.forEach(player => {
        (player.bonusLuggage || []).forEach(item => {
            const effects = LUGGAGE_EFFECTS[item] || {};
            if (!effectsNotEmpty(effects)) return;
            mergeEffects(final.resources, effects);
            final.stability += effects.stability || 0;
            final.luggageEntries.push({
                source: player.name,
                sourceType: 'luggage',
                field: 'bonus',
                fieldLabel: 'Бонусный багаж',
                label: item,
                effects
            });
        });
    });

    Object.keys(RESOURCE_META).forEach(key => {
        final.resources[key] = Math.max(0, Math.round(final.resources[key] || 0));
    });
    final.stability = clamp(Math.round(final.stability || 0), -5, 5);

    return final;
}

export function evaluateEnding(final) {
    const resources = final.resources;

    let type = 'neutral';
    if (resources.food <= 0 ||
        resources.water <= 0 ||
        final.stability <= -3 ||
        (resources.power <= 0 && resources.medicine <= 0)) {
        type = 'bad';
    } else if (resources.food >= 3 &&
        resources.water >= 3 &&
        resources.power >= 2 &&
        resources.medicine >= 2 &&
        resources.defense >= 2 &&
        final.stability >= 0) {
        type = 'good';
    }

    const scenario = getScenario(final.scenarioId) || null;
    const info = (scenario && scenario.endings && scenario.endings[type]) || { title: 'Финал', text: '' };
    return { type, title: info.title, text: info.text };
}

function buildEndingData(state, final, result) {
    const scenario = getScenario(state.scenarioId);
    const allEntries = [
        ...final.traitEntries,
        ...final.roomEntries,
        ...final.conditionEntries,
        ...final.luggageEntries
    ];

    const positive = allEntries.filter(entry => effectSum(entry.effects) > 0);
    const negative = allEntries.filter(entry => effectSum(entry.effects) < 0);
    const neutral = allEntries.filter(entry => effectSum(entry.effects) === 0);

    const triggeredConditions = final.conditionEntries
        .map(entry => `${entry.source} — «${entry.label}»`)
        .join(', ') || 'никакие';

    const skippedConditions = state.players
        .filter(p => p.conditionCardId && !p.conditionCardTriggered)
        .map(p => {
            const card = getConditionCard(p.conditionCardId);
            return `${p.name} — «${card ? card.name : 'условие'}»`;
        })
        .join(', ') || 'нет';

    const players = state.players.map(player => {
        const actionCard = getActionCard(player.actionCardId);
        const conditionCard = getConditionCard(player.conditionCardId);

        let conditionText = 'нет';
        if (conditionCard) {
            if (player.conditionCardTriggered) {
                conditionText = `${conditionCard.name} (сработало)`;
            } else if (conditionCard.trigger === 'entry') {
                conditionText = `${conditionCard.name} (не сработало: не прошёл)`;
            } else {
                conditionText = `${conditionCard.name} (не сработало)`;
            }
        }

        return {
            name: player.name,
            alive: player.alive,
            fields: FIELDS.map(field => ({
                label: field.label,
                value: displayValue(field, player),
                revealed: !!player.revealed[field.key]
            })),
            actionText: actionCard
                ? `${actionCard.name}${player.actionCardUsed ? ' (использована)' : ' (не использована)'}`
                : 'нет',
            conditionText,
            bonusText: (player.bonusLuggage && player.bonusLuggage.length)
                ? player.bonusLuggage.join(', ')
                : 'нет'
        };
    });

    return {
        type: result.type,
        title: result.title,
        text: result.text,
        scenarioTitle: scenario ? scenario.title : '',
        survivors: state.players.filter(p => p.alive).map(p => p.name),
        eliminated: state.players.filter(p => !p.alive).map(p => p.name),
        table: {
            base: final.base,
            baseStability: final.baseStability,
            resources: final.resources,
            stability: final.stability
        },
        effects: { positive, negative, neutral },
        openedRoomNames: final.openedRoomNames,
        closedRoomNames: final.closedRoomNames,
        unknownRoomCount: final.unknownRoomCount,
        triggeredConditions,
        skippedConditions,
        players
    };
}

export function endGame(state) {
    if (state.phase === 'ended') return { ok: true, state };

    state.phase = 'ended';
    state.status = 'ended';
    state.currentUid = null;
    state.currentVoterUid = null;
    state.voteCandidates = null;
    state.deciderCandidates = null;

    const final = computeFinalState(state);
    const result = evaluateEnding(final);
    state.final = final;
    state.openedRoomIds = final.openedRoomIds.slice();
    state.ending = buildEndingData(state, final, result);

    const survivors = state.players.filter(p => p.alive);
    addLog(state, `=== Игра окончена. Выжили: ${survivors.map(p => p.name).join(', ') || 'никто'} ===`, 'title');
    addLog(state, `=== КОНЦОВКА: ${result.title} ===`, 'title');
    addLog(state, result.text, 'ending');

    return { ok: true, state };
}

// ---------------------------------------------------------------------------
//  Публичное состояние и приватная рука игрока
// ---------------------------------------------------------------------------

function buildRoomInfo(state, scenario) {
    if (!scenario) return { rooms: [], hiddenCount: 0 };

    const endMode = state.phase === 'ended';
    const known = scenario.rooms.filter(room => isRoomDiscovered(state, room) || endMode);

    const rooms = known.map(room => {
        const status = endMode
            ? (isRoomOpenAtEnd(state, room) ? 'open' : 'closed')
            : roomGameStatus(state, room);
        return {
            id: room.id,
            name: room.name,
            desc: room.desc,
            inventory: room.inventory || [],
            locked: !!room.locked,
            broken: !!room.broken,
            status,
            unlockText: room.unlock ? room.unlock.text : 'нужен особый доступ',
            hasOpenerEver: state.players.some(p => canPlayerOpenRoom(room, p)),
            hasOpenerAlive: state.players.some(p => p.alive && canPlayerOpenRoom(room, p)),
            openAtEnd: endMode ? isRoomOpenAtEnd(state, room) : false
        };
    });

    return { rooms, hiddenCount: Math.max(0, scenario.rooms.length - known.length) };
}

function publicPlayer(state, player) {
    const values = {};
    FIELDS.forEach(field => {
        const visible = !!player.revealed[field.key] ||
            !player.alive ||
            state.phase === 'ended';
        if (visible) values[field.key] = player[field.key];
    });

    return {
        uid: player.uid,
        name: player.name,
        seat: player.seat,
        alive: player.alive,
        isHost: player.uid === state.hostUid,
        revealed: Object.assign({}, player.revealed),
        values
    };
}

export function buildPublicState(state) {
    const scenario = getScenario(state.scenarioId);
    const roomInfo = buildRoomInfo(state, scenario);

    const current = state.players.find(p => p.uid === state.currentUid) ||
        state.players.find(p => p.uid === state.currentVoterUid) || null;

    const votedCount = state.phase === 'vote'
        ? state.voteCursor
        : (state.voteOrder || []).length;

    return {
        version: STATE_VERSION,
        code: state.code,
        hostUid: state.hostUid,
        status: state.status,
        phase: state.phase,
        round: state.round,
        scenario: scenario ? {
            id: scenario.id,
            title: scenario.title,
            apocalypse: scenario.apocalypse,
            bunkerDesc: scenario.bunkerDesc,
            bunkerSize: scenario.bunkerSize,
            startResources: scenario.startResources || {}
        } : null,
        players: state.players.map(player => publicPlayer(state, player)),
        aliveCount: state.players.filter(p => p.alive).length,
        survivorsTarget: state.survivorsTarget,
        settings: state.settings,
        voteRounds: state.voteRounds,
        voteQuotas: state.voteQuotas,
        currentUid: state.currentUid,
        currentName: current ? current.name : null,
        vote: {
            step: state.voteStep,
            quotaTotal: state.voteQuotaTotal,
            elimsRemaining: state.voteElimsRemaining,
            voterCount: (state.voteOrder || []).length,
            votedCount,
            currentVoterUid: state.currentVoterUid,
            isTiebreak: state.isTiebreak,
            candidateUids: state.voteCandidates || [],
            deciderCandidateUids: state.deciderCandidates || [],
            tally: state.voteTally || [],
            lastOutcome: state.lastVoteOutcome
        },
        baseResources: state.baseResources,
        baseStability: state.baseStability,
        discoveredRoomIds: state.discoveredRoomIds,
        openedRoomIds: state.openedRoomIds,
        rooms: roomInfo.rooms,
        hiddenRoomCount: roomInfo.hiddenCount,
        log: state.log,
        ending: state.ending,
        updatedAt: state.updatedAt
    };
}

export function buildHand(state, uid) {
    const player = state.players.find(p => p.uid === uid);
    if (!player) return null;

    return {
        uid,
        name: player.name,
        seat: player.seat,
        player: {
            ...player,
            actionCard: getActionCard(player.actionCardId),
            conditionCard: getConditionCard(player.conditionCardId)
        },
        isMyTurn: state.phase === 'reveal' && state.currentUid === uid,
        isMyVote: state.phase === 'vote' && state.currentVoterUid === uid,
        isDecider: state.phase === 'decider' && !player.alive,
        updatedAt: Date.now()
    };
}

// ---------------------------------------------------------------------------
//  Обработка команд (только на хосте)
// ---------------------------------------------------------------------------

function fail(error) {
    return { ok: false, error };
}

export function applyCommand(hostState, command, options = {}) {
    if (!command || typeof command !== 'object' || !command.uid || !command.type) {
        return fail('Некорректная команда.');
    }

    const state = safeJsonClone(hostState);
    const uid = String(command.uid);
    const type = String(command.type);
    const payload = command.payload || {};

    const isHost = uid === state.hostUid;

    if (type === 'start') {
        if (!isHost) return fail('Начать игру может только хост.');
        return startGame(state, options.members || {}, payload);
    }

    if (type === 'restart') {
        if (!isHost) return fail('Перезапустить игру может только хост.');
        const fresh = createLobbyState({ code: state.code, hostUid: state.hostUid });
        fresh.createdAt = state.createdAt;
        addLog(fresh, 'Игра перезапущена. Настройте новую партию в лобби.', 'info');
        fresh.updatedAt = Date.now();
        return { ok: true, state: fresh };
    }

    if (state.status !== 'playing') return fail('Игра ещё не началась.');

    if (type === 'begin') {
        if (!isHost) return fail('Начать раунд может только хост.');
        return beginPlay(state);
    }

    if (type === 'reveal') {
        return revealTrait(state, uid, String(payload.key || ''), payload.value);
    }

    if (type === 'action') {
        return useActionCard(state, uid, payload);
    }

    if (type === 'vote') {
        return castVote(state, uid, String(payload.targetUid || ''));
    }

    if (type === 'decider') {
        return castDeciderVote(state, uid, String(payload.targetUid || ''));
    }

    if (type === 'skip') {
        if (!isHost) return fail('Пропустить ход может только хост.');
        return skipCurrentActor(state);
    }

    if (type === 'continue') {
        if (!isHost) return fail('Продолжить может только хост.');
        return resolveVoteResults(state);
    }

    return fail('Неизвестная команда.');
}
