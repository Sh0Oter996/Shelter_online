'use strict';

import { escapeHtml } from '../utils.js';

export { escapeHtml };

export const $ = id => document.getElementById(id);

export function showScreen(id) {
    document.querySelectorAll('.screen').forEach(screen => {
        screen.classList.toggle('active', screen.id === id);
    });
    window.scrollTo(0, 0);
}

export function openModal(id) {
    const modal = $(id);
    if (modal) modal.classList.add('open');
}

export function closeModal(id) {
    const modal = $(id);
    if (modal) modal.classList.remove('open');
}

export function closeAllModals() {
    document.querySelectorAll('.modal-overlay.open').forEach(modal => modal.classList.remove('open'));
}

export function initModalHandlers() {
    document.addEventListener('click', event => {
        const closeBtn = event.target.closest('[data-close]');
        if (closeBtn) {
            closeModal(closeBtn.dataset.close);
            return;
        }
        const overlay = event.target.closest('.modal-overlay');
        if (overlay && event.target === overlay) {
            closeModal(overlay.id);
        }
    });

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') closeAllModals();
    });
}

let toastTimer = null;

export function toast(message, type = 'info', duration = 4200) {
    const el = $('toast');
    if (!el) return;
    el.textContent = String(message);
    el.className = `toast show ${type}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        el.className = 'toast';
    }, duration);
}

export function setButtonBusy(button, busy, busyText = 'Подождите…') {
    if (!button) return;
    if (busy) {
        if (!button.dataset.originalText) button.dataset.originalText = button.textContent;
        button.disabled = true;
        button.textContent = busyText;
    } else {
        button.disabled = false;
        if (button.dataset.originalText) {
            button.textContent = button.dataset.originalText;
            delete button.dataset.originalText;
        }
    }
}

export function setConnectionPill(mode, label) {
    const el = $('connectionPill');
    if (!el) return;
    el.hidden = false;
    el.className = `connection-pill ${mode}`;
    el.textContent = label;
}

export function isOnline(presenceEntry, maxAgeMs = 90000) {
    if (!presenceEntry) return false;
    return presenceEntry.online !== false && Date.now() - (Number(presenceEntry.at) || 0) < maxAgeMs;
}

export function isStale(presenceEntry, maxAgeMs = 120000) {
    if (!presenceEntry) return false;
    return Date.now() - (Number(presenceEntry.at) || 0) > maxAgeMs;
}

export function phaseLabel(phase) {
    return {
        lobby: 'Лобби',
        story: 'История',
        reveal: 'Раскрытие',
        vote: 'Голосование',
        'vote-result': 'Итоги голосования',
        decider: 'Решающий голос',
        ended: 'Финал'
    }[phase] || phase;
}

export function confirmAction(message) {
    return window.confirm(message);
}
