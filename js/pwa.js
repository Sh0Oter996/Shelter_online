'use strict';

// ============================================================================
//  Установка игры как приложения (PWA) и service worker.
//  Работает поверх обычного сайта: если браузер не поддерживает установку,
//  интерфейс просто не показывает кнопки.
// ============================================================================

import { $, toast, openModal } from './ui/dom.js';

const DISMISS_KEY = 'shelter.installDismissedAt';
const DISMISS_DAYS = 14;

let deferredPrompt = null;
let installAvailable = false;

function platformName() {
    const ua = navigator.userAgent || '';
    if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
    if (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) return 'ios';
    if (/Android/i.test(ua)) return 'android';
    return 'desktop';
}

function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches ||
        window.matchMedia('(display-mode: fullscreen)').matches ||
        window.navigator.standalone === true;
}

const PLATFORM_TEXT = {
    ios: 'Ярлык на экране «Домой»',
    android: 'Ярлык на главном экране',
    desktop: 'Отдельное окно без браузера'
};

const INSTALL_STEPS = {
    ios: [
        'Откройте эту страницу в Safari.',
        'Нажмите «Поделиться» — квадрат со стрелкой вверх.',
        'Выберите «На экран „Домой“» и нажмите «Добавить».'
    ],
    android: [
        'Откройте меню Chrome ⋮ в правом верхнем углу.',
        'Выберите «Установить приложение» или «Добавить на главный экран».',
        'Подтвердите установку.'
    ],
    desktop: [
        'Нажмите значок установки в адресной строке (монитор со стрелкой).',
        'Или откройте меню Chrome ⋮ → «Установить Shelter».',
        'Подтвердите установку.'
    ]
};

export function initPWA() {
    bindInstallButtons();
    registerServiceWorker();

    window.addEventListener('beforeinstallprompt', event => {
        event.preventDefault();
        deferredPrompt = event;
        installAvailable = true;
        setMenuButtonVisible(true);
        showBannerIfAllowed();
    });

    window.addEventListener('appinstalled', () => {
        deferredPrompt = null;
        installAvailable = false;
        hideBanner();
        setMenuButtonVisible(false);
        toast('Shelter установлен. Открывайте игру с главного экрана.', 'success', 6000);
    });

    if (isStandalone()) {
        hideBanner();
        setMenuButtonVisible(false);
        return;
    }

    // Пока игрок заполняет форму, баннер не должен закрывать поля и клавиатуру.
    document.addEventListener('focusin', event => {
        if (event.target && event.target.closest('input, select, textarea')) hideBanner();
    });
    document.addEventListener('focusout', event => {
        if (event.target && event.target.closest('input, select, textarea')) {
            setTimeout(showBannerIfAllowed, 350);
        }
    });

    // На iPhone установка доступна только вручную через Safari, события
    // beforeinstallprompt там нет — показываем подсказку сами.
    if (platformName() === 'ios') {
        installAvailable = true;
        setMenuButtonVisible(true);
        setTimeout(showBannerIfAllowed, 2500);
    }
}

function bindInstallButtons() {
    const bannerButton = $('installAppBtn');
    const dismissButton = $('dismissInstallBtn');
    const menuButton = $('installAppBtnMenu');

    if (bannerButton) bannerButton.addEventListener('click', requestInstall);
    if (menuButton) menuButton.addEventListener('click', requestInstall);
    if (dismissButton) dismissButton.addEventListener('click', dismissBanner);
}

async function requestInstall() {
    if (deferredPrompt) {
        const promptEvent = deferredPrompt;
        deferredPrompt = null;
        try {
            await promptEvent.prompt();
            const choice = await promptEvent.userChoice;
            if (choice && choice.outcome === 'accepted') {
                hideBanner();
                toast('Устанавливаем Shelter…', 'success', 4000);
            } else {
                hideBanner();
            }
        } catch (error) {
            console.warn('Не удалось показать установку', error);
            showInstallHelp();
        } finally {
            installAvailable = false;
            setMenuButtonVisible(false);
        }
        return;
    }

    // Нет отложенного события (iOS, Firefox, повторный запрос) — инструкция.
    showInstallHelp();
}

function showInstallHelp() {
    const platform = platformName();
    const steps = INSTALL_STEPS[platform] || INSTALL_STEPS.desktop;
    const list = $('installHelpSteps');
    if (list) {
        list.innerHTML = steps.map(step => `<li>${step}</li>`).join('');
    }
    const intro = $('installHelpIntro');
    if (intro) {
        intro.textContent = 'Игра появится на главном экране и будет открываться в отдельном окне — без адресной строки.';
    }
    openModal('installHelpModal');
}

function showBannerIfAllowed() {
    if (!installAvailable || isStandalone()) return;
    if (wasDismissedRecently()) return;
    const active = document.activeElement;
    if (active && active.closest && active.closest('input, select, textarea')) return;
    const banner = $('installBanner');
    if (!banner) return;
    const text = $('installBannerText');
    if (text) text.textContent = PLATFORM_TEXT[platformName()] || PLATFORM_TEXT.desktop;
    banner.hidden = false;
}

function hideBanner() {
    const banner = $('installBanner');
    if (banner) banner.hidden = true;
}

function dismissBanner() {
    try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch { /* ignore */ }
    hideBanner();
}

function wasDismissedRecently() {
    try {
        const at = Number(localStorage.getItem(DISMISS_KEY)) || 0;
        return at > 0 && Date.now() - at < DISMISS_DAYS * 24 * 60 * 60 * 1000;
    } catch {
        return false;
    }
}

function setMenuButtonVisible(visible) {
    const button = $('installAppBtnMenu');
    if (button) button.hidden = !visible || isStandalone();
}

function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
    window.addEventListener('load', () => {
        navigator.serviceWorker
            .register(new URL('../sw.js', import.meta.url), { updateViaCache: 'none' })
            .catch(error => console.warn('Service worker не зарегистрирован:', error));
    });
}
