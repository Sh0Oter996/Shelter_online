import assert from 'node:assert/strict';
import {
    createLobbyState,
    startGame,
    applyCommand,
    buildPublicState,
    buildHand,
    normalizeState,
    computeVotePlan
} from '../js/game/engine.js';
import { REVEALABLE_FIELDS, CUSTOM_MARKER } from '../js/config.js';

const members = {
    u1: { name: 'Алиса', joinedAt: 1 },
    u2: { name: 'Борис', joinedAt: 2 },
    u3: { name: 'Вера', joinedAt: 3 },
    u4: { name: 'Глеб', joinedAt: 4 }
};

function makeGame(count = 4, scenarioId = 'nuclear') {
    const list = Object.entries(members).slice(0, count);
    const memberMap = Object.fromEntries(list);
    let state = createLobbyState({ code: '123456', hostUid: 'u1' });
    const result = startGame(state, memberMap, { scenarioId, survivors: Math.max(1, count - 2) });
    assert.ok(result.ok, result.error);
    return result.state;
}

function command(state, uid, type, payload = {}) {
    const result = applyCommand(state, { uid, type, payload }, { members });
    assert.ok(result.ok, `Команда ${type} отклонена: ${result.error}`);
    return result.state;
}

function playGame(initial) {
    let state = command(initial, 'u1', 'begin');
    let guard = 0;

    while (state.phase !== 'ended' && guard++ < 3000) {
        if (state.phase === 'reveal') {
            const player = state.players.find(p => p.uid === state.currentUid);
            assert.ok(player, 'Нет текущего игрока в фазе раскрытия');
            const field = REVEALABLE_FIELDS.find(f => !player.revealed[f.key]);
            assert.ok(field, `У игрока ${player.name} не осталось характеристик`);
            const value = player[field.key] === CUSTOM_MARKER ? 'Своё значение' : null;
            state = command(state, player.uid, 'reveal', { key: field.key, value });
            continue;
        }

        if (state.phase === 'vote') {
            const alive = state.players.filter(p => p.alive);
            const victim = alive[0].uid;
            const voter = state.currentVoterUid;
            const target = voter === victim ? alive[1].uid : victim;
            state = command(state, voter, 'vote', { targetUid: target });
            continue;
        }

        if (state.phase === 'vote-result') {
            state = command(state, 'u1', 'continue');
            continue;
        }

        if (state.phase === 'decider') {
            const decider = state.players.find(p => !p.alive);
            state = command(state, decider.uid, 'decider', { targetUid: state.deciderCandidates[0] });
            continue;
        }

        if (state.phase === 'story') {
            state = command(state, 'u1', 'begin');
            continue;
        }

        throw new Error(`Неожиданная фаза: ${state.phase}`);
    }

    assert.ok(guard < 3000, 'Игра не завершилась за разумное число шагов');
    return state;
}

// ---------------------------------------------------------------------------
//  Тест 1. Полная партия до финала
// ---------------------------------------------------------------------------
{
    const state = makeGame(4, 'nuclear');
    assert.equal(state.players.length, 4);
    assert.equal(state.status, 'playing');
    assert.equal(state.phase, 'story');
    assert.deepEqual(state.voteRounds, computeVotePlan(4, 2).rounds);
    assert.equal(state.voteRounds.length, 2);

    const finished = playGame(state);
    assert.equal(finished.phase, 'ended');
    assert.equal(finished.status, 'ended');
    assert.equal(finished.players.filter(p => p.alive).length, 2);
    assert.ok(finished.ending);
    assert.ok(['good', 'neutral', 'bad'].includes(finished.ending.type));
    assert.equal(finished.final.openedRoomNames.length >= 0, true);
    assert.ok(finished.ending.players.length === 4);
    assert.ok(finished.log.length > 10);
    console.log('✓ Полная партия завершается, финал рассчитывается');
}

// ---------------------------------------------------------------------------
//  Тест 2. Скрытая информация и анонимность голосов
// ---------------------------------------------------------------------------
{
    let state = makeGame(5, 'pandemic');
    const publicBefore = buildPublicState(state);

    for (const player of publicBefore.players) {
        assert.ok(player.values.profession, 'Профессия должна быть открыта');
        assert.ok(player.values.sex, 'Пол должен быть открыт');
        assert.equal(player.values.health, undefined, 'Здоровье не должно утекать до раскрытия');
        assert.equal(player.values.age, undefined, 'Возраст не должен утекать до раскрытия');
    }

    state = command(state, 'u1', 'begin');

    const hand = buildHand(state, state.currentUid);
    assert.ok(hand.player.health, 'В приватной руке должны быть все значения');
    assert.ok(hand.player.actionCard, 'В приватной руке должна быть карта действия');
    assert.ok(hand.player.conditionCard, 'В приватной руке должно быть условие');

    // Доходим до первого голосования, раскрывая карты.
    let guard = 0;
    while (state.phase !== 'vote' && guard++ < 2000) {
        if (state.phase === 'reveal') {
            const player = state.players.find(p => p.uid === state.currentUid);
            const field = REVEALABLE_FIELDS.find(f => !player.revealed[f.key]);
            const value = player[field.key] === CUSTOM_MARKER ? 'Своё значение' : null;
            state = command(state, player.uid, 'reveal', { key: field.key, value });
        } else if (state.phase === 'vote-result') {
            state = command(state, 'u1', 'continue');
        } else if (state.phase === 'story') {
            state = command(state, 'u1', 'begin');
        } else {
            break;
        }
    }

    assert.equal(state.phase, 'vote', 'Должны дойти до голосования');
    const voter = state.currentVoterUid;
    const target = state.players.find(p => p.alive && p.uid !== voter);
    state = command(state, voter, 'vote', { targetUid: target.uid });

    const publicDuringVote = buildPublicState(state);
    assert.ok(!('votes' in publicDuringVote), 'Бюллетени не должны попадать в публичное состояние');
    assert.equal(publicDuringVote.vote.tally.length, 0, 'Талли скрыт до конца голосования');
    assert.equal(publicDuringVote.vote.votedCount, 1, 'Счётчик проголосовавших публичен');

    // Повторный голос тем же игроком невозможен.
    const repeated = applyCommand(state, { uid: voter, type: 'vote', payload: { targetUid: target.uid } }, { members });
    assert.equal(repeated.ok, false, 'Повторный голос должен отклоняться');

    // Нельзя начать игру не-хосту.
    const intrusion = applyCommand(createLobbyState({ code: '654321', hostUid: 'u1' }), {
        uid: 'u2', type: 'start', payload: { scenarioId: 'nuclear', survivors: 2 }
    }, { members });
    assert.equal(intrusion.ok, false, 'Не-хост не может начать игру');

    console.log('✓ Скрытые значения и тайна голосования соблюдаются');
}

// ---------------------------------------------------------------------------
//  Тест 3. Карты действий
// ---------------------------------------------------------------------------
{
    let state = makeGame(4, 'flood');
    state = command(state, 'u1', 'begin');

    // Подглядывание
    let owner = state.players.find(p => p.uid === state.currentUid);
    let target = state.players.find(p => p.uid !== owner.uid && p.alive);
    owner.actionCardId = 'reveal_health';
    owner.actionCardUsed = false;
    target.health = 'Грипп';
    target.revealed.health = false;

    state = command(state, owner.uid, 'action', { targetUid: target.uid });
    assert.equal(state.players.find(p => p.uid === target.uid).revealed.health, true);
    assert.equal(state.players.find(p => p.uid === owner.uid).actionCardUsed, true);

    // Обмен возрастом
    owner = state.players.find(p => p.uid === owner.uid);
    owner.actionCardId = 'swap_age';
    owner.actionCardUsed = false;
    owner.revealed.age = true;
    owner.age = 30;
    const victim = state.players.find(p => p.uid !== owner.uid && p.alive);
    victim.revealed.age = true;
    victim.age = 50;

    state = command(state, owner.uid, 'action', { targetUid: victim.uid });
    assert.equal(state.players.find(p => p.uid === owner.uid).age, 50);
    assert.equal(state.players.find(p => p.uid === victim.uid).age, 30);

    // Кража багажа
    owner = state.players.find(p => p.uid === owner.uid);
    owner.actionCardId = 'steal';
    owner.actionCardUsed = false;
    const rich = state.players.find(p => p.uid !== owner.uid && p.alive);
    rich.luggage1 = 'Армейская аптечка';
    state = command(state, owner.uid, 'action', { targetUid: rich.uid });
    const ownerAfter = state.players.find(p => p.uid === owner.uid);
    assert.ok(ownerAfter.bonusLuggage.includes('Армейская аптечка'));
    assert.equal(state.players.find(p => p.uid === rich.uid).luggage1, '—');

    console.log('✓ Карты подглядывания, обмена и кражи работают');
}

// ---------------------------------------------------------------------------
//  Тест 4. Нормализация данных из Realtime Database
// ---------------------------------------------------------------------------
{
    const state = makeGame(4, 'nuclear');
    const asObjects = {
        ...state,
        players: Object.fromEntries(state.players.map((player, index) => [String(index), player])),
        log: Object.fromEntries(state.log.map((entry, index) => [String(index), entry])),
        voteRounds: { 0: state.voteRounds[0], 1: state.voteRounds[1] }
    };

    const normalized = normalizeState(asObjects);
    assert.ok(Array.isArray(normalized.players));
    assert.equal(normalized.players.length, 4);
    assert.ok(Array.isArray(normalized.log));
    assert.ok(Array.isArray(normalized.voteRounds));
    assert.equal(normalized.voteRounds.length, 2);
    assert.ok(normalized.players.every(p => Array.isArray(p.bonusLuggage)));
    console.log('✓ Нормализация объектов RTDB в массивы работает');
}

// ---------------------------------------------------------------------------
//  Тест 5. Перезапуск
// ---------------------------------------------------------------------------
{
    const finished = playGame(makeGame(4, 'nuclear'));
    const restarted = command(finished, 'u1', 'restart');
    assert.equal(restarted.status, 'lobby');
    assert.equal(restarted.phase, 'lobby');
    assert.equal(restarted.players.length, 0);
    assert.match(restarted.log[0].text, /перезапущена/i);

    const notHost = applyCommand(finished, { uid: 'u2', type: 'restart', payload: {} }, { members });
    assert.equal(notHost.ok, false, 'Не-хост не может перезапустить игру');
    console.log('✓ Перезапуск возвращает комнату в лобби');
}

// ---------------------------------------------------------------------------
//  Тест 6. Пропуск хода и голоса хостом
// ---------------------------------------------------------------------------
{
    let state = makeGame(4, 'nuclear');
    state = command(state, 'u1', 'begin');

    const first = state.currentUid;
    const skipped = applyCommand(state, { uid: 'u2', type: 'skip', payload: {} }, { members });
    assert.equal(skipped.ok, false, 'Не-хост не может пропускать ход');

    state = command(state, 'u1', 'skip');
    assert.notEqual(state.currentUid, first, 'После пропуска ход переходит дальше');
    assert.equal(state.players.find(p => p.uid === first).revealed.orientation, undefined,
        'Пропуск не раскрывает характеристику');

    let guard = 0;
    while (state.phase !== 'vote' && guard++ < 3000) {
        if (state.phase === 'reveal') {
            const player = state.players.find(p => p.uid === state.currentUid);
            const field = REVEALABLE_FIELDS.find(f => !player.revealed[f.key]);
            const value = player[field.key] === CUSTOM_MARKER ? 'Своё значение' : null;
            state = command(state, player.uid, 'reveal', { key: field.key, value });
        } else if (state.phase === 'vote-result') {
            state = command(state, 'u1', 'continue');
        } else if (state.phase === 'story') {
            state = command(state, 'u1', 'begin');
        } else {
            break;
        }
    }

    assert.equal(state.phase, 'vote');
    const beforeVoted = state.voteCursor;
    state = command(state, 'u1', 'skip');
    assert.equal(state.voteCursor, beforeVoted + 1, 'Пропуск голоса сдвигает очередь');
    assert.ok(state.voteOrder.includes(state.currentVoterUid) || state.phase === 'vote-result');
    console.log('✓ Хост может пропустить AFK-ход и AFK-голос');
}

console.log('\nВсе тесты движка пройдены.');
