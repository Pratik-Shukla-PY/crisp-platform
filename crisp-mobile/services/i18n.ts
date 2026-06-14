/**
 * CRISP i18n - 6 UN languages + Hindi, Portuguese, Swahili.
 * Auto-detects device locale, supports manual override.
 *
 * UNDP §3.1b (Apr 2026) - dense 232-key translation packs live in
 * `./i18n/{locale}.json` (shared format with the PWA at
 * `mobile-app/src/i18n/*.json`). Metro bundler inlines them at build
 * time via native JSON import, so there's no runtime network fetch -
 * the packs are available on first render, including fully offline.
 *
 * Precedence (highest wins): inline `translations` below →
 * UNDP_JSON_PACKS (dense 232-key) → UNDP_I18N_EXTRA (PWA-shared
 * Appendix-1 addenda) → EXTRA_LANG (PWA-shared regional baseline) →
 * EN fallback → raw key. This preserves every legacy key the RN code
 * already references while upgrading any key present in the JSON to
 * the UNDP-aligned, native-speaker-quality translation.
 */
import { getLocales } from 'expo-localization';
import { I18nManager, NativeModules } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

// UNDP Appendix-1 dense packs. `as const` would widen Strings to
// literal-string unions unnecessarily - leave the default `any` import.
// May 2026 - RN ↔ PWA parity Phase 1 (i18n catch-up): expanded from
// 6 (UN-official) → 22 locales to match the PWA. Build-time sync
// from mobile-app/src/i18n/*.json runs via
// scripts/sync-rn-i18n.sh - every JSON below is a copy of the PWA
// canonical source, not hand-edited.
import enJson from './i18n/en.json';
import frJson from './i18n/fr.json';
import esJson from './i18n/es.json';
import arJson from './i18n/ar.json';
import ruJson from './i18n/ru.json';
import zhJson from './i18n/zh.json';
// Tier-2 (UNDP submission set): hi, pt, bn, ja, tr, vi, ko, id, ur
import hiJson from './i18n/hi.json';
import ptJson from './i18n/pt.json';
import bnJson from './i18n/bn.json';
import jaJson from './i18n/ja.json';
import trJson from './i18n/tr.json';
import viJson from './i18n/vi.json';
import koJson from './i18n/ko.json';
import idJson from './i18n/id.json';
import urJson from './i18n/ur.json';
// Tier-3 (Indian sub-national): kn, ta, te, ml, gu, mr, pa
import knJson from './i18n/kn.json';
import taJson from './i18n/ta.json';
import teJson from './i18n/te.json';
import mlJson from './i18n/ml.json';
import guJson from './i18n/gu.json';
import mrJson from './i18n/mr.json';
import paJson from './i18n/pa.json';

// PWA-shared supplemental locale packs. See `services/i18nExtras.ts`
// for inline docs and the canonical merge order. EXTRA_LANG carries a
// minimal baseline for ~35 regional locales; UNDP_I18N_EXTRA carries
// Appendix-1 addenda for the UN locales + Urdu that aren't yet baked
// into the dense JSON packs.
import { EXTRA_LANG, UNDP_I18N_EXTRA } from './i18nExtras';

type Strings = Record<string, string>;

const UNDP_JSON_PACKS: Record<string, any> = {
  // Tier-1 UN-official
  en: enJson, fr: frJson, es: esJson, ar: arJson, ru: ruJson, zh: zhJson,
  // Tier-2 UNDP submission set
  hi: hiJson, pt: ptJson, bn: bnJson, ja: jaJson, tr: trJson,
  vi: viJson, ko: koJson, id: idJson, ur: urJson,
  // Tier-3 Indian sub-national
  kn: knJson, ta: taJson, te: teJson, ml: mlJson, gu: guJson,
  mr: mrJson, pa: paJson,
};

/**
 * Strip the `__meta__` block from a loaded JSON pack so it can't
 * pollute a `t('__meta__')` lookup. Returns a fresh shallow copy.
 */
function _withoutMeta(pack: any): Strings {
  if (!pack || typeof pack !== 'object') return {};
  const { __meta__, ...rest } = pack;
  return rest as Strings;
}

const translations: Record<string, Strings> = {
  en: {
    app_name: 'CRISP Crisis Report',
    consent_title: 'Your Privacy Matters',
    consent_desc: 'CRISP collects only data needed to help rescue teams:',
    consent_loc: 'Location - GPS coordinates',
    consent_photo: 'Photos - damage evidence',
    consent_audio: 'Audio - voice descriptions',
    consent_no_pii: 'No personal identity collected',
    consent_agree: 'I understand and consent',
    // Apr 2026 UX rewrite - landing screen simplified. welcome_sub is now
    // a short, calm line (was a tutorial-style multi-line message).
    welcome_title: 'Report an Incident',
    // Apr 2026 PR 3 - removed the "Tap the button" sub-copy; the big
    // orange CTA communicates the primary action and the offline-hint
    // below it reassures users the tool works in low connectivity.
    welcome_sub: '',
    welcome_start: 'Start Reporting',
    home_metric_reports: 'Reports Submitted',
    home_metric_lives: 'Lives Saved',
    home_offline_hint: '📡 Works offline and in low internet connectivity.',
    my_reports: 'My Reports',
    delete_all_my_reports: 'Delete all my reports',
    delete_all_note: "This removes every report you've sent from this device. Your data will be permanently deleted within 24 hours.",
    // Apr 2026 "My Reports" spec - individual report management.
    report_detail: 'Report', details_label: 'Details',
    delete_this_report: 'Delete this report', rejected_reason: 'Not valid',
    advanced: 'Advanced',
    fp_photo: 'Photo', fp_details: 'Details', fp_review: 'Review', fp_send: 'Send',
    pii_warning: 'Avoid faces or personal documents. Faces will be auto-blurred.',
    photo_title: 'Take a Photo',
    photo_sub: 'Show the damage',
    photo_required: 'Please capture or upload an image to continue',
    camera: 'Camera',
    browse: 'Browse',
    skip: 'Skip',
    next: 'Continue',
    // Apr 2026 UX rewrite - low-literacy crisis copy. Parity with the PWA
    // audio stage (mobile-app/src/index.html:202–244).
    audio_title: 'Tell us what happened',
    audio_sub: 'Speak or type:',
    audio_bullet_1: 'What is damaged? (house, road, people…)',
    audio_bullet_2: 'How bad is it? (small / big / destroyed)',
    audio_bullet_3: 'Is anyone hurt or in danger?',
    audio_example: 'Example: Road is broken and water is flooding houses. 2 people are injured.',
    audio_mic_lang: 'You can speak in your language',
    audio_placeholder: 'Example: House collapsed, one person trapped',
    tap_mic: 'Tap and speak clearly',
    stop: 'Stop',
    type_text: 'Example: House collapsed, one person trapped',
    review_title: 'Review & Submit',
    type_label: 'What is damaged?',
    severity_label: 'How severe?',
    location_label: 'Location',
    description_label: 'Description',
    // PR 6 (Apr 2026): review-form labels. crisis_label reframed to the
    // causal question; damage_label is the inline prompt under the merged
    // infra + severity row.
    crisis_label: 'What caused damage?',
    damage_label: 'How bad?',
    send: 'SEND REPORT',
    sending: 'Sending...',
    // PR 7 (Apr 2026): success screen warmed - "Thank you. Your report can
    // help save lives. We will keep you posted." + primary/secondary actions.
    // new_report kept for back-compat with downstream deep-link flows.
    success_title: 'Thank you.',
    success_sub: 'Your report can help save lives. We will keep you posted.',
    new_report: 'New Report',
    add_another_report: 'Add another report',
    track_report: 'Track your report',
    queued: 'reports queued',
    offline: 'Offline - will sync when connected',
    sev_minor: 'Minor',
    sev_moderate: 'Moderate',
    sev_severe: 'Severe',
    type_road: 'Road',
    type_hospital: 'Hospital',
    type_house: 'House',
    type_power: 'Power',
    type_water: 'Water',
    type_other: 'Other',
    lang_select: 'Language',
    // Apr 2026 i18n-coverage sweep - every RN user-visible string that
    // was previously hardcoded now has a key. Missing translations in
    // other locales fall through to English via the per-key t() chain.
    back: '← Back',
    refresh: '🔄 Refresh',
    edit: '✏️ Edit',
    audio_recorded: '✅ Audio recorded',
    confirm_title: 'Confirm',
    details_title: 'Details',
    incident_title: 'Incident',
    submit: 'Submit',
    service_label: 'Service status',
    needs_label: 'Pressing needs',
    needs_prefix: 'Needs:',
    debris_needed: '🚛 Debris clearing needed',
    svc_electricity: 'Electricity',
    svc_water: 'Water',
    svc_health: 'Health',
    svc_unknown: 'Unknown',
    svc_working: 'Working',
    svc_disrupted: 'Disrupted',
    svc_destroyed: 'Destroyed',
    need_food: 'Food',
    need_water: 'Water',
    need_shelter: 'Shelter',
    need_medical: 'Medical',
    need_security: 'Security',
    take_another_title: 'Photo added ✓',
    take_another_body: 'Take another?',
    take_another_yes: 'Yes',
    take_another_done: 'Done',
    permission_camera: 'Camera access is required to take photos.',
    permission_gallery: 'Gallery access is required.',
    permission_microphone: 'Microphone access is required.',
    permission_needed: 'Permission needed',
    // Apr 2026: image viewer + thumbnail-delete.
    image_delete_btn: 'Delete image',
    image_delete_confirm_title: 'Delete this image?',
    image_delete_confirm_body: 'This image will be removed from your report.',
    image_delete_yes: 'Delete',
    image_delete_cancel: 'Cancel',
    image_close: 'Close',
    sent: '✅ Sent',
    in_queue: '⏳ In queue',
    lives_saved_chip: '💚 Saved',
    // Apr 2026 - review-screen location verify box (UNDP Appendix 1 footprint).
    loc_search_placeholder: 'Type a place name or landmark (optional)',
    loc_resolving: 'Resolving location…',
    // Consent / privacy - additional keys used by <ConsentOverlay>.
    consent_shared: 'Data shared only with crisis responders',
    consent_delete: 'You can request deletion anytime',
    consent_check: 'I understand and consent to sharing this data for crisis response',
    consent_accept: 'Accept & Continue',
    // UNDP building-footprint picker - EN fallback in case a locale
    // hasn't been translated yet.
    building_select_title: 'Optional: pick the exact building',
    building_select_hint: 'Tap a building outline to mark it as damaged.',
    building_selected: 'Building selected',
    // Restart prompt when I18nManager has to flip layout in production.
    restart_required_title: 'Restart required',
    restart_required_body: 'Changing language direction needs an app restart to redraw the UI.',
  },
  zh: {
    app_name: 'CRISP 危机报告',
    welcome_title: '报告紧急情况',
    welcome_sub: '帮助救援队更快响应',
    welcome_start: '开始报告',
    pii_warning: '避免拍摄面部或个人文件。面部将自动模糊。',
    photo_title: '拍照', photo_sub: '展示损坏情况', camera: '相机', browse: '浏览', skip: '跳过', next: '继续',
    audio_title: '告诉我们发生了什么', audio_sub: '说话或输入:', tap_mic: '点击后清晰地说话', stop: '停止',
    audio_bullet_1: '什么受损了？（房屋、道路、人员…）', audio_bullet_2: '严重程度？（小 / 大 / 完全毁坏）',
    audio_bullet_3: '有人受伤或处于危险中吗？',
    audio_example: '示例：道路断裂，水淹房屋。2 人受伤。',
    audio_mic_lang: '您可以用您的语言说话',
    audio_placeholder: '示例：房屋倒塌，一人被困',
    review_title: '审核并提交', send: '发送报告', sending: '发送中...', success_title: '报告已发送!', success_sub: '救援队将查看。谢谢。', new_report: '新报告',
    home_offline_hint: '📡 离线和低网络环境下均可使用。',
    home_metric_reports: '已提交报告', home_metric_lives: '挽救的生命',
    sev_minor: '轻微', sev_moderate: '中等', sev_severe: '严重',
    type_road: '道路', type_hospital: '医院', type_house: '房屋', type_power: '电力', type_water: '水', type_other: '其他',
  },
  ru: {
    app_name: 'CRISP Экстренный отчет',
    welcome_title: 'Сообщить о ЧС', welcome_sub: 'Помогите спасателям', welcome_start: 'НАЧАТЬ',
    pii_warning: 'Не снимайте лица и документы. Лица будут размыты.',
    photo_title: 'Фото', photo_sub: 'Покажите ущерб', camera: 'Камера', browse: 'Обзор', skip: 'Пропустить', next: 'Далее',
    audio_title: 'Опишите ситуацию', audio_sub: 'Запись или текст', tap_mic: 'Записать', stop: 'Стоп',
    review_title: 'Проверка', send: 'ОТПРАВИТЬ', sending: 'Отправка...', success_title: 'Отправлено!', success_sub: 'Спасатели увидят. Спасибо.', new_report: 'Новый отчет',
    home_offline_hint: '📡 Работает офлайн и при слабом интернете.',
    home_metric_reports: 'Отправленные отчёты', home_metric_lives: 'Спасённые жизни',
    sev_minor: 'Незначительно', sev_moderate: 'Средне', sev_severe: 'Серьезно',
    type_road: 'Дорога', type_hospital: 'Больница', type_house: 'Дом', type_power: 'Электричество', type_water: 'Вода', type_other: 'Другое',
  },
  es: {
    app_name: 'CRISP Reporte de Crisis',
    welcome_title: 'Reportar Emergencia', welcome_sub: 'Ayuda a los equipos de rescate', welcome_start: 'INICIAR',
    pii_warning: 'Evite rostros o documentos personales. Los rostros se difuminaran.',
    photo_title: 'Foto', photo_sub: 'Muestre el dano', camera: 'Camara', browse: 'Buscar', skip: 'Saltar', next: 'Continuar',
    audio_title: 'Cuéntenos qué pasó', audio_sub: 'Hable o escriba:', tap_mic: 'Toque y hable claramente', stop: 'Parar',
    audio_bullet_1: '¿Qué está dañado? (casa, carretera, personas…)',
    audio_bullet_2: '¿Qué tan grave? (pequeño / grande / destruido)',
    audio_bullet_3: '¿Hay alguien herido o en peligro?',
    audio_example: 'Ejemplo: La carretera está rota y el agua inunda las casas. 2 personas están heridas.',
    audio_mic_lang: 'Puede hablar en su idioma',
    audio_placeholder: 'Ejemplo: Casa derrumbada, una persona atrapada',
    review_title: 'Revisar', send: 'ENVIAR', sending: 'Enviando...', success_title: 'Enviado!', success_sub: 'El equipo de rescate lo vera. Gracias.', new_report: 'Nuevo reporte',
    home_offline_hint: '📡 Funciona sin conexión y con internet limitado.',
    home_metric_reports: 'Informes enviados', home_metric_lives: 'Vidas salvadas',
    sev_minor: 'Leve', sev_moderate: 'Moderado', sev_severe: 'Grave',
    type_road: 'Camino', type_hospital: 'Hospital', type_house: 'Casa', type_power: 'Electricidad', type_water: 'Agua', type_other: 'Otro',
  },
  fr: {
    app_name: 'CRISP Rapport de Crise',
    welcome_title: 'Signaler une Urgence', welcome_sub: 'Aidez les secours', welcome_start: 'COMMENCER',
    pii_warning: 'Evitez les visages et documents. Les visages seront floutes.',
    photo_title: 'Photo', photo_sub: 'Montrez les degats', camera: 'Camera', browse: 'Parcourir', skip: 'Passer', next: 'Continuer',
    audio_title: "Dites-nous ce qui s'est passé", audio_sub: 'Parlez ou écrivez:', tap_mic: 'Appuyez et parlez clairement', stop: 'Stop',
    audio_bullet_1: "Qu'est-ce qui est endommagé? (maison, route, personnes…)",
    audio_bullet_2: 'Quelle est la gravité? (petit / grand / détruit)',
    audio_bullet_3: 'Quelqu\'un est-il blessé ou en danger?',
    audio_example: "Exemple: La route est cassée et l'eau inonde les maisons. 2 personnes sont blessées.",
    audio_mic_lang: 'Vous pouvez parler dans votre langue',
    audio_placeholder: 'Exemple: Maison effondrée, une personne piégée',
    review_title: 'Verification', send: 'ENVOYER', sending: 'Envoi...', success_title: 'Envoye!', success_sub: 'Les secours verront ceci. Merci.', new_report: 'Nouveau rapport',
    home_offline_hint: '📡 Fonctionne hors ligne et avec une connexion limitée.',
    home_metric_reports: 'Rapports soumis', home_metric_lives: 'Vies sauvées',
    sev_minor: 'Leger', sev_moderate: 'Moyen', sev_severe: 'Grave',
    type_road: 'Route', type_hospital: 'Hopital', type_house: 'Maison', type_power: 'Electricite', type_water: 'Eau', type_other: 'Autre',
  },
  ar: {
    app_name: 'CRISP تقرير الأزمات',
    welcome_title: 'الإبلاغ عن طوارئ', welcome_sub: 'ساعد فرق الإنقاذ', welcome_start: 'ابدأ',
    pii_warning: 'تجنب الوجوه والوثائق. سيتم تشويش الوجوه تلقائياً.',
    photo_title: 'صورة', photo_sub: 'أظهر الضرر', camera: 'كاميرا', browse: 'تصفح', skip: 'تخطي', next: 'متابعة',
    audio_title: 'أخبرنا بما حدث', audio_sub: 'تحدث أو اكتب:', tap_mic: 'اضغط وتحدث بوضوح', stop: 'إيقاف',
    audio_bullet_1: 'ما المتضرر؟ (منزل، طريق، أشخاص…)',
    audio_bullet_2: 'ما مدى السوء؟ (صغير / كبير / مدمر)',
    audio_bullet_3: 'هل هناك جرحى أو في خطر؟',
    audio_example: 'مثال: الطريق مكسور والمياه تغمر المنازل. جريحان.',
    audio_mic_lang: 'يمكنك التحدث بلغتك',
    audio_placeholder: 'مثال: انهار المنزل، شخص محاصر',
    review_title: 'مراجعة', send: 'إرسال', sending: 'جاري الإرسال...', success_title: 'تم الإرسال!', success_sub: 'فرق الإنقاذ ستراه. شكراً.', new_report: 'تقرير جديد',
    home_offline_hint: '📡 يعمل دون اتصال وفي حالات الإنترنت الضعيف.',
    home_metric_reports: 'التقارير المرسلة', home_metric_lives: 'الأرواح المنقذة',
    sev_minor: 'بسيط', sev_moderate: 'متوسط', sev_severe: 'خطير',
    type_road: 'طريق', type_hospital: 'مستشفى', type_house: 'منزل', type_power: 'كهرباء', type_water: 'مياه', type_other: 'آخر',
  },
  hi: {
    app_name: 'CRISP आपातकालीन रिपोर्ट',
    welcome_title: 'आपातकाल रिपोर्ट करें', welcome_sub: 'बचाव दल की मदद करें', welcome_start: 'शुरू करें',
    pii_warning: 'चेहरे या दस्तावेज़ न दिखाएं। चेहरे धुंधले होंगे।',
    photo_title: 'फोटो', photo_sub: 'नुकसान दिखाएं', camera: 'कैमरा', browse: 'फाइल', skip: 'छोड़ें', next: 'आगे बढ़ें',
    audio_title: 'हमें बताएं क्या हुआ', audio_sub: 'बोलें या टाइप करें:', tap_mic: 'साफ़ बोलने के लिए दबाएं', stop: 'रुकें',
    audio_bullet_1: 'क्या नुकसान हुआ है? (घर, सड़क, लोग…)',
    audio_bullet_2: 'कितना बुरा है? (छोटा / बड़ा / पूरी तरह नष्ट)',
    audio_bullet_3: 'क्या कोई घायल है या खतरे में है?',
    audio_example: 'उदाहरण: सड़क टूट गई है और पानी घरों में घुस रहा है। 2 लोग घायल हैं।',
    audio_mic_lang: 'आप अपनी भाषा में बोल सकते हैं',
    audio_placeholder: 'उदाहरण: घर गिर गया, एक व्यक्ति फंसा है',
    review_title: 'जांचें', send: 'भेजें', sending: 'भेज रहे हैं...', success_title: 'भेज दी!', success_sub: 'बचाव दल देखेंगे। धन्यवाद।', new_report: 'नई रिपोर्ट',
    home_offline_hint: '📡 ऑफ़लाइन और कम इंटरनेट कनेक्टिविटी में काम करता है।',
    home_metric_reports: 'कुल रिपोर्टें', home_metric_lives: 'बचाई गई जानें',
    sev_minor: 'थोड़ा', sev_moderate: 'मध्यम', sev_severe: 'गंभीर',
    type_road: 'सड़क', type_hospital: 'अस्पताल', type_house: 'घर', type_power: 'बिजली', type_water: 'पानी', type_other: 'अन्य',
  },
};

/**
 * Resolve the layered dict for a single locale code.
 *
 * Merge order (lowest precedence to highest):
 *   1. EN dense pack                 - baseline so any key exists somewhere.
 *   2. EXTRA_LANG[lang]              - PWA-shared regional minimal pack.
 *   3. UNDP_I18N_EXTRA[lang]         - PWA-shared Appendix-1 addenda.
 *   4. UNDP_JSON_PACKS[lang] dense   - definitive 232-key native-speaker QA pack.
 *   5. inline translations[lang]     - hand-tuned RN-only keys (`app_name`, etc.).
 *
 * Highest wins, so the inline RN-only strings always take priority over
 * the shared PWA material. Dense JSON wins over addenda because it's
 * the definitive native-speaker QA pack.
 */
function getDict(lang: string): Strings {
  const en = _withoutMeta(UNDP_JSON_PACKS.en);
  const extraRegional = EXTRA_LANG[lang] || {};
  const undpAddenda = UNDP_I18N_EXTRA[lang] || {};
  const undpDense = _withoutMeta(UNDP_JSON_PACKS[lang] || {});
  const inline = translations[lang] || {};
  // Highest precedence: inline (hand-tuned for RN-only keys like `app_name`).
  // Dense JSON wins over addenda (it's the definitive native-speaker QA pack).
  return { ...en, ...extraRegional, ...undpAddenda, ...undpDense, ...inline } as Strings;
}

// UNDP §3.1b - materialise the merged dict for every known locale once
// at module-load time. Running this once (rather than at every
// `setLanguage`) keeps `t()` O(1) and avoids re-merging on every
// re-render. The universe of known codes is the union of every dict
// that contributes translations: dense JSON + EXTRA_LANG + UNDP_I18N_EXTRA
// + inline.
const ALL_LOCALE_CODES: string[] = Array.from(new Set([
  ...Object.keys(UNDP_JSON_PACKS),
  ...Object.keys(UNDP_I18N_EXTRA),
  ...Object.keys(EXTRA_LANG),
  ...Object.keys(translations),
]));

for (const code of ALL_LOCALE_CODES) {
  translations[code] = getDict(code);
}

let currentLang = 'en';

export function detectLanguage(): string {
  try {
    const locales = getLocales();
    const code = locales?.[0]?.languageCode || 'en';
    return translations[code] ? code : 'en';
  } catch {
    return 'en';
  }
}

// RTL locale set - matches the PWA's RTL_LANGS constant in mobile-app/src/app.js.
// I18nManager controls the whole JS flexbox system; flipping `.isRTL` only
// takes effect on the NEXT bundle load in React Native, so we persist the
// decision + optionally reload in __DEV__ via DevSettings.reload().
const RTL_LANGS = new Set(['ar', 'ur', 'fa', 'he', 'ps', 'ku', 'sd', 'ug', 'yi']);

/**
 * Apply the text direction for a locale. Returns `true` if I18nManager
 * had to flip - in RN a flip requires a bundle reload to fully
 * re-layout the tree (React Native can't live-swap `isRTL`). Callers
 * can use the return value to surface an "Apps needs to restart"
 * notice to the user.
 *
 * In development mode we call `DevSettings.reload()` automatically so
 * the flip is invisible. In production we leave it to the parent
 * component to show an Alert + let the user tap "Restart".
 */
export function applyTextDirection(code: string): boolean {
  const shouldBeRTL = RTL_LANGS.has(code);
  if (I18nManager.isRTL === shouldBeRTL) return false;
  try {
    I18nManager.allowRTL(shouldBeRTL);
    I18nManager.forceRTL(shouldBeRTL);
  } catch {
    // Some test environments don't expose I18nManager - treat as a no-op.
    return false;
  }
  if (__DEV__) {
    try { NativeModules?.DevSettings?.reload?.(); } catch { /* fall through */ }
  }
  return true;
}

export function isRTLLocale(code: string): boolean {
  return RTL_LANGS.has(code);
}

/**
 * Boot-time language resolver - mirrors the PWA policy at app.js:2287.
 *
 *   1. If `crisp_lang_manual` is in AsyncStorage and points at a known
 *      locale, honour that. The user has previously expressed a choice.
 *   2. Otherwise, auto-detect from the device locale via expo-localization.
 *   3. Otherwise, English.
 *
 * Returns the resolved code. Side-effect: calls setLanguage() (which
 * persists + kicks RTL). Call this ONCE at app mount before rendering
 * any translated strings.
 */
export async function bootstrapLanguage(): Promise<string> {
  try {
    const stored = await AsyncStorage.getItem('crisp_lang_manual');
    if (stored && translations[stored]) {
      setLanguage(stored);
      return stored;
    }
  } catch { /* AsyncStorage might be unavailable - fall through */ }
  const detected = detectLanguage();
  setLanguage(detected);
  return detected;
}

export function setLanguage(code: string) {
  const resolved = translations[code] ? code : 'en';
  currentLang = resolved;
  // Persist + kick RTL flip. Persist key matches the PWA's
  // `crisp_lang_manual` localStorage convention so the two surfaces
  // could theoretically share a backend-sync'd preference in future.
  try { AsyncStorage.setItem('crisp_lang_manual', resolved); } catch { /* best-effort */ }
  applyTextDirection(resolved);
}

export function getLanguage(): string {
  return currentLang;
}

export function t(key: string): string {
  return translations[currentLang]?.[key] || translations.en?.[key] || key;
}

export type LanguageOption = {
  code: string;
  label: string;
  flag: string;
  /** True for UNDP-mandated UN official languages - rendered prominently
   *  in the picker per §3.1 UX rewrite (larger flag glyph + dedicated
   *  section header). Parity with the PWA's `.lpf-un` tile treatment. */
  un: boolean;
};

/** UN official language codes - drive the `.un` flag on each emitted
 *  LanguageOption and the picker's two-section layout. */
const UN_LANG_CODES = new Set(['en', 'fr', 'es', 'ar', 'ru', 'zh']);

/** Per-code display metadata for the picker. Every code ever present
 *  in UNDP_JSON_PACKS / UNDP_I18N_EXTRA / EXTRA_LANG / inline should
 *  have an entry here; any missing code falls back to `{code, code, ''}`
 *  so the picker still renders a minimally-usable row. */
const LANG_META: Record<string, { label: string; flag: string }> = {
  en: { label: 'English',      flag: '🇬🇧' },
  fr: { label: 'Français',     flag: '🇫🇷' },
  es: { label: 'Español',      flag: '🇪🇸' },
  ar: { label: 'العربية',      flag: '🇸🇦' },
  ru: { label: 'Русский',      flag: '🇷🇺' },
  zh: { label: '中文',          flag: '🇨🇳' },
  hi: { label: 'हिन्दी',          flag: '🇮🇳' },
  bn: { label: 'বাংলা',         flag: '🇧🇩' },
  pa: { label: 'ਪੰਜਾਬੀ',         flag: '🇮🇳' },
  ml: { label: 'മലയാളം',       flag: '🇮🇳' },
  te: { label: 'తెలుగు',        flag: '🇮🇳' },
  mr: { label: 'मराठी',          flag: '🇮🇳' },
  gu: { label: 'ગુજરાતી',       flag: '🇮🇳' },
  ne: { label: 'नेपाली',         flag: '🇳🇵' },
  ur: { label: 'اردو',          flag: '🇵🇰' },
  pt: { label: 'Português',    flag: '🇵🇹' },
  de: { label: 'Deutsch',      flag: '🇩🇪' },
  it: { label: 'Italiano',     flag: '🇮🇹' },
  tr: { label: 'Türkçe',       flag: '🇹🇷' },
  uk: { label: 'Українська',   flag: '🇺🇦' },
  ja: { label: '日本語',        flag: '🇯🇵' },
  ko: { label: '한국어',        flag: '🇰🇷' },
  am: { label: 'አማርኛ',         flag: '🇪🇹' },
  sw: { label: 'Kiswahili',    flag: '🇰🇪' },
  th: { label: 'ไทย',          flag: '🇹🇭' },
  vi: { label: 'Tiếng Việt',   flag: '🇻🇳' },
  id: { label: 'Bahasa Indonesia', flag: '🇮🇩' },
  ms: { label: 'Bahasa Melayu',    flag: '🇲🇾' },
  km: { label: 'ខ្មែរ',          flag: '🇰🇭' },
  fa: { label: 'فارسی',        flag: '🇮🇷' },
  my: { label: 'မြန်မာ',        flag: '🇲🇲' },
  pl: { label: 'Polski',       flag: '🇵🇱' },
  ro: { label: 'Română',       flag: '🇷🇴' },
  so: { label: 'Soomaali',     flag: '🇸🇴' },
  si: { label: 'සිංහල',        flag: '🇱🇰' },
  he: { label: 'עברית',        flag: '🇮🇱' },
  el: { label: 'Ελληνικά',     flag: '🇬🇷' },
};

/** Returns the flat list of available languages, UN-first then others.
 *  Callers wanting the two-section layout can partition on `.un`.
 *
 *  Dynamically unions every locale present in any of: UNDP_JSON_PACKS,
 *  UNDP_I18N_EXTRA, EXTRA_LANG, or inline `translations`. UN locales
 *  are emitted first in the canonical UNDP order, then the remainder
 *  alphabetically by code. */
export function getAvailableLanguages(): LanguageOption[] {
  // Canonical UN ordering per UNDP §3.1 UX spec.
  const UN_ORDER = ['en', 'fr', 'es', 'ar', 'ru', 'zh'];
  const allCodes = new Set<string>([
    ...Object.keys(UNDP_JSON_PACKS),
    ...Object.keys(UNDP_I18N_EXTRA),
    ...Object.keys(EXTRA_LANG),
    ...Object.keys(translations),
  ]);
  const otherCodes = Array.from(allCodes)
    .filter((c) => !UN_LANG_CODES.has(c))
    .sort();
  const ordered = [...UN_ORDER.filter((c) => allCodes.has(c)), ...otherCodes];
  return ordered.map((code) => {
    const meta = LANG_META[code] || { label: code, flag: '' };
    return { code, label: meta.label, flag: meta.flag, un: UN_LANG_CODES.has(code) };
  });
}

/** Convenience helper for the picker UI. */
export function getGroupedLanguages() {
  const all = getAvailableLanguages();
  return {
    un: all.filter((l) => l.un),
    other: all.filter((l) => !l.un),
  };
}
