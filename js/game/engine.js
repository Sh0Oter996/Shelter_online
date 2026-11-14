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
    LUGGAGE_POOL,
    FACT_POOL,
    FIELDS,
    REVEALABLE_FIELDS,
    AGE_CATEGORIES,
    HEALTH_CATEGORIES,
    DEFAULT_GENERATION,
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
export const STATE_VERSION = 2;

const ROOM_ITEM_NAMES = new Set(
    SCENARIOS.flatMap(scenario =>
        scenario.rooms.flatMap(room => (room.inventory || []).map(item => item.name))
    )
);
const ROOM_ITEM_NAMES_LOWER = new Set(
    [...ROOM_ITEM_NAMES].map(name => String(name).trim().toLowerCase())
);

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

function traitGroupKeys(key) {
    if (key === 'luggage1' || key === 'luggage2') return ['luggage1', 'luggage2'];
    if (key === 'fact1' || key === 'fact2') return ['fact1', 'fact2'];
    return [key];
}

function isTraitValueTaken(state, uid, key, value) {
    const normalized = String(value == null ? '' : value).trim().toLowerCase();
    if (!normalized) return false;
    const keys = traitGroupKeys(key);

    return state.players.some(player =>
        keys.some(candidateKey => {
            if (player.uid === uid && candidateKey === key) return false;
            const raw = player[candidateKey];
            if (raw == null || raw === CUSTOM_MARKER || raw === '—') return false;
            return String(raw).trim().toLowerCase() === normalized;
        })
    );
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

function normalizeWeights(raw, count) {
    const source = Array.isArray(raw) ? raw : toArray(raw);
    const weights = Array.from({ length: count }, (_, index) => {
        const value = Number(source[index]);
        return Number.isFinite(value) && value > 0 ? value : 0;
    });
    return weights.every(weight => weight === 0) ? Array(count).fill(1) : weights;
}

export function normalizeGeneration(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
        ageWeights: normalizeWeights(
            source.ageWeights || DEFAULT_GENERATION.ageWeights,
            AGE_CATEGORIES.length
        ),
        healthWeights: normalizeWeights(
            source.healthWeights || DEFAULT_GENERATION.healthWeights,
            HEALTH_CATEGORIES.length
        ),
        orientationWeights: normalizeWeights(
            source.orientationWeights || DEFAULT_GENERATION.orientationWeights,
            POOLS.orientation.length
        )
    };
}

function weightedIndex(weights, indices) {
    if (!indices || indices.length === 0) return -1;
    const available = indices.filter(index => (weights[index] || 0) > 0);
    if (available.length === 0) return randomItem(indices);

    const total = available.reduce((sum, index) => sum + weights[index], 0);
    let roll = Math.random() * total;
    for (const index of available) {
        roll -= weights[index];
        if (roll < 0) return index;
    }
    return available[available.length - 1];
}

function generateUniqueAges(count, weights) {
    const categories = AGE_CATEGORIES.map((category, index) => ({
        index,
        values: Array.from(
            { length: category.max - category.min + 1 },
            (_, offset) => category.min + offset
        )
    }));
    const used = new Set();
    const ages = [];

    for (let n = 0; n < count; n++) {
        const available = categories.filter(category =>
            category.values.some(value => !used.has(value))
        );

        if (available.length === 0) {
            let fallback = 10;
            while (fallback <= 100 && used.has(fallback)) fallback++;
            used.add(fallback);
            ages.push(fallback);
            continue;
        }

        const category = categories[weightedIndex(weights, available.map(item => item.index))];
        const unused = category.values.filter(value => !used.has(value));
        const age = randomItem(unused);
        used.add(age);
        ages.push(age);
    }

    return ages;
}

function generateUniqueHealth(count, weights) {
    const categories = HEALTH_CATEGORIES.map((category, index) => ({
        index,
        remaining: category.values.slice()
    }));
    const health = [];

    for (let n = 0; n < count; n++) {
        const available = categories.filter(category => category.remaining.length > 0);
        if (available.length === 0) {
            health.push('Идеальное здоровье');
            continue;
        }

        const category = categories[weightedIndex(weights, available.map(item => item.index))];
        const value = randomItem(category.remaining);
        category.remaining = category.remaining.filter(item => item !== value);
        health.push(value);
    }

    return health;
}

function generateOrientations(count, weights) {
    const indices = POOLS.orientation.map((_, index) => index);
    return Array.from(
        { length: count },
        () => POOLS.orientation[weightedIndex(weights, indices)]
    );
}

function assignUniqueField(players, key, pool) {
    const field = FIELDS.find(item => item.key === key) || {};
    const customChance = field.customChance || 0;
    const customPlayers = [];
    const normalPlayers = [];

    players.forEach((player, index) => {
        if (customChance > 0 && Math.random() < customChance) customPlayers.push(index);
        else normalPlayers.push(index);
    });

    // Не больше одного «Придумай сам» на характеристику: иначе два игрока
    // визуально получают одинаковый маркер, а уникальность проверяется только
    // после ввода значения.
    if (customPlayers.length > 1) {
        const keep = randomItem(customPlayers);
        customPlayers.forEach(playerIndex => {
            if (playerIndex !== keep) normalPlayers.push(playerIndex);
        });
        customPlayers.length = 0;
        customPlayers.push(keep);
    }

    const candidates = shuffle(
        ensurePoolSize(Array.from(new Set(pool)), normalPlayers.length, 'Вариант')
    );
    normalPlayers.forEach((playerIndex, valueIndex) => {
        players[playerIndex][key] = candidates[valueIndex];
    });
    customPlayers.forEach(playerIndex => {
        players[playerIndex][key] = CUSTOM_MARKER;
    });
}

// Для багажа и фактов уникальность держится не только между игроками, но и
// между двумя слотами одного игрока.
function assignSharedSlots(players, keys, pool) {
    const slots = [];

    players.forEach((player, playerIndex) => {
        keys.forEach(key => {
            const field = FIELDS.find(item => item.key === key) || {};
            const customChance = field.customChance || 0;
            slots.push({
                playerIndex,
                key,
                custom: customChance > 0 && Math.random() < customChance
            });
        });
    });

    const normalSlots = slots.filter(slot => !slot.custom);
    const customSlots = slots.filter(slot => slot.custom);
    if (customSlots.length > 1) {
        const keep = randomItem(customSlots);
        customSlots.forEach(slot => {
            if (slot !== keep) {
                slot.custom = false;
                normalSlots.push(slot);
            }
        });
    }

    const candidates = shuffle(
        ensurePoolSize(Array.from(new Set(pool)), normalSlots.length, 'Вариант')
    );
    normalSlots.forEach((slot, index) => {
        players[slot.playerIndex][slot.key] = candidates[index];
    });
    slots.filter(slot => slot.custom).forEach(slot => {
        players[slot.playerIndex][slot.key] = CUSTOM_MARKER;
    });
}

function luggageCandidatePool() {
    return Array.from(new Set(LUGGAGE_POOL))
        .filter(item => !ROOM_ITEM_NAMES.has(item));
}

function generatePlayers(entries, scenario, generation) {
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

    const ages = generateUniqueAges(players.length, generation.ageWeights);
    const health = generateUniqueHealth(players.length, generation.healthWeights);
    const orientations = generateOrientations(players.length, generation.orientationWeights);

    players.forEach((player, index) => {
        player.age = ages[index];
        player.health = health[index];
        player.orientation = orientations[index];
        player.sex = randomItem(POOLS.sex);
    });

    assignUniqueField(players, 'profession', POOLS.profession);
    assignUniqueField(players, 'hobby', POOLS.hobby);
    assignUniqueField(players, 'phobia', POOLS.phobia);
    assignUniqueField(players, 'skill', POOLS.skill);
    assignUniqueField(players, 'character', POOLS.character);
    assignSharedSlots(players, ['luggage1', 'luggage2'], luggageCandidatePool());
    assignSharedSlots(players, ['fact1', 'fact2'], FACT_POOL);

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

// Ручной план: хост сам указывает, после каких раундов голосовать и сколько
// игроков изгонять на каждом голосовании.
export function parseManualVotePlan(roundsInput, quotasInput, totalPlayers, survivorsWanted) {
    const needed = Math.max(0, totalPlayers - survivorsWanted);
    const maxRound = REVEALABLE_FIELDS.length;
    const maxPerVote = Math.max(1, totalPlayers - survivorsWanted);

    const rawRounds = Array.isArray(roundsInput)
        ? roundsInput
        : typeof roundsInput === 'string'
            ? roundsInput.split(',')
            : toArray(roundsInput);

    const rounds = [...new Set(
        rawRounds
            .map(value => parseInt(value, 10))
            .filter(value => Number.isFinite(value) && value >= 1 && value <= maxRound)
    )].sort((a, b) => a - b);

    if (rounds.length === 0) {
        return { ok: false, error: `Укажите хотя бы один раунд голосования (1–${maxRound}).` };
    }

    const quotas = {};
    rounds.forEach(round => {
        let value = parseInt(quotasInput && quotasInput[round], 10);
        if (!Number.isFinite(value) || value < 1) value = 1;
        quotas[round] = Math.min(maxPerVote, value);
    });

    const planned = rounds.reduce((sum, round) => sum + quotas[round], 0);
    if (planned < needed) {
        return {
            ok: false,
            error: `План изгоняет ${planned} игрок(ов), а для ${survivorsWanted} выживших нужно ${needed}. Увеличьте число изгнаний.`
        };
    }

    return { ok: true, plan: { rounds, quotas } };
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

    const voteMode = settings.voteMode === 'manual' ? 'manual' : 'auto';
    let plan;
    if (voteMode === 'manual') {
        const manual = parseManualVotePlan(
            settings.voteRounds,
            settings.voteQuotas,
            entries.length,
            survivorsTarget
        );
        if (!manual.ok) return manual;
        plan = manual.plan;
    } else {
        plan = computeVotePlan(entries.length, survivorsTarget);
    }

    const generation = normalizeGeneration(settings.generation);

    state.status = 'playing';
    state.phase = 'story';
    state.scenarioId = scenario.id;
    state.settings = {
        survivors: survivorsTarget,
        maxPlayers: MAX_PLAYERS,
        voteMode,
        generation
    };
    state.survivorsTarget = survivorsTarget;
    state.players = generatePlayers(entries, scenario, generation);
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
        if (isTraitValueTaken(state, uid, key, value)) {
            return { ok: false, error: 'Такое значение уже есть у другого игрока. Все характеристики, кроме пола и ориентации, должны быть уникальны.' };
        }
        if ((key === 'luggage1' || key === 'luggage2') && ROOM_ITEM_NAMES_LOWER.has(value.toLowerCase())) {
            return { ok: false, error: 'Этот предмет уже есть в инвентаре комнат бункера. Придумайте другой багаж.' };
        }
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

function shiftAgesUniquely(players, delta) {
    const used = new Set();
    const order = shuffle(players);

    order.forEach(player => {
        const current = Number(player.age);
        const base = clamp(Number.isFinite(current) ? current + delta : 50 + delta, 10, 100);
        let candidate = base;
        let offset = 1;

        // Сохраняем уникальность возрастов, даже если сдвиг создаёт коллизию.
        while (used.has(candidate) && offset <= 200) {
            const up = clamp(base + offset, 10, 100);
            const down = clamp(base - offset, 10, 100);
            if (!used.has(up)) {
                candidate = up;
                break;
            }
            if (!used.has(down)) {
                candidate = down;
                break;
            }
            offset += 1;
        }

        player.age = candidate;
        used.add(candidate);
    });
}

function shuffleRevealedField(state, fieldKey) {
    const participants = state.players.filter(player => {
        const isPublic = !!player.revealed[fieldKey] || !player.alive;
        const value = player[fieldKey];
        return isPublic && value !== CUSTOM_MARKER && value != null && value !== '—';
    });

    if (participants.length < 2) return { count: participants.length };

    const values = shuffle(participants.map(player => player[fieldKey]));
    participants.forEach((player, index) => {
        player[fieldKey] = values[index];
        player.revealed[fieldKey] = true;
    });

    return { count: participants.length };
}

function applyImmediateCondition(state, player) {
    const card = getConditionCard(player.conditionCardId);
    if (!card || card.trigger !== 'immediate' || player.conditionCardTriggered) return;

    player.conditionCardTriggered = true;

    if (card.effect.ageShift) {
        const shift = Number(card.effect.ageShift) || 0;
        shiftAgesUniquely(state.players, shift);
        addLog(
            state,
            `🎴 «${card.name}»: ${player.name} изгнан(а), возраст всех игроков ${shift > 0 ? 'увеличился' : 'уменьшился'} на ${Math.abs(shift)} лет.`,
            'condition'
        );
    }

    if (card.effect.shuffleRevealed) {
        const field = FIELDS.find(item => item.key === card.effect.shuffleRevealed);
        const result = shuffleRevealedField(state, card.effect.shuffleRevealed);
        if (field) {
            addLog(
                state,
                result.count >= 2
                    ? `🎴 «${card.name}»: открытые характеристики «${field.label}» перемешаны между игроками.`
                    : `🎴 «${card.name}»: для перемешивания не хватило открытых характеристик «${field.label}».`,
                'condition'
            );
        }
    }
}

function markEliminated(state, uid) {
    const player = state.players.find(p => p.uid === uid);
    if (!player || !player.alive) return;
    player.alive = false;
    player.acted = true;
    addLog(state, `❌ ${player.name} изгнан(а) из убежища.`, 'elimination');
    applyImmediateCondition(state, player);
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
        // Мгновенные условия уже применились в момент изгнания и не влияют
        // на финальный расчёт повторно.
        if (card.trigger === 'immediate') return;

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

    const triggeredConditionsList = final.conditionEntries
        .map(entry => `${entry.source} — «${entry.label}»`);

    state.players.forEach(player => {
        if (!player.conditionCardTriggered) return;
        const card = getConditionCard(player.conditionCardId);
        if (card && card.trigger === 'immediate') {
            triggeredConditionsList.push(`${player.name} — «${card.name}» (сразу после изгнания)`);
        }
    });

    const triggeredConditions = triggeredConditionsList.join(', ') || 'никакие';

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
                conditionText = conditionCard.trigger === 'immediate'
                    ? `${conditionCard.name} (сработало сразу после изгнания)`
                    : `${conditionCard.name} (сработало)`;
            } else if (conditionCard.trigger === 'entry') {
                conditionText = `${conditionCard.name} (не сработало: не прошёл)`;
            } else if (conditionCard.trigger === 'immediate') {
                conditionText = `${conditionCard.name} (не сработало: игрок остался в бункере)`;
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
