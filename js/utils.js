'use strict';

// Чистые вспомогательные функции, общие для движка и интерфейса.

export function shuffle(arr) {
    const a = Array.from(arr || []);
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

export function randomItem(arr) {
    if (!arr || arr.length === 0) return undefined;
    return arr[Math.floor(Math.random() * arr.length)];
}

export function ensurePoolSize(pool, needed, label) {
    const result = Array.from(pool || []);
    let n = 1;
    while (result.length < needed) result.push(`${label} ${n++}`);
    return result;
}

export function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

export function signed(value) {
    return value > 0 ? `+${value}` : String(value);
}

// Realtime Database не хранит пустые массивы и иногда отдаёт массивы как
// объекты с числовыми ключами. Эти помощники нормализуют такие значения.
export function toArray(value) {
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') {
        return Object.keys(value)
            .filter(key => key !== '.priority')
            .sort((a, b) => Number(a) - Number(b))
            .map(key => value[key]);
    }
    return [];
}

export function toObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function safeJsonClone(value) {
    return JSON.parse(JSON.stringify(value));
}

export function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function normalizeName(raw, fallback = 'Игрок') {
    const name = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
    return (name || fallback).slice(0, 20);
}

export function normalizeCode(raw) {
    const digits = String(raw == null ? '' : raw).replace(/\D/g, '');
    return digits.slice(0, 6);
}

export function generateRoomCode(length = 6) {
    const digits = Math.max(4, Math.min(6, Number(length) || 6));
    const min = 10 ** (digits - 1);
    const max = 10 ** digits - 1;
    return String(Math.floor(min + Math.random() * (max - min + 1)));
}

export function formatRoomCode(code) {
    return String(code || '').replace(/(\d{3})(?=\d)/g, '$1 ');
}

export function shortTime(ts) {
    if (!ts) return '';
    try {
        return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    } catch {
        return '';
    }
}
