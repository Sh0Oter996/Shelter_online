'use strict';

import { SCENARIOS } from '../config.js';
import { $, toast, setButtonBusy } from './dom.js';
import { normalizeCode } from '../utils.js';

const NAME_KEY = 'shelter.name';

function fillScenarioSelect(select, includeRandom = true) {
    if (!select) return;
    const current = select.value;
    select.innerHTML = '';
    if (includeRandom) {
        const option = document.createElement('option');
        option.value = 'random';
        option.textContent = '🎲 Случайный сценарий';
        select.appendChild(option);
    }
    SCENARIOS.forEach(scenario => {
        const option = document.createElement('option');
        option.value = scenario.id;
        option.textContent = scenario.title;
        select.appendChild(option);
    });
    if (current && Array.from(select.options).some(o => o.value === current)) {
        select.value = current;
    }
}

function scenarioHint(select, hint) {
    if (!select || !hint) return;
    if (select.value === 'random') {
        hint.textContent = 'Сценарий, бункер, комнаты и концовка выбираются случайно при старте.';
        return;
    }
    const scenario = SCENARIOS.find(s => s.id === select.value);
    hint.textContent = scenario
        ? `${scenario.apocalypse} ${scenario.bunkerSize}`
        : '';
}

export function initHome({ onCreate, onJoin }) {
    fillScenarioSelect($('createScenario'));
    fillScenarioSelect($('lobbyScenario'));

    const homeScreen = $('homeScreen');
    const modeButtons = Array.from(homeScreen.querySelectorAll('[data-home-mode]'));
    modeButtons.forEach(button => {
        button.addEventListener('click', () => setHomeMode(button.dataset.homeMode));
    });

    let savedName = '';
    try { savedName = localStorage.getItem(NAME_KEY) || ''; } catch { /* ignore */ }

    if (savedName) {
        $('createName').value = savedName;
        $('joinName').value = savedName;
    }

    // Если открыли ссылку-приглашение, сразу показываем форму входа.
    const inviteCode = normalizeCode(new URLSearchParams(location.search).get('room') || '');
    setHomeMode(inviteCode ? 'join' : 'create');

    const updateHint = () => scenarioHint($('createScenario'), $('createScenarioHint'));
    $('createScenario').addEventListener('change', updateHint);
    updateHint();

    $('createForm').addEventListener('submit', async event => {
        event.preventDefault();
        const name = $('createName').value.trim();
        if (!name) {
            toast('Введите имя — его увидят другие игроки.', 'error');
            $('createName').focus();
            return;
        }
        const survivors = parseInt($('createSurvivors').value, 10) || 2;
        if (survivors < 1) {
            toast('Выживших должно быть хотя бы 1.', 'error');
            return;
        }

        const button = $('createBtn');
        setButtonBusy(button, true, 'Создаём…');
        try {
            rememberName(name);
            await onCreate({
                name,
                scenarioId: $('createScenario').value || 'random',
                survivors
            });
        } catch (error) {
            toast(error.message || 'Не удалось создать комнату.', 'error');
        } finally {
            setButtonBusy(button, false);
        }
    });

    $('joinForm').addEventListener('submit', async event => {
        event.preventDefault();
        const name = $('joinName').value.trim();
        const code = normalizeCode($('joinCode').value);
        if (!name) {
            toast('Введите имя — его увидят другие игроки.', 'error');
            $('joinName').focus();
            return;
        }
        if (code.length < 4) {
            toast('Введите код комнаты из 4–6 цифр.', 'error');
            $('joinCode').focus();
            return;
        }

        const button = $('joinBtn');
        setButtonBusy(button, true, 'Входим…');
        try {
            rememberName(name);
            await onJoin({ name, code });
        } catch (error) {
            toast(error.message || 'Не удалось войти в комнату.', 'error');
        } finally {
            setButtonBusy(button, false);
        }
    });

    const inviteCodeFromUrl = normalizeCode(new URLSearchParams(location.search).get('room') || '');
    if (inviteCodeFromUrl) {
        $('joinCode').value = inviteCodeFromUrl;
        updateInviteModeNote();
    }
    $('joinCode').addEventListener('input', () => {
        $('joinCode').value = normalizeCode($('joinCode').value);
        updateInviteModeNote();
    });

    return { savedName };
}

export function setHomeMode(mode) {
    const screen = $('homeScreen');
    if (!screen) return;
    const next = mode === 'join' ? 'join' : 'create';
    screen.classList.toggle('mode-create', next === 'create');
    screen.classList.toggle('mode-join', next === 'join');
    screen.querySelectorAll('[data-home-mode]').forEach(button => {
        const active = button.dataset.homeMode === next;
        button.classList.toggle('active', active);
        button.setAttribute('aria-selected', active ? 'true' : 'false');
    });
}

function updateInviteModeNote() {
    const note = $('joinCode');
    if (!note) return;
    // Подсказка о ссылке-приглашении уже есть в разметке; здесь только визуально
    // подсвечиваем поле, когда код пришёл из URL.
    note.classList.toggle('prefilled', !!note.value);
}

function rememberName(name) {
    try { localStorage.setItem(NAME_KEY, name); } catch { /* ignore */ }
}

export function prefillJoin(code) {
    const clean = normalizeCode(code || '');
    if (!clean) return;
    const input = $('joinCode');
    if (input) {
        input.value = clean;
        setHomeMode('join');
    }
}

export function fillLobbyScenarioSelect() {
    fillScenarioSelect($('lobbyScenario'));
}

export function getLobbyScenarioHint() {
    return $('lobbyScenarioHint');
}
