// ============================================================================
//  КОНФИГУРАЦИЯ FIREBASE
//  Скопируйте сюда объект firebaseConfig из Firebase Console:
//  Project settings (⚙️) → Your apps → Web app → SDK setup and configuration.
//
//  ВАЖНО: этот файл попадает в публичный репозиторий GitHub Pages.
//  Для веб-приложения Firebase это нормально: доступ защищают Security Rules
//  из database.rules.json. Не вставляйте сюда сервисные ключи (service account).
// ============================================================================

export const firebaseConfig = {
  apiKey: "AIzaSyC8pFCz1HoDcp7H0qZ5gOFxRFhIUF3zc_c",
  authDomain: "Shelter-online.firebaseapp.com",
  databaseURL: "https://shelter-online-default-rtdb.europe-west1.firebasedatabase.app/",
  projectId: "shelter-online",
  storageBucket: "shelter-online.firebasestorage.app",
  messagingSenderId: "7135904726",
  appId: "1:7135904726:web:be6f1e23be7a575cca1a77"
};

function filled(value) {
  const text = String(value || '').trim();
  return !!text && !/^(ВАШ|ВСТАВЬТЕ|YOUR|TODO|xxx)/i.test(text);
}

export const FIREBASE_READY = Boolean(
  filled(firebaseConfig.apiKey) &&
  filled(firebaseConfig.projectId) &&
  filled(firebaseConfig.databaseURL)
);
