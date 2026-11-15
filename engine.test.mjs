import assert from 'node:assert/strict';
import {
    createLobbyState,
    startGame,
    applyCommand,
    buildPublicState,
    buildHand,
    normalizeState,
    computeVotePlan,
    parseManualVotePlan,
    canPlayerOpenRoom
} from '../js/game/engine.js';
import {
    REVEALABLE_FIELDS,
    CUSTOM_MARKER,
    SCENARIOS,
    LUGGAGE_POOL,
    AGE_CATEGORIES,
    HEALTH_CATEGORIES,
    POOLS,
    CONDITION_CARDS,
    PROFESSION_GROUPS,
    SKILL_GROUPS
} from '../js/config.js';

function membersFor(count) {
    return Object.fromEntries(Array.from({ length: count }, (_, index) => [
        `u${index + 1}`,
        { name: `Игрок ${index + 1}`, joinedAt: index + 1 }
    ]));
}

function makeGame(count = 4, scenarioId = 'nuclear', settings = {}) {
    const members = membersFor(count);
    let state = createLobbyState({ code: '123456', hostUid: 'u1' });
    const result = startGame(state, members, { scenarioId, survivors: Math.max(1, count - 2), ...settings });
    assert.ok(result.ok, result.error);
    return { state: result.state, members };
}

function command(state, members, uid, type, payload = {}) {
    const result = applyCommand(state, { uid, type, payload }, { members });
    assert.ok(result.ok, `Команда ${type} отклонена: ${result.error}`);
    return result.state;
}

function customValue(player, field) {
    return `Своё ${player.name} ${field.key}`;
}

function playGame(initial, members) {
    let state = command(initial, members, 'u1', 'begin');
    let guard = 0;

    while (state.phase !== 'ended' && guard++ < 3000) {
        if (state.phase === 'reveal') {
            const player = state.players.find(p => p.uid === state.currentUid);
            assert.ok(player, 'Нет текущего игрока в фазе раскрытия');
            const field = REVEALABLE_FIELDS.find(f => !player.revealed[f.key]);
            assert.ok(field, `У игрока ${player.name} не осталось характеристик`);
            const value = player[field.key] === CUSTOM_MARKER ? customValue(player, field) : null;
            state = command(state, members, player.uid, 'reveal', { key: field.key, value });
            continue;
        }

        if (state.phase === 'vote') {
            const alive = state.players.filter(p => p.alive);
            const victim = alive[0].uid;
            const voter = state.currentVoterUid;
            const target = voter === victim ? alive[1].uid : victim;
            state = command(state, members, voter, 'vote', { targetUid: target });
            continue;
        }

        if (state.phase === 'vote-result') {
            state = command(state, members, 'u1', 'continue');
            continue;
        }

        if (state.phase === 'decider') {
            const decider = state.players.find(p => !p.alive);
            state = command(state, members, decider.uid, 'decider', { targetUid: state.deciderCandidates[0] });
            continue;
        }

        if (state.phase === 'story') {
            state = command(state, members, 'u1', 'begin');
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
    const { state, members } = makeGame(4, 'nuclear');
    assert.equal(state.players.length, 4);
    assert.equal(state.status, 'playing');
    assert.equal(state.phase, 'story');
    assert.deepEqual(state.voteRounds, computeVotePlan(4, 2).rounds);
    assert.equal(state.voteRounds.length, 2);

    const finished = playGame(state, members);
    assert.equal(finished.phase, 'ended');
    assert.equal(finished.status, 'ended');
    assert.equal(finished.players.filter(p => p.alive).length, 2);
    assert.ok(finished.ending);
    assert.ok(['good', 'neutral', 'bad'].includes(finished.ending.type));
    assert.equal(finished.ending.players.length, 4);
    assert.ok(finished.log.length > 10);
    assert.ok(finished.log.some(entry => entry.type === 'room'), 'В журнале нет находки комнаты');
    console.log('✓ Полная партия завершается, финал рассчитывается');
}

// ---------------------------------------------------------------------------
//  Тест 2. Скрытая информация и анонимность голосов
// ---------------------------------------------------------------------------
{
    let { state, members } = makeGame(5, 'pandemic');
    const publicBefore = buildPublicState(state);

    for (const player of publicBefore.players) {
        assert.ok(player.values.profession, 'Профессия должна быть открыта');
        assert.ok(player.values.sex, 'Пол должен быть открыт');
        assert.equal(player.values.health, undefined, 'Здоровье не должно утекать до раскрытия');
        assert.equal(player.values.age, undefined, 'Возраст не должен утекать до раскрытия');
    }

    state = command(state, members, 'u1', 'begin');
    const hand = buildHand(state, state.currentUid);
    assert.ok(hand.player.health, 'В приватной руке должны быть все значения');
    assert.ok(hand.player.actionCard, 'В приватной руке должна быть карта действия');
    assert.ok(hand.player.conditionCard, 'В приватной руке должно быть условие');

    let guard = 0;
    while (state.phase !== 'vote' && guard++ < 2000) {
        if (state.phase === 'reveal') {
            const player = state.players.find(p => p.uid === state.currentUid);
            const field = REVEALABLE_FIELDS.find(f => !player.revealed[f.key]);
            const value = player[field.key] === CUSTOM_MARKER ? customValue(player, field) : null;
            state = command(state, members, player.uid, 'reveal', { key: field.key, value });
        } else if (state.phase === 'vote-result') {
            state = command(state, members, 'u1', 'continue');
        } else if (state.phase === 'story') {
            state = command(state, members, 'u1', 'begin');
        } else {
            break;
        }
    }

    assert.equal(state.phase, 'vote', 'Должны дойти до голосования');
    const voter = state.currentVoterUid;
    const target = state.players.find(p => p.alive && p.uid !== voter);
    state = command(state, members, voter, 'vote', { targetUid: target.uid });

    const publicDuringVote = buildPublicState(state);
    assert.ok(!('votes' in publicDuringVote), 'Бюллетени не должны попадать в публичное состояние');
    assert.equal(publicDuringVote.vote.tally.length, 0, 'Талли скрыт до конца голосования');
    assert.equal(publicDuringVote.vote.votedCount, 1, 'Счётчик проголосовавших публичен');

    const repeated = applyCommand(state, { uid: voter, type: 'vote', payload: { targetUid: target.uid } }, { members });
    assert.equal(repeated.ok, false, 'Повторный голос должен отклоняться');

    const intrusion = applyCommand(createLobbyState({ code: '654321', hostUid: 'u1' }), {
        uid: 'u2', type: 'start', payload: { scenarioId: 'nuclear', survivors: 2 }
    }, { members });
    assert.equal(intrusion.ok, false, 'Не-хост не может начать игру');

    console.log('✓ Скрытые значения и тайна голосования соблюдаются');
}

// ---------------------------------------------------------------------------
//  Тест 3. Уникальность характеристик, категории и вероятности
// ---------------------------------------------------------------------------
{
    const { state } = makeGame(15, 'nuclear');

    const singleFields = [
        'profession', 'health', 'age', 'hobby', 'phobia', 'skill', 'character'
    ];
    for (const key of singleFields) {
        const values = state.players.map(p => p[key]).filter(v => v !== CUSTOM_MARKER);
        assert.equal(new Set(values).size, values.length, `Поле ${key} содержит дубликаты`);
        const customCount = state.players.filter(p => p[key] === CUSTOM_MARKER).length;
        assert.ok(customCount <= 1, `Слишком много «Придумай сам» в поле ${key}`);
    }

    for (const [label, keys] of [
        ['багаж', ['luggage1', 'luggage2']],
        ['факты', ['fact1', 'fact2']]
    ]) {
        const values = state.players.flatMap(p => keys.map(key => p[key]))
            .filter(v => v !== CUSTOM_MARKER);
        assert.equal(new Set(values).size, values.length, `Группа «${label}» содержит дубликаты`);
        const customCount = state.players.flatMap(p => keys.map(key => p[key]))
            .filter(v => v === CUSTOM_MARKER).length;
        assert.ok(customCount <= 1, `Слишком много «Придумай сам» в группе «${label}»`);
    }

    for (const player of state.players) {
        assert.ok(player.age >= 10 && player.age <= 100, 'Возраст вне диапазона');
        assert.ok(AGE_CATEGORIES.some(category => player.age >= category.min && player.age <= category.max));
        assert.ok(HEALTH_CATEGORIES.some(category => category.values.includes(player.health)));
        assert.ok(POOLS.orientation.includes(player.orientation));
        assert.ok(POOLS.sex.includes(player.sex));
    }

    // Разные поля не обязаны быть уникальны между собой, но профессии и навыки
    // после гарантии открывателей комнат не должны задваиваться.
    for (const key of ['profession', 'skill']) {
        const values = state.players.map(p => p[key]);
        assert.equal(new Set(values).size, values.length, `Поле ${key} задвоилось после открывателей`);
    }

    const roomNames = new Set(
        SCENARIOS.flatMap(scenario => scenario.rooms.flatMap(room =>
            (room.inventory || []).map(item => item.name)
        ))
    );
    const allLuggage = state.players.flatMap(p => [p.luggage1, p.luggage2])
        .filter(value => value && value !== CUSTOM_MARKER);
    const overlap = allLuggage.filter(item => roomNames.has(item));
    assert.deepEqual(overlap, [], 'Багаж игроков пересекается с инвентарём комнат');
    assert.ok(LUGGAGE_POOL.length >= 30, 'Пул багажа слишком мал для уникальной раздачи');

    for (const player of state.players) {
        assert.ok(player.actionCardId, 'Нет карты действия');
        assert.ok(player.conditionCardId, 'Нет карты условия');
        assert.ok(CONDITION_CARDS.some(card => card.id === player.conditionCardId));
    }
    assert.equal(new Set(state.players.map(p => p.conditionCardId)).size, 15,
        'У игроков должны быть разные карты условий');

    console.log('✓ Все характеристики, кроме пола и ориентации, уникальны; категории корректны');
}

// ---------------------------------------------------------------------------
//  Тест 4. Гарантия открывателей комнат
// ---------------------------------------------------------------------------
{
    for (const scenario of SCENARIOS) {
        for (let attempt = 0; attempt < 40; attempt++) {
            const { state } = makeGame(4, scenario.id);
            for (const room of scenario.rooms.filter(r => r.locked || r.broken)) {
                assert.ok(
                    state.players.some(player => canPlayerOpenRoom(room, player)),
                    `${scenario.id}: комната ${room.id} без открывателя`
                );
            }
            for (const key of ['profession', 'skill']) {
                const values = state.players.map(p => p[key]);
                assert.equal(new Set(values).size, values.length, `${scenario.id}: дубликат ${key}`);
            }
        }
    }
    console.log('✓ В каждой закрытой комнате гарантирован хотя бы один открыватель');
}

// ---------------------------------------------------------------------------
//  Тест 4б. Факты открывают комнаты и напоминание в руке
// ---------------------------------------------------------------------------
{
    const { state } = makeGame(4, 'nuclear');
    const scenario = SCENARIOS.find(item => item.id === 'nuclear');
    const medbay = scenario.rooms.find(room => room.id === 'medbay');
    const vents = scenario.rooms.find(room => room.id === 'vents');
    const player = state.players[0];

    assert.ok(medbay.unlock.facts.length > 0);
    assert.ok(vents.unlock.facts.length > 0);

    player.fact1 = medbay.unlock.facts[0];
    assert.equal(canPlayerOpenRoom(medbay, player), true, 'Факт не открывает медицинский блок');

    let hand = buildHand(state, player.uid);
    let ability = hand.roomAbilities.find(item => item.roomId === 'medbay');
    assert.ok(ability, 'В руке нет напоминания о медицинском блоке');
    assert.equal(ability.action, 'открыть');
    assert.ok(ability.matches.some(match => match.field === 'fact1' && match.value === player.fact1));

    player.fact1 = vents.unlock.facts[0];
    hand = buildHand(state, player.uid);
    ability = hand.roomAbilities.find(item => item.roomId === 'vents');
    assert.ok(ability, 'В руке нет напоминания о вентиляции');
    assert.equal(ability.action, 'починить');

    const publicState = buildPublicState(state);
    const publicMedbay = publicState.rooms.find(room => room.id === 'medbay');
    assert.match(publicMedbay.unlockText, /факты/, 'В описании комнаты нет фактов');
    assert.ok(publicState.scenario.plannedStay, 'В публичном сценарии нет планируемого времени');

    for (const item of SCENARIOS) {
        assert.ok(item.plannedStay, `У сценария ${item.id} нет plannedStay`);
        for (const room of item.rooms.filter(r => r.locked || r.broken)) {
            assert.ok(room.unlock && room.unlock.facts && room.unlock.facts.length > 0,
                `У комнаты ${item.id}/${room.id} нет фактов-открывателей`);
        }
    }

    // Комнаты должны ссылаться на группы, а не на копии списков: тогда
    // правка PROFESSION_GROUPS/SKILL_GROUPS сразу меняет все комнаты.
    const generator = scenario.rooms.find(room => room.id === 'generator');
    const armory = scenario.rooms.find(room => room.id === 'armory');
    assert.equal(generator.unlock.professions, PROFESSION_GROUPS.tech);
    assert.equal(armory.unlock.skills, SKILL_GROUPS.security);

    for (const values of Object.values(PROFESSION_GROUPS)) {
        for (const profession of values) {
            assert.ok(POOLS.profession.includes(profession), `Профессия ${profession} отсутствует в пуле`);
        }
    }
    for (const values of Object.values(SKILL_GROUPS)) {
        for (const skill of values) {
            assert.ok(POOLS.skill.includes(skill), `Навык ${skill} отсутствует в пуле`);
        }
    }

    console.log('✓ Факты открывают комнаты, а в карточке есть напоминание');
}

// ---------------------------------------------------------------------------
//  Тест 5. Взвешенные категории
// ---------------------------------------------------------------------------
{
    const { state } = makeGame(4, 'nuclear', {
        generation: {
            ageWeights: [0, 100, 0, 0],
            healthWeights: [100, 0, 0],
            orientationWeights: [0, 0, 0, 0, 100]
        }
    });

    for (const player of state.players) {
        assert.ok(player.age >= 21 && player.age <= 50, `Возраст ${player.age} вне 21–50`);
        assert.ok(HEALTH_CATEGORIES[0].values.includes(player.health), 'Здоровье не из хорошей категории');
        assert.equal(player.orientation, POOLS.orientation[4]);
    }
    console.log('✓ Веса категорий возраста, здоровья и ориентации применяются');
}

// ---------------------------------------------------------------------------
//  Тест 6. Ручной план голосований
// ---------------------------------------------------------------------------
{
    const manual = makeGame(4, 'nuclear', {
        survivors: 2,
        voteMode: 'manual',
        voteRounds: [1, 3],
        voteQuotas: { 1: 1, 3: 1 }
    });
    assert.deepEqual(manual.state.voteRounds, [1, 3]);
    assert.deepEqual(manual.state.voteQuotas, { 1: 1, 3: 1 });
    assert.equal(manual.state.settings.voteMode, 'manual');

    const invalid = startGame(
        createLobbyState({ code: '123456', hostUid: 'u1' }),
        membersFor(4),
        { scenarioId: 'nuclear', survivors: 2, voteMode: 'manual', voteRounds: [1], voteQuotas: { 1: 1 } }
    );
    assert.equal(invalid.ok, false);
    assert.match(invalid.error, /нужно 2/);

    const filtered = parseManualVotePlan('12, 1, 1, 3', { 1: 1, 3: 2 }, 4, 2);
    assert.ok(filtered.ok);
    assert.deepEqual(filtered.plan.rounds, [1, 3]);
    assert.equal(filtered.plan.quotas[3], 2);

    const finished = playGame(manual.state, manual.members);
    assert.equal(finished.phase, 'ended');
    assert.equal(finished.players.filter(p => p.alive).length, 2);
    console.log('✓ Ручной план голосований работает и валидируется');
}

// ---------------------------------------------------------------------------
//  Тест 7. Мгновенные карты условий
// ---------------------------------------------------------------------------
{
    let { state, members } = makeGame(4, 'nuclear');
    const target = state.players[1];
    target.conditionCardId = 'age_surge';
    state.players.forEach((player, index) => { player.age = [20, 30, 40, 50][index]; });

    state.phase = 'vote-result';
    state.votes = { [target.uid]: 1 };
    state.voteElimsRemaining = 1;
    state.voteQuotaTotal = 1;

    state = command(state, members, 'u1', 'continue');
    const eliminated = state.players.find(p => p.uid === target.uid);
    assert.equal(eliminated.alive, false);
    assert.equal(eliminated.conditionCardTriggered, true);
    assert.deepEqual(state.players.map(p => p.age), [25, 35, 45, 55]);
    assert.equal(new Set(state.players.map(p => p.age)).size, 4);
    assert.ok(state.log.some(entry => entry.type === 'condition'), 'Нет уведомления о мгновенном условии');

    let shuffleState = makeGame(4, 'nuclear').state;
    const shuffleMembers = membersFor(4);
    const shuffleTarget = shuffleState.players[1];
    shuffleTarget.conditionCardId = 'shuffle_hobby';
    const hobbies = ['Садоводство', 'Рыбалка', 'Шахматы', 'Йога'];
    shuffleState.players.forEach((player, index) => {
        player.hobby = hobbies[index];
        player.revealed.hobby = true;
    });
    shuffleState.phase = 'vote-result';
    shuffleState.votes = { [shuffleTarget.uid]: 1 };
    shuffleState.voteElimsRemaining = 1;
    shuffleState.voteQuotaTotal = 1;

    shuffleState = command(shuffleState, shuffleMembers, 'u1', 'continue');
    const afterHobbies = shuffleState.players.map(p => p.hobby);
    assert.deepEqual([...afterHobbies].sort(), [...hobbies].sort());
    assert.ok(shuffleState.players.every(p => p.revealed.hobby));
    assert.equal(shuffleState.players.find(p => p.uid === shuffleTarget.uid).conditionCardTriggered, true);

    console.log('✓ Мгновенные условия сдвигают возраст и перемешивают открытые характеристики');
}

// ---------------------------------------------------------------------------
//  Тест 8. Уникальность «Придумай сам»
// ---------------------------------------------------------------------------
{
    let { state, members } = makeGame(4, 'nuclear');
    state.phase = 'reveal';
    state.currentUid = 'u1';
    const player = state.players[0];
    const other = state.players[1];
    player.character = CUSTOM_MARKER;
    player.revealed.character = false;
    player.acted = false;
    other.character = 'Уникальный характер';

    const duplicate = applyCommand(state, {
        uid: 'u1', type: 'reveal', payload: { key: 'character', value: 'Уникальный характер' }
    }, { members });
    assert.equal(duplicate.ok, false);
    assert.match(duplicate.error, /уникальны/);

    const unique = applyCommand(state, {
        uid: 'u1', type: 'reveal', payload: { key: 'character', value: 'Совершенно другой характер' }
    }, { members });
    assert.ok(unique.ok, unique.error);
    assert.equal(unique.state.players.find(p => p.uid === 'u1').character, 'Совершенно другой характер');

    console.log('✓ «Придумай сам» не даёт создать дубликат');
}

// ---------------------------------------------------------------------------
//  Тест 9. Карты действий
// ---------------------------------------------------------------------------
{
    let { state, members } = makeGame(4, 'flood');
    state = command(state, members, 'u1', 'begin');

    let owner = state.players.find(p => p.uid === state.currentUid);
    let target = state.players.find(p => p.uid !== owner.uid && p.alive);
    owner.actionCardId = 'reveal_health';
    owner.actionCardUsed = false;
    target.health = 'Грипп';
    target.revealed.health = false;

    state = command(state, members, owner.uid, 'action', { targetUid: target.uid });
    assert.equal(state.players.find(p => p.uid === target.uid).revealed.health, true);

    owner = state.players.find(p => p.uid === owner.uid);
    owner.actionCardId = 'swap_age';
    owner.actionCardUsed = false;
    owner.revealed.age = true;
    owner.age = 30;
    const victim = state.players.find(p => p.uid !== owner.uid && p.alive);
    victim.revealed.age = true;
    victim.age = 50;

    state = command(state, members, owner.uid, 'action', { targetUid: victim.uid });
    assert.equal(state.players.find(p => p.uid === owner.uid).age, 50);
    assert.equal(state.players.find(p => p.uid === victim.uid).age, 30);

    owner = state.players.find(p => p.uid === owner.uid);
    owner.actionCardId = 'steal';
    owner.actionCardUsed = false;
    const rich = state.players.find(p => p.uid !== owner.uid && p.alive);
    rich.luggage1 = 'Армейская аптечка';
    state = command(state, members, owner.uid, 'action', { targetUid: rich.uid });
    assert.ok(state.players.find(p => p.uid === owner.uid).bonusLuggage.includes('Армейская аптечка'));
    assert.equal(state.players.find(p => p.uid === rich.uid).luggage1, '—');

    console.log('✓ Карты подглядывания, обмена и кражи работают');
}

// ---------------------------------------------------------------------------
//  Тест 10. Нормализация данных из Realtime Database
// ---------------------------------------------------------------------------
{
    const { state } = makeGame(4, 'nuclear');
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
//  Тест 11. Перезапуск и пропуск AFK
// ---------------------------------------------------------------------------
{
    const { state, members } = makeGame(4, 'nuclear');
    const finished = playGame(state, members);
    const restarted = command(finished, members, 'u1', 'restart');
    assert.equal(restarted.status, 'lobby');
    assert.equal(restarted.phase, 'lobby');
    assert.equal(restarted.players.length, 0);

    const notHost = applyCommand(finished, { uid: 'u2', type: 'restart', payload: {} }, { members });
    assert.equal(notHost.ok, false, 'Не-хост не может перезапустить игру');

    let skipState = makeGame(4, 'nuclear').state;
    skipState = command(skipState, members, 'u1', 'begin');
    const first = skipState.currentUid;
    const notHostSkip = applyCommand(skipState, { uid: 'u2', type: 'skip', payload: {} }, { members });
    assert.equal(notHostSkip.ok, false, 'Не-хост не может пропускать ход');
    skipState = command(skipState, members, 'u1', 'skip');
    assert.notEqual(skipState.currentUid, first, 'После пропуска ход переходит дальше');
    assert.equal(skipState.players.find(p => p.uid === first).revealed.orientation, undefined);

    console.log('✓ Перезапуск и пропуск AFK-хода работают');
}

console.log('\nВсе тесты движка пройдены.');
