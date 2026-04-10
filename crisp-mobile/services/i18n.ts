/**
 * CRISP i18n — 6 UN languages + Hindi, Portuguese, Swahili.
 * Auto-detects device locale, supports manual override.
 */
import { getLocales } from 'expo-localization';

type Strings = Record<string, string>;

const translations: Record<string, Strings> = {
  en: {
    app_name: 'CRISP Crisis Report',
    consent_title: 'Your Privacy Matters',
    consent_desc: 'CRISP collects only data needed to help rescue teams:',
    consent_loc: 'Location — GPS coordinates',
    consent_photo: 'Photos — damage evidence',
    consent_audio: 'Audio — voice descriptions',
    consent_no_pii: 'No personal identity collected',
    consent_agree: 'I understand and consent',
    welcome_title: 'Report an Emergency',
    welcome_sub: 'Help rescue teams respond faster',
    welcome_start: 'START REPORT',
    pii_warning: 'Avoid faces or personal documents. Faces will be auto-blurred.',
    photo_title: 'Take a Photo',
    photo_sub: 'Show the damage',
    camera: 'Camera',
    browse: 'Browse',
    skip: 'Skip',
    next: 'Next',
    audio_title: 'Describe What Happened',
    audio_sub: 'Record your voice or type',
    tap_mic: 'Tap to Record',
    stop: 'Stop',
    type_text: 'Or type here...',
    review_title: 'Review & Submit',
    type_label: 'What is damaged?',
    severity_label: 'How severe?',
    location_label: 'Location',
    description_label: 'Description',
    send: 'SEND REPORT',
    sending: 'Sending...',
    success_title: 'Report Sent!',
    success_sub: 'Rescue teams will see this. Thank you.',
    new_report: 'Report Another',
    queued: 'reports queued',
    offline: 'Offline — will sync when connected',
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
  },
  zh: {
    app_name: 'CRISP 危机报告',
    welcome_title: '报告紧急情况',
    welcome_sub: '帮助救援队更快响应',
    welcome_start: '开始报告',
    pii_warning: '避免拍摄面部或个人文件。面部将自动模糊。',
    photo_title: '拍照', photo_sub: '展示损坏情况', camera: '相机', browse: '浏览', skip: '跳过', next: '下一步',
    audio_title: '描述情况', audio_sub: '录音或输入', tap_mic: '点击录音', stop: '停止',
    review_title: '审核并提交', send: '发送报告', sending: '发送中...', success_title: '报告已发送!', success_sub: '救援队将查看。谢谢。', new_report: '新报告',
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
    sev_minor: 'Незначительно', sev_moderate: 'Средне', sev_severe: 'Серьезно',
    type_road: 'Дорога', type_hospital: 'Больница', type_house: 'Дом', type_power: 'Электричество', type_water: 'Вода', type_other: 'Другое',
  },
  es: {
    app_name: 'CRISP Reporte de Crisis',
    welcome_title: 'Reportar Emergencia', welcome_sub: 'Ayuda a los equipos de rescate', welcome_start: 'INICIAR',
    pii_warning: 'Evite rostros o documentos personales. Los rostros se difuminaran.',
    photo_title: 'Foto', photo_sub: 'Muestre el dano', camera: 'Camara', browse: 'Buscar', skip: 'Saltar', next: 'Siguiente',
    audio_title: 'Describa que paso', audio_sub: 'Grabe o escriba', tap_mic: 'Grabar', stop: 'Parar',
    review_title: 'Revisar', send: 'ENVIAR', sending: 'Enviando...', success_title: 'Enviado!', success_sub: 'El equipo de rescate lo vera. Gracias.', new_report: 'Nuevo reporte',
    sev_minor: 'Leve', sev_moderate: 'Moderado', sev_severe: 'Grave',
    type_road: 'Camino', type_hospital: 'Hospital', type_house: 'Casa', type_power: 'Electricidad', type_water: 'Agua', type_other: 'Otro',
  },
  fr: {
    app_name: 'CRISP Rapport de Crise',
    welcome_title: 'Signaler une Urgence', welcome_sub: 'Aidez les secours', welcome_start: 'COMMENCER',
    pii_warning: 'Evitez les visages et documents. Les visages seront floutes.',
    photo_title: 'Photo', photo_sub: 'Montrez les degats', camera: 'Camera', browse: 'Parcourir', skip: 'Passer', next: 'Suivant',
    audio_title: 'Decrivez la situation', audio_sub: 'Enregistrez ou ecrivez', tap_mic: 'Enregistrer', stop: 'Stop',
    review_title: 'Verification', send: 'ENVOYER', sending: 'Envoi...', success_title: 'Envoye!', success_sub: 'Les secours verront ceci. Merci.', new_report: 'Nouveau rapport',
    sev_minor: 'Leger', sev_moderate: 'Moyen', sev_severe: 'Grave',
    type_road: 'Route', type_hospital: 'Hopital', type_house: 'Maison', type_power: 'Electricite', type_water: 'Eau', type_other: 'Autre',
  },
  ar: {
    app_name: 'CRISP تقرير الأزمات',
    welcome_title: 'الإبلاغ عن طوارئ', welcome_sub: 'ساعد فرق الإنقاذ', welcome_start: 'ابدأ',
    pii_warning: 'تجنب الوجوه والوثائق. سيتم تشويش الوجوه تلقائياً.',
    photo_title: 'صورة', photo_sub: 'أظهر الضرر', camera: 'كاميرا', browse: 'تصفح', skip: 'تخطي', next: 'التالي',
    audio_title: 'صف ما حدث', audio_sub: 'سجل أو اكتب', tap_mic: 'تسجيل', stop: 'إيقاف',
    review_title: 'مراجعة', send: 'إرسال', sending: 'جاري الإرسال...', success_title: 'تم الإرسال!', success_sub: 'فرق الإنقاذ ستراه. شكراً.', new_report: 'تقرير جديد',
    sev_minor: 'بسيط', sev_moderate: 'متوسط', sev_severe: 'خطير',
    type_road: 'طريق', type_hospital: 'مستشفى', type_house: 'منزل', type_power: 'كهرباء', type_water: 'مياه', type_other: 'آخر',
  },
  hi: {
    app_name: 'CRISP आपातकालीन रिपोर्ट',
    welcome_title: 'आपातकाल रिपोर्ट करें', welcome_sub: 'बचाव दल की मदद करें', welcome_start: 'शुरू करें',
    pii_warning: 'चेहरे या दस्तावेज़ न दिखाएं। चेहरे धुंधले होंगे।',
    photo_title: 'फोटो', photo_sub: 'नुकसान दिखाएं', camera: 'कैमरा', browse: 'फाइल', skip: 'छोड़ें', next: 'आगे',
    audio_title: 'बताएं क्या हुआ', audio_sub: 'बोलें या लिखें', tap_mic: 'बोलें', stop: 'रुकें',
    review_title: 'जांचें', send: 'भेजें', sending: 'भेज रहे हैं...', success_title: 'भेज दी!', success_sub: 'बचाव दल देखेंगे। धन्यवाद।', new_report: 'नई रिपोर्ट',
    sev_minor: 'थोड़ा', sev_moderate: 'मध्यम', sev_severe: 'गंभीर',
    type_road: 'सड़क', type_hospital: 'अस्पताल', type_house: 'घर', type_power: 'बिजली', type_water: 'पानी', type_other: 'अन्य',
  },
};

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

export function setLanguage(code: string) {
  currentLang = translations[code] ? code : 'en';
}

export function getLanguage(): string {
  return currentLang;
}

export function t(key: string): string {
  return translations[currentLang]?.[key] || translations.en?.[key] || key;
}

export function getAvailableLanguages() {
  return [
    { code: 'en', label: 'English', flag: '🇬🇧' },
    { code: 'zh', label: '中文', flag: '🇨🇳' },
    { code: 'ru', label: 'Русский', flag: '🇷🇺' },
    { code: 'es', label: 'Español', flag: '🇪🇸' },
    { code: 'fr', label: 'Français', flag: '🇫🇷' },
    { code: 'ar', label: 'العربية', flag: '🇸🇦' },
    { code: 'hi', label: 'हिन्दी', flag: '🇮🇳' },
  ];
}
