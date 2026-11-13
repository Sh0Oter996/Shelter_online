'use strict';

import { $, toast, escapeHtml, isOnline } from './dom.js';

let handlers = null;
let eventsBound = false;
let formInitializedFor = null;

export function initLobby(options) {
    handlers = options;
    if (eventsBound) return;
    eventsBound = true;

    $('lobbyScenario').addEventListener('change', updateLobbyScenarioHint);

    $('startGameBtn').addEventListener('click', () => {
        if (!handlers || !handlers.onStart) return;
        const count = handlers.getPlayerCount ? handlers.getPlayerCount() : 0;
        if (count < 4) {
            toast('Для старта нужно минимум 4 игрока.', 'error');
            return;
        }
        const survivors = parseInt($('lobbySurvivors').value, 10) || 1;
        handlers.onStart({
            scenarioId: $('lobbyScenario').value || 'random',
            survivors
        });
    });

    $('leaveLobbyBtn').addEventListener('click', () => {
        if (handlers && handlers.onLeave) handlers.onLeave();
    });

    $('copyCodeBtn').addEventListener('click', () => {
        if (!handlers) return;
        copyText(handlers.getCode()).then(() => toast('Код комнаты скопирован.', 'success'));
    });

    $('copyInviteBtn').addEventListener('click', () => {
        if (!handlers) return;
        copyText(handlers.getInviteLink()).then(() => toast('Ссылка-приглашение скопирована.', 'success'));
    });

    $('lobbyPlayers').addEventListener('click', event => {
        const button = event.target.closest('[data-kick]');
        if (!button || !handlers || !handlers.onKick) return;
        handlers.onKick(button.dataset.kick);
    });
}

export function resetLobbyForm() {
    formInitializedFor = null;
}

function updateLobbyScenarioHint() {
    const hint = $('lobbyScenarioHint');
    if (!hint) return;
    if ($('lobbyScenario').value === 'random') {
        hint.textContent = 'Случайный сценарий будет выбран при старте.';
        return;
    }
    // Полное описание сценария доступно в модалке «Бункер» после старта,
    // в лобби достаточно названия.
    hint.textContent = '';
}

function sortedMembers(members) {
    return Object.entries(members || {})
        .map(([uid, member]) => ({ uid, ...(member || {}) }))
        .filter(member => member.name)
        .sort((a, b) => (Number(a.joinedAt) || 0) - (Number(b.joinedAt) || 0));
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
        const survivors = parseInt($('lobbySurvivors').value, 10) || 2;
        const effectiveSurvivors = Math.min(survivors, Math.max(1, count - 1));

        const canStart = count >= 4 && count <= 15;
        $('startGameBtn').disabled = !canStart;

        if (count < 4) {
            $('lobbyHint').textContent = `Нужно ещё ${4 - count} игрок(ов). Отправьте ссылку-приглашение.`;
            $('startGameHint').textContent = `Минимум 4 игрока, сейчас ${count}.`;
        } else if (count > 15) {
            $('lobbyHint').textContent = 'В комнате больше 15 игроков — это максимум.';
            $('startGameHint').textContent = 'Кто-то должен выйти из комнаты.';
        } else {
            $('lobbyHint').textContent = 'Все готовы. Хост может начинать.';
            $('startGameHint').textContent = `Игроков: ${count}. Выживших: ${effectiveSurvivors}.`;
        }
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

async function copyText(text) {
    const value = String(text || '');
    if (!value) return;
    try {
        await navigator.clipboard.writeText(value);
    } catch {
        const input = document.createElement('textarea');
        input.value = value;
        input.style.position = 'fixed';
        input.style.opacity = '0';
        document.body.appendChild(input);
        input.select();
        try { document.execCommand('copy'); } finally { input.remove(); }
    }
}
