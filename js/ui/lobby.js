'use strict';

import {
    POOLS,
    AGE_CATEGORIES,
    HEALTH_CATEGORIES,
    DEFAULT_GENERATION
} from '../config.js';
import { computeVotePlan, parseManualVotePlan } from '../game/engine.js';
import { $, toast, escapeHtml, isOnline, copyText, shareLink } from './dom.js';

let handlers = null;
let eventsBound = false;
let formInitializedFor = null;
let renderedQuotaRoundsKey = null;
let currentLobbyTab = 'players';

const LOBBY_TABS = ['players', 'settings'];

export function initLobby(options) {
    handlers = options;
    if (eventsBound) return;
    eventsBound = true;

    setDefaultWeights();

    $('lobbyScenario').addEventListener('change', updateLobbyScenarioHint);
    $('lobbyVoteMode').addEventListener('change', () => {
        if ($('lobbyVoteMode').value === 'manual' && !$('lobbyVoteRounds').value.trim()) {
            fillAutoVotePlan();
        }
        refreshVoteUi();
    });
    $('lobbyVoteRounds').addEventListener('input', () => renderVoteQuotaRows());
    $('lobbyVoteAutoFillBtn').addEventListener('click', fillAutoVotePlan);

    $('lobbySurvivors').addEventListener('input', refreshVoteUi);
    $('lobbySurvivors').addEventListener('change', refreshVoteUi);

    $('lobbyVoteQuotas').addEventListener('input', updateVoteHint);
    $('lobbyVoteQuotas').addEventListener('change', event => {
        const input = event.target.closest('[data-vote-round]');
        if (!input) return;
        const count = playerCount();
        const max = maxPerVote(count, effectiveSurvivors(count));
        const value = Math.max(1, Math.min(max, parseInt(input.value, 10) || 1));
        input.value = value;
        updateVoteHint();
    });

    $('startGameBtn').addEventListener('click', () => {
        if (!handlers || !handlers.onStart) return;
        const count = playerCount();
        if (count < 4) {
            toast('Для старта нужно минимум 4 игрока.', 'error');
            return;
        }

        const settings = collectStartSettings();
        if (!settings) return;
        handlers.onStart(settings);
    });

    $('leaveLobbyBtn').addEventListener('click', () => {
        if (handlers && handlers.onLeave) handlers.onLeave();
    });

    $('copyCodeBtn').addEventListener('click', async () => {
        if (!handlers) return;
        const ok = await copyText(handlers.getCode());
        toast(ok ? 'Код комнаты скопирован.' : 'Не удалось скопировать код.', ok ? 'success' : 'error');
    });

    $('copyInviteBtn').addEventListener('click', async () => {
        if (!handlers) return;
        const ok = await copyText(handlers.getInviteLink());
        toast(ok ? 'Ссылка-приглашение скопирована.' : 'Не удалось скопировать ссылку.', ok ? 'success' : 'error');
    });

    $('lobbyPlayers').addEventListener('click', event => {
        const button = event.target.closest('[data-kick]');
        if (!button || !handlers || !handlers.onKick) return;
        handlers.onKick(button.dataset.kick);
    });

    // --- вкладки лобби: свайп и сегментированное переключение ---
    $('lobbyTabs').addEventListener('click', event => {
        const button = event.target.closest('[data-lobby-tab]');
        if (!button || button.hidden) return;
        setLobbyTab(button.dataset.lobbyTab, true);
    });

    let scrollFrame = null;
    $('lobbyPanes').addEventListener('scroll', () => {
        if (scrollFrame) return;
        scrollFrame = requestAnimationFrame(() => {
            scrollFrame = null;
            syncLobbyTabFromScroll();
        });
    }, { passive: true });

    let resizeFrame = null;
    window.addEventListener('resize', () => {
        if (document.body.dataset.screen !== 'lobbyScreen') return;
        if (resizeFrame) return;
        resizeFrame = requestAnimationFrame(() => {
            resizeFrame = null;
            const panes = $('lobbyPanes');
            if (panes) panes.scrollLeft = panes.clientWidth * lobbyTabIndex(currentLobbyTab);
        });
    });

    $('shareInviteBtn').addEventListener('click', async () => {
        if (!handlers) return;
        const result = await shareLink({
            title: 'Shelter — игра в бункер',
            text: `Присоединяйтесь к комнате ${handlers.getCode()}`,
            url: handlers.getInviteLink()
        });
        if (result === 'copied') toast('Ссылка скопирована — отправьте её друзьям.', 'success');
        else if (result === 'failed') toast('Не удалось скопировать ссылку.', 'error');
    });
}

function lobbyTabButtons() {
    return Array.from(document.querySelectorAll('[data-lobby-tab]'));
}

function lobbyTabIndex(tab) {
    const buttons = lobbyTabButtons();
    const index = buttons.findIndex(button => button.dataset.lobbyTab === tab);
    return index >= 0 ? index : 0;
}

export function setLobbyTab(tab, user = false) {
    if (!LOBBY_TABS.includes(tab)) return;
    if (tab === 'settings' && $('lobbyTabSettings').hidden) tab = 'players';
    currentLobbyTab = tab;

    const panes = $('lobbyPanes');
    if (panes) {
        const left = panes.clientWidth * lobbyTabIndex(tab);
        if (Math.abs(panes.scrollLeft - left) > 2) {
            panes.scrollTo({ left, behavior: 'auto' });
        }
    }

    lobbyTabButtons().forEach(button => {
        const active = button.dataset.lobbyTab === tab;
        button.classList.toggle('active', active);
        button.setAttribute('aria-selected', active ? 'true' : 'false');
    });
}

function syncLobbyTabFromScroll() {
    const panes = $('lobbyPanes');
    if (!panes || !panes.clientWidth) return;
    const index = Math.round(panes.scrollLeft / panes.clientWidth);
    const button = lobbyTabButtons()[index];
    if (!button) return;
    const tab = button.dataset.lobbyTab;
    if (!LOBBY_TABS.includes(tab) || tab === currentLobbyTab) return;
    if (button.hidden) return;
    currentLobbyTab = tab;
    lobbyTabButtons().forEach(item => {
        const active = item.dataset.lobbyTab === tab;
        item.classList.toggle('active', active);
        item.setAttribute('aria-selected', active ? 'true' : 'false');
    });
}

// Вызывается при каждом входе на экран лобби: показываем список игроков,
// но не сбрасываем введённые настройки.
export function resetLobbyView() {
    setLobbyTab('players');
    const panes = $('lobbyPanes');
    if (panes) panes.scrollLeft = 0;
}

export function resetLobbyForm() {
    formInitializedFor = null;
    renderedQuotaRoundsKey = null;
    if (!eventsBound) return;
    $('lobbyVoteMode').value = 'auto';
    $('lobbyVoteRounds').value = '';
    $('lobbyVoteQuotas').innerHTML = '';
    setDefaultWeights();
}

function setDefaultWeights() {
    renderWeightInputs('lobbyAgeWeights', AGE_CATEGORIES, DEFAULT_GENERATION.ageWeights, 'age');
    renderWeightInputs('lobbyHealthWeights', HEALTH_CATEGORIES, DEFAULT_GENERATION.healthWeights, 'health');
    renderWeightInputs(
        'lobbyOrientationWeights',
        POOLS.orientation.map(value => ({ label: value })),
        DEFAULT_GENERATION.orientationWeights,
        'orientation'
    );
}

function renderWeightInputs(containerId, items, weights, dataAttr) {
    const container = $(containerId);
    if (!container) return;
    container.innerHTML = items.map((item, index) => `
        <label class="weight-field">
            <span>${escapeHtml(item.label)}</span>
            <input type="number" min="0" max="100" step="1"
                value="${Number(weights[index]) || 0}"
                data-${dataAttr}-weight="${index}">
        </label>
    `).join('');
}

function updateLobbyScenarioHint() {
    const hint = $('lobbyScenarioHint');
    if (!hint) return;
    if ($('lobbyScenario').value === 'random') {
        hint.textContent = 'Случайный сценарий будет выбран при старте.';
        return;
    }
    hint.textContent = '';
}

function sortedMembers(members) {
    return Object.entries(members || {})
        .map(([uid, member]) => ({ uid, ...(member || {}) }))
        .filter(member => member.name)
        .sort((a, b) => (Number(a.joinedAt) || 0) - (Number(b.joinedAt) || 0));
}

function playerCount() {
    return handlers && handlers.getPlayerCount ? handlers.getPlayerCount() : 0;
}

function rawSurvivors() {
    return Math.max(1, parseInt($('lobbySurvivors').value, 10) || 2);
}

function effectiveSurvivors(count) {
    return Math.min(rawSurvivors(), Math.max(1, count - 1));
}

function maxPerVote(count, survivors) {
    return Math.max(1, count - survivors);
}

function parseRounds(value) {
    return [...new Set(
        String(value || '')
            .split(',')
            .map(item => parseInt(item.trim(), 10))
            .filter(item => Number.isFinite(item) && item >= 1 && item <= 11)
    )].sort((a, b) => a - b);
}

function quotaInputs() {
    const result = {};
    $('lobbyVoteQuotas').querySelectorAll('[data-vote-round]').forEach(input => {
        result[Number(input.dataset.voteRound)] = parseInt(input.value, 10) || 1;
    });
    return result;
}

function renderVoteQuotaRows(seed = null, force = false) {
    if (!eventsBound) return;
    const rounds = parseRounds($('lobbyVoteRounds').value);
    const count = playerCount();
    const survivors = effectiveSurvivors(count);
    const max = maxPerVote(count, survivors);
    const existing = Object.assign({}, quotaInputs(), seed || {});

    const key = `${rounds.join(',')}|${max}|${seed ? JSON.stringify(seed) : ''}`;
    if (!force && key === renderedQuotaRoundsKey) {
        updateVoteHint();
        return;
    }
    renderedQuotaRoundsKey = key;

    const container = $('lobbyVoteQuotas');
    if (rounds.length === 0) {
        container.innerHTML = '<p class="hint">Укажите хотя бы один раунд от 1 до 11.</p>';
        updateVoteHint();
        return;
    }

    container.innerHTML = rounds.map(round => {
        const value = Math.max(1, Math.min(max, Number(existing[round]) || 1));
        return `<div class="quota-row">
            <span>После раунда <b>${round}</b> изгнать</span>
            <input type="number" min="1" max="${max}" value="${value}" data-vote-round="${round}">
            <span>игрок(ов)</span>
        </div>`;
    }).join('');

    updateVoteHint();
}

function fillAutoVotePlan() {
    const count = playerCount();
    const survivors = effectiveSurvivors(count);
    const plan = computeVotePlan(count, survivors);
    $('lobbyVoteRounds').value = plan.rounds.join(', ');
    renderVoteQuotaRows(plan.quotas, true);
}

function currentManualPlan(count, survivors) {
    const rounds = parseRounds($('lobbyVoteRounds').value);
    const quotas = quotaInputs();
    return parseManualVotePlan(rounds, quotas, count, survivors);
}

function updateVoteHint() {
    if (!eventsBound) return;
    const count = playerCount();
    const survivors = effectiveSurvivors(count);
    const needed = Math.max(0, count - survivors);
    const mode = $('lobbyVoteMode').value;
    const hint = $('lobbyVoteHint');
    const startHint = $('startGameHint');
    const startButton = $('startGameBtn');

    let manualValid = true;
    let planned = 0;

    if (mode === 'manual') {
        const result = currentManualPlan(count, survivors);
        manualValid = result.ok;
        if (result.ok) {
            planned = result.plan.rounds.reduce((sum, round) => sum + result.plan.quotas[round], 0);
        }
        hint.className = `plan-hint ${manualValid ? 'ok' : 'warn'}`;
        hint.textContent = result.ok
            ? `Будет изгнано ${planned}; нужно ${needed}, чтобы осталось ${survivors}.`
            : result.error;
    } else {
        hint.textContent = '';
        hint.className = 'plan-hint';
    }

    const canStart = count >= 4 && count <= 15 && manualValid;
    startButton.disabled = !canStart;

    if (count < 4) {
        startHint.textContent = `Минимум 4 игрока, сейчас ${count}.`;
    } else if (count > 15) {
        startHint.textContent = 'В комнате больше 15 игроков — это максимум.';
    } else if (mode === 'manual' && !manualValid) {
        startHint.textContent = 'Исправьте ручной план голосований.';
    } else {
        startHint.textContent = `Игроков: ${count}. Выживших: ${survivors}.`;
    }
}

function refreshVoteUi() {
    if (!eventsBound) return;
    const count = playerCount();
    const survivors = effectiveSurvivors(count);
    const manual = $('lobbyVoteMode').value === 'manual';
    $('lobbyVoteManual').hidden = !manual;

    const auto = computeVotePlan(count, survivors);
    $('lobbyVoteAutoHint').textContent = auto.rounds.length
        ? `Автоматически: ${auto.rounds.map(round => `после ${round} — ${auto.quotas[round]}`).join('; ')}.`
        : 'Автоматически: голосований не потребуется.';

    if (manual) renderVoteQuotaRows();
    else updateVoteHint();
}

function readWeights(containerId) {
    return Array.from($(containerId).querySelectorAll('input'))
        .map(input => Math.max(0, Math.min(100, Number(input.value) || 0)));
}

function collectStartSettings() {
    const count = playerCount();
    const survivors = effectiveSurvivors(count);
    const voteMode = $('lobbyVoteMode').value === 'manual' ? 'manual' : 'auto';
    const generation = {
        ageWeights: readWeights('lobbyAgeWeights'),
        healthWeights: readWeights('lobbyHealthWeights'),
        orientationWeights: readWeights('lobbyOrientationWeights')
    };

    let voteRounds = null;
    let voteQuotas = null;

    if (voteMode === 'manual') {
        const rounds = parseRounds($('lobbyVoteRounds').value);
        const quotas = quotaInputs();
        const validation = parseManualVotePlan(rounds, quotas, count, survivors);
        if (!validation.ok) {
            toast(validation.error, 'error', 6000);
            return null;
        }
        voteRounds = validation.plan.rounds;
        voteQuotas = validation.plan.quotas;
    }

    return {
        scenarioId: $('lobbyScenario').value || 'random',
        survivors,
        voteMode,
        voteRounds,
        voteQuotas,
        generation
    };
}

export function renderLobby(app) {
    if (!app || !app.meta) return;
    const code = app.code;
    $('lobbyCode').textContent = code;
    $('inviteLink').value = app.buildInviteLink ? app.buildInviteLink() : '';
    $('lobbyCount').textContent = '';

    const members = sortedMembers(app.members);
    const count = members.length;
    const hostUid = app.meta.hostUid;
    const isHost = hostUid === app.uid;
    const hostMember = members.find(m => m.uid === hostUid);

    $('lobbyPlayers').innerHTML = members.map((member, index) => {
        const online = isOnline(app.presence && app.presence[member.uid]);
        const badges = [];
        if (member.uid === hostUid) badges.push('<span class="badge host">хост</span>');
        if (member.uid === app.uid) badges.push('<span class="badge me">вы</span>');
        if (!online && member.uid !== app.uid) badges.push('<span class="badge dead-badge">офлайн</span>');
        const kick = isHost && member.uid !== app.uid
            ? `<button type="button" class="kick-btn" data-kick="${escapeHtml(member.uid)}" title="Удалить игрока из комнаты">✕</button>`
            : '';
        return `<div class="player-row ${online ? 'online' : 'offline'}">
            <span class="player-order">${index + 1}</span>
            <span class="online-dot ${online ? 'on' : 'off'}"></span>
            <span class="player-name">${escapeHtml(member.name)}</span>
            <span class="player-badges">${badges.join('')}</span>
            ${kick}
        </div>`;
    }).join('');

    $('lobbyCount').textContent = `${count} / 15`;
    $('lobbyTabCount').textContent = String(count);

    const modeNote = $('lobbyModeNote');
    if (app.mode === 'local') {
        modeNote.innerHTML = '⚠️ <b>Локальный режим.</b> Он работает только между вкладками одного браузера. Для игры с разных устройств подключите Firebase (см. README.md).';
        modeNote.hidden = false;
    } else {
        modeNote.textContent = 'Ссылка-приглашение открывает эту комнату у любого игрока. Достаточно 4 участников.';
        modeNote.hidden = false;
    }

    const settings = $('lobbySettings');
    const wait = $('lobbyWait');
    settings.hidden = !isHost;
    wait.hidden = isHost;

    // Настройки — отдельная вкладка, доступная только хосту.
    const settingsPane = document.querySelector('[data-lobby-pane="settings"]');
    if (settingsPane) settingsPane.hidden = !isHost;
    $('lobbyTabs').hidden = !isHost;
    $('lobbyTabSettings').hidden = !isHost;
    $('lobbyFooter').hidden = !isHost;
    if (!isHost && currentLobbyTab !== 'players') setLobbyTab('players');

    if (isHost) {
        const key = `${code}`;
        if (formInitializedFor !== key) {
            formInitializedFor = key;
            const metaScenario = app.meta.scenarioId && app.meta.scenarioId !== 'random'
                ? app.meta.scenarioId
                : 'random';
            if (Array.from($('lobbyScenario').options).some(o => o.value === metaScenario)) {
                $('lobbyScenario').value = metaScenario;
            }
            $('lobbySurvivors').value = Math.max(1, Math.min(15, Number(app.meta.survivors) || 2));
        }

        $('lobbySurvivors').max = Math.max(1, count - 1);

        if (count < 4) {
            $('lobbyHint').textContent = `Нужно ещё ${4 - count} игрок(ов). Отправьте ссылку-приглашение.`;
        } else if (count > 15) {
            $('lobbyHint').textContent = 'В комнате больше 15 игроков — это максимум.';
        } else {
            $('lobbyHint').textContent = 'Все готовы. Хост может начинать.';
        }

        refreshVoteUi();
    } else {
        $('lobbyHint').textContent = hostMember
            ? `Хост: ${hostMember.name}. Ждём начала игры — экран обновится автоматически.`
            : 'Ждём хоста.';
        $('lobbyWait').innerHTML = `<h3>Ждём хоста</h3>
            <p>${hostMember ? `Хост <b>${escapeHtml(hostMember.name)}</b>` : 'Хост'} настраивает сценарий и начнёт игру. Экран обновится автоматически.</p>
            <p class="hint">Сейчас в комнате ${count} игрок(ов). Нужно от 4 до 15.</p>`;
        $('lobbyHint').textContent = '';
    }
}
