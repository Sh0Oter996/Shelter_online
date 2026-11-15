'use strict';

import { FIELDS, REVEALABLE_FIELDS, RESOURCE_META, CUSTOM_MARKER } from '../config.js';
import {
    $, escapeHtml, openModal, closeModal, toast, phaseLabel, isOnline, isStale
} from './dom.js';
import { signed, toArray } from '../utils.js';

let appRef = null;

// ---------------------------------------------------------------------------
//  Инициализация обработчиков
// ---------------------------------------------------------------------------

export function initGameUI(app) {
    appRef = app;

    $('playersBtn').addEventListener('click', () => {
        renderPlayersModal(appRef);
        openModal('playersModal');
    });
    $('logBtn').addEventListener('click', () => {
        renderLog(appRef);
        openModal('logModal');
    });
    $('storyBtn').addEventListener('click', () => {
        renderStoryModal(appRef);
        openModal('storyModal');
    });
    $('leaveGameBtn').addEventListener('click', () => {
        if (confirm('Выйти из комнаты? Партия продолжится без вас; вернуться можно по ссылке-приглашению.')) {
            appRef.leaveRoom();
        }
    });

    $('hostRestartBtn').addEventListener('click', () => {
        openModal('restartModal');
    });

    $('gamePanels').addEventListener('click', event => handlePanelClick(event, appRef));

    $('applyActionBtn').addEventListener('click', () => applyActionCard(appRef));
    $('cancelActionBtn').addEventListener('click', () => closeModal('actionModal'));

    $('confirmRestartBtn').addEventListener('click', () => {
        closeModal('restartModal');
        send(appRef, 'restart', {});
    });
    $('cancelRestartBtn').addEventListener('click', () => closeModal('restartModal'));
}

function send(app, type, payload = {}) {
    if (!app || !app.sendCommand) return Promise.resolve();
    return app.sendCommand(type, payload).catch(error => {
        toast(error.message || 'Не удалось отправить действие.', 'error');
    });
}

// ---------------------------------------------------------------------------
//  Основной рендер
// ---------------------------------------------------------------------------

export function renderGame(app) {
    appRef = app;
    if (!app.meta) return;

    $('gameCode').textContent = app.code;
    $('gameRound').textContent = app.state && app.state.status === 'playing'
        ? `Раунд ${app.state.round}`
        : '';
    const phase = app.state ? app.state.phase : 'story';
    const badge = $('gamePhase');
    badge.textContent = phaseLabel(phase);
    badge.className = `phase-badge phase-${phase}`;

    const isHost = app.meta.hostUid === app.uid;
    $('hostRestartBtn').hidden = !isHost || !app.state ||
        app.state.status === 'ended' || app.state.phase === 'ended';

    renderBunkerBar(app);
    renderHostBanner(app);
    renderGameNotifications(app);

    const panels = $('gamePanels');
    if (!app.state) {
        panels.innerHTML = `<div class="card loading-card"><div class="spinner"></div><p>Синхронизируем состояние партии…</p></div>`;
        return;
    }

    panels.innerHTML = buildPanels(app);

    if ($('playersModal').classList.contains('open')) renderPlayersModal(app);
    if ($('logModal').classList.contains('open')) renderLog(app);
    if ($('storyModal').classList.contains('open')) renderStoryModal(app);
}

function renderBunkerBar(app) {
    const state = app.state;
    const scenario = state && state.scenario;
    $('gameScenarioTitle').textContent = scenario ? scenario.title : '—';
    $('gameBunkerMeta').textContent = scenario
        ? `${scenario.bunkerSize}${scenario.plannedStay ? ` · Планируемое время: ${scenario.plannedStay}` : ''}`
        : '';
    $('gameResources').innerHTML = scenario
        ? resourceChips(state.baseResources, state.baseStability)
        : '';
}

function renderHostBanner(app) {
    const banner = $('hostOfflineBanner');
    const state = app.state;
    const isHost = app.meta && app.meta.hostUid === app.uid;
    if (!state || isHost || state.phase === 'ended') {
        banner.hidden = true;
        return;
    }
    const hostPresence = app.presence && app.presence[app.meta.hostUid];
    const online = isOnline(hostPresence);
    banner.hidden = online;
}

function renderGameNotifications(app) {
    const box = $('gameNotifications');
    const state = app.state;
    if (!state) {
        box.hidden = true;
        box.innerHTML = '';
        return;
    }

    const entries = toArray(state.log)
        .filter(entry => entry.type === 'room' || entry.type === 'condition')
        .slice(-4);

    if (entries.length === 0) {
        box.hidden = true;
        box.innerHTML = '';
        return;
    }

    box.hidden = false;
    box.innerHTML = entries.map(entry => {
        const isRoom = entry.type === 'room';
        const text = String(entry.text || '').replace(/^[🔍🎴]\s*/u, '');
        return `<div class="game-notification ${isRoom ? 'notification-room' : 'notification-condition'}">
            <span class="notification-icon">${isRoom ? '🔍' : '🎴'}</span>
            <span class="notification-text">${escapeHtml(text)}</span>
        </div>`;
    }).join('');
}

function resourceChips(resources, stability) {
    const parts = Object.keys(RESOURCE_META).map(key => {
        const meta = RESOURCE_META[key];
        const value = Number((resources || {})[key]) || 0;
        return `<span class="resource-chip ${value <= 1 ? 'low' : ''}">${meta.icon} ${meta.label}: <b>${value}</b></span>`;
    });
    parts.push(`<span class="resource-chip ${Number(stability) < 0 ? 'low' : ''}">🧠 Стабильность: <b>${signed(Number(stability) || 0)}</b></span>`);
    return parts.join('');
}

// ---------------------------------------------------------------------------
//  Панели по фазам
// ---------------------------------------------------------------------------

function buildPanels(app) {
    const state = app.state;

    if (state.status === 'lobby' || state.phase === 'lobby') {
        return `<div class="card loading-card"><div class="spinner"></div><p>Хост начинает партию…</p></div>`;
    }

    if (state.status === 'ended' || state.phase === 'ended') {
        return endingPanel(app) + playersStrip(app);
    }

    if (state.phase === 'story') {
        return storyPanel(app) + playersStrip(app);
    }

    if (state.phase === 'reveal') {
        return revealStatusPanel(app) + ownCardPanel(app) + playersStrip(app);
    }

    if (state.phase === 'vote') {
        return votePanel(app) + ownCardPanel(app, true) + playersStrip(app);
    }

    if (state.phase === 'vote-result') {
        return voteResultsPanel(app) + playersStrip(app);
    }

    if (state.phase === 'decider') {
        return deciderPanel(app) + ownCardPanel(app, true) + playersStrip(app);
    }

    return `<div class="card"><p>Неизвестная фаза: ${escapeHtml(state.phase)}</p></div>`;
}

function playersStrip(app) {
    const state = app.state;
    if (!state) return '';
    const players = toArray(state.players);
    const chips = players.map(player => {
        const mine = player.uid === app.uid;
        const online = isOnline(app.presence && app.presence[player.uid]) || mine;
        const turn = state.currentUid === player.uid || state.vote.currentVoterUid === player.uid;
        const classes = [
            'player-chip',
            player.alive ? 'alive' : 'eliminated',
            mine ? 'me' : '',
            turn ? 'turn' : '',
            online ? '' : 'offline'
        ].filter(Boolean).join(' ');
        return `<span class="${classes}">
            <span class="online-dot ${online ? 'on' : 'off'}"></span>
            ${player.alive ? '🟢' : '🔴'}
            <b>${escapeHtml(player.name)}</b>
            ${player.isHost ? '<span class="crown" title="хост">👑</span>' : ''}
            ${mine ? '<span class="badge me">вы</span>' : ''}
        </span>`;
    }).join('');

    return `<div class="card players-strip">
        <div class="players-strip-head">
            <h3>Игроки</h3>
            <span class="muted">В бункере: ${state.aliveCount} из ${players.length} · выжить должно: ${state.survivorsTarget}</span>
        </div>
        <div class="player-chips">${chips}</div>
    </div>`;
}

// ---------------------------------------------------------------------------
//  История
// ---------------------------------------------------------------------------

function storyPanel(app) {
    const state = app.state;
    const scenario = state.scenario;
    if (!scenario) return '';
    const isHost = app.meta.hostUid === app.uid;

    return `<div class="card story-start">
        <h2>${escapeHtml(scenario.title)}</h2>
        <p class="story-desc">${escapeHtml(scenario.apocalypse)}</p>
        <p>${escapeHtml(scenario.bunkerDesc)}</p>
        <p class="story-meta">${escapeHtml(scenario.bunkerSize)}</p>
        ${scenario.plannedStay ? `<p class="planned-stay">🕰️ Планируемое время в бункере: <b>${escapeHtml(scenario.plannedStay)}</b></p>` : ''}
        <p><b>Стартовые параметры бункера:</b></p>
        <div class="resources-bar">${resourceChips(state.baseResources, state.baseStability)}</div>
        <p class="hint">Все игроки изучают историю. Полное описание комнат — в кнопке «🏠 Бункер».</p>
        ${isHost
            ? `<button data-action="begin">Войти в бункер и начать раунд 1</button>`
            : `<p class="waiting-note">Ждём, пока хост начнёт раунд.</p>`}
    </div>`;
}

// ---------------------------------------------------------------------------
//  Карточка игрока
// ---------------------------------------------------------------------------

function displayValue(field, values) {
    const raw = values ? values[field.key] : undefined;
    if (raw === CUSTOM_MARKER) return '✏️ Придумай сам';
    if (raw == null || raw === '') return '—';
    if (field.key === 'age') return `${raw} лет`;
    return String(raw);
}

function ownCardPanel(app, compact = false) {
    const state = app.state;
    const hand = app.hand;
    if (!hand || !hand.player) {
        const inGame = toArray(state.players).some(p => p.uid === app.uid);
        if (!inGame) {
            const isHost = app.meta.hostUid === app.uid;
            return `<div class="card spectator-card">
                <h3>Вы в комнате, но не в этой партии</h3>
                <p>Игра началась, когда вас ещё не было в списке участников. Карточки и хода у вас нет.</p>
                ${isHost
                    ? `<button type="button" data-action="restart">Перезапустить партию</button>`
                    : '<p class="waiting-note">Попросите хоста перезапустить партию.</p>'}
            </div>`;
        }
        return `<div class="card"><p class="hint">Загружаем вашу карточку…</p></div>`;
    }

    const player = hand.player;
    const myTurn = !!hand.isMyTurn;
    const alive = !!player.alive;
    const isHost = app.meta.hostUid === app.uid;

    const profession = player.profession === CUSTOM_MARKER
        ? displayValue({ key: 'profession' }, player)
        : player.profession;
    const sex = player.sex;

    const traits = REVEALABLE_FIELDS.map(field => {
        const revealed = !!player.revealed[field.key];
        const value = displayValue(field, player);
        const canReveal = myTurn && alive && !revealed;

        if (canReveal) {
            return `<button type="button" class="trait trait-button ${player[field.key] === CUSTOM_MARKER ? 'custom' : ''}"
                data-action="reveal" data-key="${field.key}">
                <span class="label">${escapeHtml(field.label)} · раскрыть</span>
                <span class="value">${escapeHtml(value)}</span>
            </button>`;
        }

        return `<div class="trait ${revealed ? 'revealed' : 'unrevealed'}">
            <span class="label">${escapeHtml(field.label)}${revealed ? '' : ' · скрыто от других'}</span>
            <span class="value">${escapeHtml(value)}</span>
        </div>`;
    }).join('');

    const actionCard = player.actionCard;
    let actionBlock = '';
    if (actionCard) {
        actionBlock = `<div class="secret-card action-card">
            <div class="secret-card-title">🃏 Секретная карта действия</div>
            <div class="secret-card-name">${escapeHtml(actionCard.icon || '')} ${escapeHtml(actionCard.name)}</div>
            <div class="secret-card-desc">${escapeHtml(actionCard.desc)}</div>
            ${player.actionCardUsed
                ? '<div class="secret-card-state used">Карта использована</div>'
                : (myTurn && alive
                    ? `<button type="button" class="card-btn" data-action="open-action">Активировать карту</button>`
                    : '<div class="secret-card-state">Можно активировать только в свой ход.</div>')}
        </div>`;
    }

    const conditionCard = player.conditionCard;
    let conditionBlock = '';
    if (conditionCard) {
        const hint = conditionCard.trigger === 'entry'
            ? 'Сработает в финале, если вы пройдёте в бункер.'
            : conditionCard.trigger === 'immediate'
                ? 'Сработает сразу после вашего изгнания.'
                : 'Сработает в финале, если вас изгонят.';
        conditionBlock = `<div class="secret-card condition-card">
            <div class="secret-card-title">🎴 Секретное условие</div>
            <div class="secret-card-name">${escapeHtml(conditionCard.name)}</div>
            <div class="secret-card-desc">${escapeHtml(conditionCard.desc)}</div>
            <div class="secret-card-state">⏳ ${hint}</div>
        </div>`;
    }

    const bonus = player.bonusLuggage && toArray(player.bonusLuggage).length
        ? `<div class="bonus-luggage">🎒 Бонусный багаж: <b>${toArray(player.bonusLuggage).map(escapeHtml).join(', ')}</b></div>`
        : '';

    const abilities = toArray(hand.roomAbilities);
    const abilityBlock = abilities.length
        ? `<div class="room-ability-note">
            <div class="room-ability-title">🚪 Вы можете помочь бункеру</div>
            <p>Если вы пройдёте в бункер, у вас будет доступ к этим комнатам:</p>
            <ul>${abilities.map(ability => {
                const matches = toArray(ability.matches)
                    .map(match => `${escapeHtml(match.label)} «${escapeHtml(match.value)}»`)
                    .join(', ');
                return `<li>${ability.action === 'починить' ? '🔧 починить' : '🔓 открыть'} «${escapeHtml(ability.roomName)}» — ${matches}</li>`;
            }).join('')}</ul>
            <p class="hint">Это напоминание видите только вы.</p>
           </div>`
        : '';

    const statusHint = !alive
        ? `<p class="hint">Вы изгнаны и наблюдаете за партией.</p>`
        : myTurn
            ? `<p class="hint strong-hint">Ваш ход: нажмите на одну характеристику, чтобы раскрыть её для всех.</p>`
            : `<p class="hint">Свои значения видите только вы. Сейчас ${state.currentName ? `ходит <b>${escapeHtml(state.currentName)}</b>` : 'идёт голосование'}.</p>`;

    return `<div class="card own-card ${compact ? 'compact' : ''}">
        <div class="own-card-head">
            <h2>Ваша карточка: <span class="player-tag">${escapeHtml(player.name)}</span></h2>
            <span class="badge ${alive ? 'alive-badge' : 'dead-badge'}">${alive ? 'в игре' : 'изгнан(а)'}</span>
        </div>
        <div class="base-traits">
            <div class="trait revealed"><span class="label">Профессия (открыта всем)</span><span class="value">${escapeHtml(profession)}</span></div>
            <div class="trait revealed"><span class="label">Пол (открыт всем)</span><span class="value">${escapeHtml(sex)}</span></div>
        </div>
        ${statusHint}
        ${actionBlock}
        ${conditionBlock}
        ${bonus}
        ${abilityBlock}
        <div class="traits-grid">${traits}</div>
        ${isHost ? `<p class="host-note">👑 Вы хост: только вы можете начинать раунды, продолжать после голосований и перезапускать игру. Держите вкладку открытой.</p>` : ''}
    </div>`;
}

// ---------------------------------------------------------------------------
//  Раскрытие
// ---------------------------------------------------------------------------

function revealStatusPanel(app) {
    const state = app.state;
    const hand = app.hand;
    const me = hand && hand.player;
    const isHost = app.meta.hostUid === app.uid;

    if (hand && hand.isMyTurn) {
        return `<div class="card turn-card my-turn">
            <div class="turn-icon">🎯</div>
            <div>
                <h2>Ваш ход</h2>
                <p>Раскройте одну характеристику в своей карточке. Выбор нельзя отменить. Можно сначала использовать карту действия.</p>
                <p class="hint">Профессия и пол уже открыты всем.</p>
            </div>
        </div>`;
    }

    if (!me || !me.alive) {
        return `<div class="card waiting-card">
            <h3>Вы наблюдаете</h3>
            <p>Ждём, пока живые игроки закончат раскрытие.</p>
            ${isHost ? hostNote() : ''}
        </div>`;
    }

    const current = state.players.find(p => p.uid === state.currentUid);
    const canSkip = isHost && current && current.uid !== app.uid &&
        isStale(app.presence && app.presence[current.uid]);

    return `<div class="card waiting-card">
        <h3>Сейчас ход: <span class="player-tag">${escapeHtml(state.currentName || '…')}</span></h3>
        <p>Игрок раскрывает одну характеристику. Как только он закончит, ход перейдёт дальше автоматически.</p>
        <div class="thinking-dots"><span></span><span></span><span></span></div>
        ${canSkip
            ? `<button type="button" class="skip-btn" data-action="skip">Пропустить ход «${escapeHtml(current.name)}»</button>
               <p class="hint">Игрок давно не выходит на связь. Пропуск не раскрывает его характеристики.</p>`
            : ''}
        ${isHost ? hostNote() : ''}
    </div>`;
}

function hostNote() {
    return `<p class="host-note">👑 Вы хост: держите вкладку открытой. Ход перейдёт дальше автоматически.</p>`;
}

// ---------------------------------------------------------------------------
//  Голосование
// ---------------------------------------------------------------------------

function votePanel(app) {
    const state = app.state;
    const vote = state.vote;
    const hand = app.hand;
    const me = hand && hand.player;
    const isHost = app.meta.hostUid === app.uid;
    const voter = state.players.find(p => p.uid === vote.currentVoterUid);
    const progress = `${vote.votedCount} / ${vote.voterCount}`;
    const canSkip = isHost && voter && voter.uid !== app.uid &&
        isStale(app.presence && app.presence[voter.uid]);

    const quota = `<p class="vote-quota">В этом раунде изгоняем: <b>${vote.quotaTotal}</b> · голосование <b>${vote.step}</b> из <b>${vote.quotaTotal}</b>${vote.isTiebreak ? ' · <b>переголосование среди лидеров</b>' : ''}</p>`;

    if (hand && hand.isMyVote) {
        let targets = state.players.filter(p => p.alive && p.uid !== app.uid);
        if (vote.isTiebreak) {
            targets = targets.filter(p => toArray(vote.candidateUids).includes(p.uid));
        }

        const buttons = targets.map(target =>
            `<button type="button" class="vote-btn" data-action="vote" data-target="${escapeHtml(target.uid)}">${escapeHtml(target.name)}</button>`
        ).join('');

        return `<div class="card vote-panel my-vote">
            <h2>Голосование — раунд ${state.round}</h2>
            ${quota}
            <p class="vote-last-result">${escapeHtml(vote.lastOutcome || '')}</p>
            <p>Ваш голос <b>анонимен</b>. Выберите, кого изгнать. Голос нельзя изменить.</p>
            <div class="vote-buttons">${buttons || '<i>Нет доступных кандидатов.</i>'}</div>
            <p class="vote-private-note">${vote.isTiebreak ? 'Переголосование: можно выбрать только лидеров.' : 'Никто не увидит, за кого вы проголосовали.'}</p>
        </div>`;
    }

    return `<div class="card vote-panel">
        <h2>Голосование — раунд ${state.round}</h2>
        ${quota}
        <p class="vote-last-result">${escapeHtml(vote.lastOutcome || '')}</p>
        ${voter
            ? `<p>Голосует: <span class="player-tag">${escapeHtml(voter.name)}</span></p>`
            : '<p>Голосование завершается…</p>'}
        <div class="vote-progress">
            Проголосовало: <b>${progress}</b>
        </div>
        <div class="progress-bar"><span style="width:${vote.voterCount ? Math.round((vote.votedCount / vote.voterCount) * 100) : 0}%"></span></div>
        <p class="hint">Голоса анонимны. Результаты появятся, когда проголосуют все.</p>
        ${!me || !me.alive ? '<p class="hint">Вы выбыли и наблюдаете за голосованием.</p>' : ''}
        ${canSkip
            ? `<button type="button" class="skip-btn" data-action="skip">Пропустить голос «${escapeHtml(voter.name)}»</button>
               <p class="hint">Игрок давно не выходит на связь. Его голос не будет учтён.</p>`
            : ''}
        ${isHost ? hostNote() : ''}
    </div>`;
}

function voteResultsPanel(app) {
    const state = app.state;
    const vote = state.vote;
    const isHost = app.meta.hostUid === app.uid;
    const tally = toArray(vote.tally);

    const rows = tally.length
        ? tally.map(entry => `<div class="tally-row">
                <span>${escapeHtml(entry.name)}</span>
                <span class="tally-count">${Number(entry.count) || 0} голос(ов)</span>
            </div>`).join('')
        : '<p><i>Никто не голосовал.</i></p>';

    return `<div class="card vote-results">
        <h2>Результаты голосования — раунд ${state.round}</h2>
        <p class="vote-quota">Нужно изгнать: <b>${vote.quotaTotal}</b> · уже изгнано: <b>${vote.quotaTotal - vote.elimsRemaining}</b>${vote.isTiebreak ? ' · переголосование' : ''}</p>
        <div class="tally-list">${rows}</div>
        <p class="vote-last-result">${escapeHtml(vote.lastOutcome || '')}</p>
        ${isHost
            ? `<button type="button" data-action="continue">Продолжить</button>`
            : '<p class="waiting-note">Ждём, пока хост продолжит игру.</p>'}
    </div>`;
}

function deciderPanel(app) {
    const state = app.state;
    const hand = app.hand;
    const vote = state.vote;
    const candidates = toArray(vote.deciderCandidateUids)
        .map(uid => state.players.find(p => p.uid === uid))
        .filter(Boolean);
    const eliminated = state.players.filter(p => !p.alive);

    const buttons = candidates.map(candidate =>
        `<button type="button" class="decider-btn" data-action="decider" data-target="${escapeHtml(candidate.uid)}">${escapeHtml(candidate.name)}</button>`
    ).join('');

    return `<div class="card decider-panel">
        <h2>🗳️ Решающий голос выбывших</h2>
        <p>Голоса разделились. Все выбывшие игроки совещаются и отдают <b>один общий голос</b>.</p>
        <p><b>Выбывшие:</b> ${eliminated.map(p => `<span class="player-tag">${escapeHtml(p.name)}</span>`).join(', ') || 'никого'}</p>
        <p><b>Кандидаты:</b> ${candidates.map(p => `<span class="player-tag">${escapeHtml(p.name)}</span>`).join(', ')}</p>
        ${hand && hand.isDecider
            ? `<div class="vote-buttons">${buttons}</div>
               <p class="vote-private-note">Совещайтесь вместе. Засчитается первый нажатый голос.</p>`
            : `<p class="waiting-note">Ждём решения выбывших игроков.</p>`}
    </div>`;
}

// ---------------------------------------------------------------------------
//  Финал
// ---------------------------------------------------------------------------

function sumEffects(effects) {
    return Object.values(effects || {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
}

function effectsText(effects) {
    const parts = [];
    Object.keys(RESOURCE_META).forEach(key => {
        const value = Number((effects || {})[key]) || 0;
        if (value) parts.push(`${signed(value)} ${RESOURCE_META[key].icon}`);
    });
    const stability = Number((effects || {}).stability) || 0;
    if (stability) parts.push(`${signed(stability)} 🧠`);
    return parts.join(', ') || '—';
}

function effectEntriesHtml(entries, sign) {
    const filtered = toArray(entries).filter(entry => {
        const score = sumEffects(entry.effects);
        return sign > 0 ? score > 0 : sign < 0 ? score < 0 : score === 0;
    });
    if (!filtered.length) return '<i>Нет.</i>';

    return filtered.map(entry => {
        const title = `${entry.source || ''}${entry.fieldLabel ? ` · ${entry.fieldLabel}` : ''}: ${entry.label || ''}`;
        const luggage = entry.luggage ? ` (+ багаж «${entry.luggage}»)` : '';
        const cls = sumEffects(entry.effects) > 0 ? 'positive' : sumEffects(entry.effects) < 0 ? 'negative' : 'neutral';
        return `<div class="effect-entry ${cls}">
            <span class="effect-title">${escapeHtml(title)}</span>
            <span class="effect-values">${escapeHtml(effectsText(entry.effects))}${escapeHtml(luggage)}</span>
        </div>`;
    }).join('');
}

function endingPanel(app) {
    const state = app.state;
    const ending = state.ending;
    if (!ending) {
        return `<div class="card"><p class="hint">Считаем итоги…</p></div>`;
    }

    const table = ending.table || {};
    const base = table.base || {};
    const finalResources = table.resources || {};

    const tableRows = Object.keys(RESOURCE_META).map(key => {
        const meta = RESOURCE_META[key];
        const before = Number(base[key]) || 0;
        const after = Number(finalResources[key]) || 0;
        const delta = after - before;
        return `<tr>
            <td>${meta.icon} ${meta.label}</td>
            <td>${before}</td>
            <td><b>${after}</b></td>
            <td class="${delta > 0 ? 'plus' : delta < 0 ? 'minus' : ''}">${signed(delta)}</td>
        </tr>`;
    }).join('');

    const stabilityBefore = Number(table.baseStability) || 0;
    const stabilityAfter = Number(table.stability) || 0;
    const stabilityDelta = stabilityAfter - stabilityBefore;

    const playersHtml = toArray(ending.players).map(player => {
        const fields = toArray(player.fields).map(field =>
            field.revealed
                ? `• ${escapeHtml(field.label)}: <b>${escapeHtml(field.value)}</b>`
                : `<span class="hidden-trait">• ${escapeHtml(field.label)}: ${escapeHtml(field.value)}</span>`
        ).join('<br>');

        return `<div class="final-player ${player.alive ? 'survivor' : 'eliminated'}">
            <b class="player-tag">${escapeHtml(player.name)}</b>${player.alive ? ' 🟢 прошёл в бункер' : ' 🔴 изгнан'}:<br>
            ${fields}
            <span class="final-extra">🃏 Карта: ${escapeHtml(player.actionText)} · 🎴 Условие: ${escapeHtml(player.conditionText)} · 🎒 Бонус: ${escapeHtml(player.bonusText)}</span>
        </div>`;
    }).join('');

    const isHost = app.meta.hostUid === app.uid;

    return `<div class="end-game-panel ${escapeHtml(ending.type)}">
        <h2>🏆 ${escapeHtml(ending.title)}</h2>
        <div class="ending-block ${escapeHtml(ending.type)}">
            <p>${escapeHtml(ending.text)}</p>
            <p><b>Сценарий:</b> ${escapeHtml(ending.scenarioTitle || '')}</p>
            <p><b>Прошли в бункер:</b> ${toArray(ending.survivors).map(escapeHtml).join(', ') || 'никто'}</p>
            <p><b>Изгнаны:</b> ${toArray(ending.eliminated).map(escapeHtml).join(', ') || 'никого не изгнали'}</p>

            <h4>Параметры бункера</h4>
            <table class="param-table">
                <thead><tr><th>Параметр</th><th>Старт</th><th>Финал</th><th>Δ</th></tr></thead>
                <tbody>${tableRows}
                    <tr>
                        <td>🧠 Стабильность</td>
                        <td>${signed(stabilityBefore)}</td>
                        <td><b>${signed(stabilityAfter)}</b></td>
                        <td class="${stabilityDelta > 0 ? 'plus' : stabilityDelta < 0 ? 'minus' : ''}">${signed(stabilityDelta)}</td>
                    </tr>
                </tbody>
            </table>

            <h4>Что помогло</h4>
            <div class="effect-list positive-list">${effectEntriesHtml(ending.effects && ending.effects.positive, 1)}</div>

            <h4>Что помешало</h4>
            <div class="effect-list negative-list">${effectEntriesHtml(ending.effects && ending.effects.negative, -1)}</div>

            ${toArray(ending.effects && ending.effects.neutral).length
                ? `<h4>Нейтральные характеристики</h4><div class="effect-list neutral-list">${effectEntriesHtml(ending.effects.neutral, 0)}</div>`
                : ''}

            <p><b>Открытые комнаты:</b> ${toArray(ending.openedRoomNames).map(escapeHtml).join(', ') || 'ничего не открыто'}</p>
            <p><b>Закрытые комнаты:</b> ${toArray(ending.closedRoomNames).map(escapeHtml).join(', ') || 'нет'}</p>
            ${Number(ending.unknownRoomCount) > 0 ? `<p><b>Неизвестные комнаты:</b> ${Number(ending.unknownRoomCount)}</p>` : ''}
            <p><b>Сработавшие условия:</b> ${escapeHtml(ending.triggeredConditions || 'никакие')}</p>
            <p><b>Не сработавшие условия:</b> ${escapeHtml(ending.skippedConditions || 'нет')}</p>
        </div>

        <h3>Карточки игроков</h3>
        <div class="final-players">${playersHtml}</div>

        <div class="end-actions">
            ${isHost
                ? `<button type="button" data-action="restart">Сыграть снова</button>`
                : `<p class="waiting-note">Хост может перезапустить игру для этой же комнаты.</p>`}
        </div>
    </div>`;
}

// ---------------------------------------------------------------------------
//  Модалки
// ---------------------------------------------------------------------------

export function renderPlayersModal(app) {
    const state = app.state;
    if (!state) return;
    const html = toArray(state.players).map(player => {
        const values = player.values || {};
        const lines = FIELDS
            .filter(field => Object.prototype.hasOwnProperty.call(values, field.key))
            .map(field => `• ${escapeHtml(field.label)}: <b>${escapeHtml(displayValue(field, values))}</b>`);

        if (player.uid === app.uid && app.hand && app.hand.player) {
            const bonus = toArray(app.hand.player.bonusLuggage);
            if (bonus.length) {
                lines.push(`🎒 Бонусный багаж: <b>${bonus.map(escapeHtml).join(', ')}</b>`);
            }
        }

        const online = isOnline(app.presence && app.presence[player.uid]) || player.uid === app.uid;
        return `<div class="revealed-item">
            <b class="player-tag">${escapeHtml(player.name)}</b>
            ${player.isHost ? '<span class="badge host">хост</span>' : ''}
            ${player.uid === app.uid ? '<span class="badge me">вы</span>' : ''}
            ${player.alive ? '' : '<span class="badge dead-badge">выбыл(а)</span>'}
            <span class="online-dot ${online ? 'on' : 'off'}"></span>
            <br>${lines.join('<br>') || '<i>Пока ничего не раскрыто.</i>'}
        </div>`;
    }).join('');

    $('playersModalContent').innerHTML = html || '<i>Игроков нет.</i>';
}

export function renderLog(app) {
    const state = app.state;
    const log = state ? toArray(state.log) : [];
    const box = $('gameLog');
    box.innerHTML = log.map(entry =>
        `<div class="log-entry log-${escapeHtml(entry.type || 'info')}">${escapeHtml(entry.text || '')}</div>`
    ).join('') || '<i>Журнал пуст.</i>';
    if (log.length) box.scrollTop = box.scrollHeight;
}

export function renderStoryModal(app) {
    const state = app.state;
    const scenario = state && state.scenario;
    if (!scenario) return;

    $('storyTitle').textContent = scenario.title;
    $('storyDesc').innerHTML =
        `<b>Апокалипсис:</b> ${escapeHtml(scenario.apocalypse)}<br><br>` +
        `<b>Бункер:</b> ${escapeHtml(scenario.bunkerDesc)}` +
        `<br><span class="story-meta">${escapeHtml(scenario.bunkerSize)}</span>` +
        (scenario.plannedStay ? `<br><span class="planned-stay">🕰️ Планируемое время в бункере: <b>${escapeHtml(scenario.plannedStay)}</b></span>` : '') +
        `<br><br><b>Стартовые параметры:</b><div class="resources-bar">${resourceChips(state.baseResources, state.baseStability)}</div>` +
        `<p class="hint">Параметры не меняются до финала. Итог зависит от прошедших игроков и открытых комнат.</p>`;

    const rooms = toArray(state.rooms);
    const cards = rooms.map(room => {
        const status = room.status || 'open';
        const labels = { open: 'открыта', locked: 'заперта', broken: 'неисправна', closed: 'закрыта' };
        const inventory = toArray(room.inventory)
            .map(item => `• ${escapeHtml(item.name)} — ${escapeHtml(item.desc)}`)
            .join('<br>');

        let note = '';
        if (status === 'open') {
            note = '<div class="room-note ok">Доступна. Содержимое учитывается в финале.</div>';
        } else if (!room.hasOpenerEver) {
            note = '<div class="room-warning">⚠️ В игре нет игрока, способного открыть эту комнату — ни по профессии, ни по навыку, ни по факту.</div>';
        } else if (!room.hasOpenerAlive) {
            note = '<div class="room-warning">⚠️ Подходящий игрок был, но его изгнали — комната не откроется.</div>';
        } else if (state.phase === 'ended') {
            note = room.openAtEnd
                ? '<div class="room-note ok">Открыта: подходящий игрок прошёл в бункер.</div>'
                : '<div class="room-note bad">Закрыта: подходящий игрок не прошёл в бункер.</div>';
        } else {
            note = '<div class="room-note">В игре есть игрок, способный открыть комнату по профессии, навыку или факту. Она откроется в финале, если он пройдёт в бункер.</div>';
        }

        return `<div class="room-card ${escapeHtml(status)}">
            <div class="room-head"><b>${escapeHtml(room.name)}</b><span class="room-status">${labels[status] || ''}</span></div>
            <div class="room-desc">${escapeHtml(room.desc)}</div>
            <div class="room-loot"><b>Содержимое:</b><br>${inventory || 'ничего полезного'}</div>
            ${room.locked || room.broken ? `<div class="room-lock">🔒 ${escapeHtml(room.unlockText)}</div>` : ''}
            ${note}
        </div>`;
    }).join('');

    $('storyRooms').innerHTML =
        `<div class="rooms-grid">${cards}</div>` +
        (Number(state.hiddenRoomCount) > 0
            ? `<p class="room-hint">🚪 За закрытыми дверями осталось неизвестных помещений: <b>${state.hiddenRoomCount}</b>.</p>`
            : `<p class="room-hint">Все помещения бункера известны.</p>`);
}

// ---------------------------------------------------------------------------
//  Карта действия
// ---------------------------------------------------------------------------

export function openActionModal(app) {
    const hand = app.hand;
    const card = hand && hand.player && hand.player.actionCard;
    if (!card) {
        toast('У вас нет карты действия.', 'error');
        return;
    }
    if (hand.player.actionCardUsed) {
        toast('Эта карта уже использована.', 'error');
        return;
    }

    const targets = toArray(app.state.players).filter(p => p.alive && p.uid !== app.uid);
    if (targets.length === 0) {
        toast('Нет других живых игроков, на которых можно применить карту.', 'error');
        return;
    }

    $('actionModalTitle').textContent = `${card.icon || '🃏'} ${card.name}`;
    $('actionModalDesc').textContent = card.desc;

    const targetOptions = targets.map(target =>
        `<option value="${escapeHtml(target.uid)}">${escapeHtml(target.name)}</option>`
    ).join('');

    $('actionModalBody').innerHTML = `
        <label class="action-label">Выберите игрока:
            <select id="actionTarget">${targetOptions}</select>
        </label>
        <div id="actionPreview" class="action-hint"></div>
    `;

    const updatePreview = () => {
        const targetUid = $('actionTarget').value;
        const target = targets.find(p => p.uid === targetUid);
        const preview = $('actionPreview');
        const applyBtn = $('applyActionBtn');
        if (!target) {
            preview.textContent = 'Выберите живого игрока.';
            applyBtn.disabled = true;
            return;
        }

        if (card.kind === 'reveal') {
            const field = FIELDS.find(f => f.key === card.field);
            if (!field) {
                preview.textContent = 'Неизвестная характеристика.';
                applyBtn.disabled = true;
            } else if (target.revealed && target.revealed[field.key]) {
                preview.innerHTML = `У игрока <b>${escapeHtml(target.name)}</b> характеристика «${escapeHtml(field.label)}» уже открыта.`;
                applyBtn.disabled = true;
            } else {
                preview.innerHTML = `Будет раскрыто: <b>${escapeHtml(field.label)}</b> у игрока <b>${escapeHtml(target.name)}</b>.`;
                applyBtn.disabled = false;
            }
            return;
        }

        if (card.kind === 'swap') {
            const field = FIELDS.find(f => f.key === card.field);
            const owner = hand.player;
            if (!field) {
                preview.textContent = 'Неизвестная характеристика.';
                applyBtn.disabled = true;
            } else if (!owner.revealed[field.key]) {
                preview.innerHTML = `У вас «${escapeHtml(field.label)}» ещё не открыта.`;
                applyBtn.disabled = true;
            } else if (!target.revealed || !target.revealed[field.key]) {
                preview.innerHTML = `У игрока <b>${escapeHtml(target.name)}</b> «${escapeHtml(field.label)}» ещё не открыта.`;
                applyBtn.disabled = true;
            } else {
                preview.innerHTML = `Обмен «<b>${escapeHtml(field.label)}</b>» с игроком <b>${escapeHtml(target.name)}</b>.`;
                applyBtn.disabled = false;
            }
            return;
        }

        if (card.kind === 'steal') {
            preview.innerHTML = `У игрока <b>${escapeHtml(target.name)}</b> будет украден первый доступный багаж (если он есть).`;
            applyBtn.disabled = false;
            return;
        }

        preview.textContent = 'Неизвестная карта.';
        applyBtn.disabled = true;
    };

    $('actionTarget').addEventListener('change', updatePreview);
    updatePreview();
    openModal('actionModal');
}

function applyActionCard(app) {
    const targetUid = $('actionTarget') ? $('actionTarget').value : '';
    if (!targetUid) {
        toast('Выберите цель карты.', 'error');
        return;
    }
    closeModal('actionModal');
    send(app, 'action', { targetUid });
}

// ---------------------------------------------------------------------------
//  Делегирование кнопок внутри панелей
// ---------------------------------------------------------------------------

async function handlePanelClick(event, app) {
    const button = event.target.closest('[data-action]');
    if (!button || button.disabled) return;

    const action = button.dataset.action;

    if (action === 'reveal') {
        const key = button.dataset.key;
        const player = app.hand && app.hand.player;
        const field = REVEALABLE_FIELDS.find(f => f.key === key);
        let value = null;

        if (player && field && player[key] === CUSTOM_MARKER) {
            value = prompt(`Вы выбрали «${field.label}: Придумай сам». Введите своё значение:`);
            if (value === null) return;
            value = value.trim();
            if (!value) {
                toast('Значение не может быть пустым.', 'error');
                return;
            }
        }

        button.disabled = true;
        await send(app, 'reveal', { key, value });
        return;
    }

    if (action === 'open-action') {
        openActionModal(app);
        return;
    }

    if (action === 'vote') {
        document.querySelectorAll('[data-action="vote"]').forEach(btn => { btn.disabled = true; });
        toast('Голос отправлен анонимно.', 'info', 2500);
        await send(app, 'vote', { targetUid: button.dataset.target });
        return;
    }

    if (action === 'decider') {
        document.querySelectorAll('[data-action="decider"]').forEach(btn => { btn.disabled = true; });
        await send(app, 'decider', { targetUid: button.dataset.target });
        return;
    }

    if (action === 'begin') {
        button.disabled = true;
        await send(app, 'begin', {});
        return;
    }

    if (action === 'skip') {
        if (!confirm('Пропустить действие этого игрока? Он не сможет вернуть свой ход.')) return;
        button.disabled = true;
        await send(app, 'skip', {});
        return;
    }

    if (action === 'continue') {
        button.disabled = true;
        await send(app, 'continue', {});
        return;
    }

    if (action === 'restart') {
        openModal('restartModal');
    }
}
