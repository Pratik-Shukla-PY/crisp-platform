"""
Telegram Bot Reply Templates — Multilingual, step-by-step guided flow.
Designed for uneducated users: big emojis, minimal text, one action per message.
Auto-detects language from Telegram user locale.
"""
import os
import logging
import httpx

logger = logging.getLogger(__name__)

BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
API_BASE = f"https://api.telegram.org/bot{BOT_TOKEN}"

# ── Multilingual strings (emoji-first, minimal text) ──────────────────────────
# Key: language code (from Telegram user locale)
# Each message uses large emojis as primary communication — text is secondary

_STRINGS = {
    "en": {
        "welcome_1": "🆘 *CRISP — Emergency Report*",
        "welcome_2": "Report damage to help rescue teams find you.\n\n*3 easy steps:*\n📍 Share location\n📸 Send photo\n✅ Done!\n\n💡 *Quick way:* Send a photo with a caption describing the damage — that's it!",
        "welcome_btn": "🚨 Report Emergency",
        "lang_select": "🌐 *Choose your language:*",
        "step_loc": "📍 *Step 1 of 3:* Share your location\n\nTap the button below so rescue teams can find you 👇",
        "step_loc_btn": "📍 Share My Location",
        "step_loc_done": "✅ Location received!",
        "step_photo": "📸 *Step 2 of 3:* Send evidence\n\n📸 Send a *photo* of the damage\n🎤 Or send a *voice note*\n⌨️ Or *type* what happened\n\n🔒 _Faces will be automatically blurred for privacy_",
        "step_voice": "🎙 Describe what happened\n\nSend a *voice note* 🎤\nor *type* a message ⌨️",
        "step_text": "📝 *Step 3 of 3:* Anything else?\n\nType a message or tap Submit 👇",
        "step_text_skip": "✅ Submit Report",
        "step_type": "🏗 What is damaged?",
        "step_sev": "⚠️ How bad is it?",
        "submitting": "⏳ Sending your report...",
        "done_1": "✅ *Report Sent!*",
        "done_2": "Rescue teams will see this. Thank you. 🙏",
        "done_another_prompt": "👇 *What would you like to do?*",
        "done_add_more": "📎 Add More Details to This Report",
        "done_another": "🚨 Report Another Incident",
        "done_stop": "✅ Done for now",
        "add_more_prompt": "📎 *Send more details for this report:*\n\n📸 Photo · 🎤 Voice note · ⌨️ Text\n\nTap Done when finished 👇",
        "add_more_done": "✅ Done — Details Added",
        "error": "⚠️ Something went wrong. Please try again.",
        "sev_1": "🔴 Very Bad", "sev_2": "🟠 Medium", "sev_3": "🟢 Small",
        "type_road": "🛣 Road", "type_hospital": "🏥 Hospital", "type_house": "🏠 House",
        "type_power": "⚡ Power", "type_water": "💧 Water", "type_other": "❓ Other",
    },
    "hi": {
        "welcome_1": "🆘 *CRISP — आपातकालीन रिपोर्ट*",
        "welcome_2": "बचाव दल को अपना स्थान बताएं।\n\n*3 आसान कदम:*\n📍 स्थान भेजें\n📸 फोटो भेजें\n✅ हो गया!\n\n💡 *तेज़ तरीका:* एक फोटो भेजें और उसके साथ नुकसान की जानकारी लिखें — बस!",
        "welcome_btn": "🚨 आपातकाल रिपोर्ट करें",
        "lang_select": "🌐 *अपनी भाषा चुनें:*",
        "step_loc": "📍 *चरण 1/3:* अपना स्थान भेजें\n\nनीचे बटन दबाएं ताकि बचाव दल आपको ढूंढ सकें 👇",
        "step_loc_btn": "📍 मेरा स्थान भेजें",
        "step_loc_done": "✅ स्थान मिल गया!",
        "step_type": "🏗 क्या टूटा है?",
        "step_sev": "⚠️ कितना बुरा है?",
        "step_photo": "📸 *चरण 2/3:* सबूत भेजें\n\n📸 नुकसान की *फोटो* भेजें\n🎤 या *आवाज़ संदेश* भेजें\n⌨️ या *लिखें* क्या हुआ\n\n🔒 _चेहरे स्वचालित रूप से धुंधले कर दिए जाएंगे_",
        "step_voice": "🎙 क्या हुआ बताएं\n\n🎤 *आवाज़ संदेश* भेजें\nया ⌨️ *लिखें*",
        "step_text": "📝 *चरण 3/3:* कुछ और बताना है?\n\nलिखें या भेजें दबाएं 👇",
        "step_text_skip": "✅ रिपोर्ट भेजें",
        "submitting": "⏳ रिपोर्ट भेज रहे हैं...",
        "done_1": "✅ *रिपोर्ट भेज दी!*",
        "done_2": "बचाव दल इसे देखेंगे। धन्यवाद। 🙏",
        "done_another_prompt": "👇 *आप क्या करना चाहेंगे?*",
        "done_add_more": "📎 इस रिपोर्ट में और जानकारी जोड़ें",
        "done_another": "🚨 नई घटना रिपोर्ट करें",
        "done_stop": "✅ बस हो गया",
        "add_more_prompt": "📎 *इस रिपोर्ट के लिए और जानकारी भेजें:*\n\n📸 फोटो · 🎤 आवाज़ · ⌨️ लिखें\n\nहो जाए तो नीचे दबाएं 👇",
        "add_more_done": "✅ जानकारी जोड़ दी गई",
        "error": "⚠️ कुछ गलत हुआ। फिर से कोशिश करें।",
        "sev_1": "🔴 बहुत बुरा", "sev_2": "🟠 मध्यम", "sev_3": "🟢 थोड़ा",
        "type_road": "🛣 सड़क", "type_hospital": "🏥 अस्पताल", "type_house": "🏠 घर",
        "type_power": "⚡ बिजली", "type_water": "💧 पानी", "type_other": "❓ अन्य",
    },
    "es": {
        "welcome_1": "🆘 *CRISP — Reporte de Emergencia*",
        "welcome_2": "Ayuda a los equipos de rescate.\nTe guiaré paso a paso.",
        "welcome_btn": "🚨 Reportar Emergencia",
        "step_loc": "📍 *Paso 1:* Comparte tu ubicación\n\nToca el botón abajo 👇",
        "step_loc_btn": "📍 Compartir Ubicación",
        "step_loc_done": "✅ ¡Ubicación recibida!",
        "step_type": "🏗 *Paso 2:* ¿Qué se dañó?",
        "step_sev": "⚠️ *Paso 3:* ¿Qué tan grave es?",
        "step_photo": "📸 *Paso 4:* Envía foto del daño 👇\n\n🔒 _Los rostros se difuminarán automáticamente por privacidad_",
        "step_voice": "🎙 *Paso 5:* Describe qué pasó\n\n🎤 *Audio* o ⌨️ *escribe*",
        "step_text": "📝 *Paso 6:* ¿Algo más?\n\nEscribe o envía 👇",
        "step_text_skip": "✅ Enviar Reporte",
        "submitting": "⏳ Enviando reporte...",
        "done_1": "✅ *¡Reporte Enviado!*",
        "done_2": "Los equipos de rescate lo verán. Gracias. 🙏",
        "done_another_prompt": "👇 *¿Necesita reportar otro incidente?*",
        "done_another": "🚨 Reportar Otro Incidente",
        "done_stop": "✅ Listo",
        "error": "⚠️ Algo salió mal. Intenta de nuevo.",
        "sev_1": "🔴 Muy Grave", "sev_2": "🟠 Moderado", "sev_3": "🟢 Leve",
        "type_road": "🛣 Camino", "type_hospital": "🏥 Hospital", "type_house": "🏠 Casa",
        "type_power": "⚡ Luz", "type_water": "💧 Agua", "type_other": "❓ Otro",
    },
    "fr": {
        "welcome_1": "🆘 *CRISP — Rapport d'Urgence*",
        "welcome_2": "Aidez les secours à vous trouver.\nJe vous guide étape par étape.",
        "welcome_btn": "🚨 Signaler une Urgence",
        "step_loc": "📍 *Étape 1:* Partagez votre position\n\nAppuyez ci-dessous 👇",
        "step_loc_btn": "📍 Partager Ma Position",
        "step_loc_done": "✅ Position reçue !",
        "step_type": "🏗 *Étape 2:* Qu'est-ce qui est endommagé ?",
        "step_sev": "⚠️ *Étape 3:* C'est grave comment ?",
        "step_photo": "📸 *Étape 4:* Photo du dégât 👇\n\n🔒 _Les visages seront automatiquement floutés pour la confidentialité_",
        "step_voice": "🎙 *Étape 5:* Décrivez\n\n🎤 *Vocal* ou ⌨️ *écrivez*",
        "step_text": "📝 *Étape 6:* Autre chose ?\n\nÉcrivez ou envoyez 👇",
        "step_text_skip": "✅ Envoyer",
        "submitting": "⏳ Envoi du rapport...",
        "done_1": "✅ *Rapport Envoyé !*",
        "done_2": "Les secours le verront. Merci. 🙏",
        "done_another_prompt": "👇 *Signaler un autre incident ?*",
        "done_another": "🚨 Signaler un Autre Incident",
        "done_stop": "✅ C'est tout",
        "error": "⚠️ Erreur. Réessayez.",
        "sev_1": "🔴 Très Grave", "sev_2": "🟠 Moyen", "sev_3": "🟢 Léger",
        "type_road": "🛣 Route", "type_hospital": "🏥 Hôpital", "type_house": "🏠 Maison",
        "type_power": "⚡ Électricité", "type_water": "💧 Eau", "type_other": "❓ Autre",
    },
    "ar": {
        "welcome_1": "🆘 *CRISP — تقرير طوارئ*",
        "welcome_2": "ساعد فرق الإنقاذ على إيجادك.\nسأرشدك خطوة بخطوة.",
        "welcome_btn": "🚨 الإبلاغ عن طوارئ",
        "step_loc": "📍 *الخطوة 1:* شارك موقعك\n\nاضغط الزر أدناه 👇",
        "step_loc_btn": "📍 مشاركة موقعي",
        "step_loc_done": "✅ تم استلام الموقع!",
        "step_type": "🏗 *الخطوة 2:* ماذا تضرر؟",
        "step_sev": "⚠️ *الخطوة 3:* ما مدى الخطورة؟",
        "step_photo": "📸 *الخطوة 4:* صورة الضرر 👇\n\n🔒 _سيتم تشويش الوجوه تلقائياً للخصوصية_",
        "step_voice": "🎙 *الخطوة 5:* صف ما حدث\n\n🎤 *صوت* أو ⌨️ *اكتب*",
        "step_text": "📝 *الخطوة 6:* شيء آخر؟\n\nاكتب أو أرسل 👇",
        "step_text_skip": "✅ إرسال",
        "submitting": "⏳ جارٍ الإرسال...",
        "done_1": "✅ *تم إرسال التقرير!*",
        "done_2": "فرق الإنقاذ ستراه. شكراً. 🙏",
        "done_another_prompt": "👇 *هل تريد الإبلاغ عن حادث آخر؟*",
        "done_another": "🚨 الإبلاغ عن حادث آخر",
        "done_stop": "✅ انتهيت",
        "error": "⚠️ حدث خطأ. حاول مرة أخرى.",
        "sev_1": "🔴 خطير جداً", "sev_2": "🟠 متوسط", "sev_3": "🟢 بسيط",
        "type_road": "🛣 طريق", "type_hospital": "🏥 مستشفى", "type_house": "🏠 منزل",
        "type_power": "⚡ كهرباء", "type_water": "💧 ماء", "type_other": "❓ آخر",
    },
    "pt": {
        "welcome_1": "🆘 *CRISP — Relatório de Emergência*",
        "welcome_2": "Ajude as equipes de resgate.\nVou te guiar passo a passo.",
        "welcome_btn": "🚨 Relatar Emergência",
        "step_loc": "📍 *Passo 1:* Compartilhe sua localização\n\nToque abaixo 👇",
        "step_loc_btn": "📍 Compartilhar Localização",
        "step_loc_done": "✅ Localização recebida!",
        "step_type": "🏗 *Passo 2:* O que foi danificado?",
        "step_sev": "⚠️ *Passo 3:* Qual a gravidade?",
        "step_photo": "📸 *Passo 4:* Foto do dano 👇\n\n🔒 _Rostos serao automaticamente desfocados para privacidade_",
        "step_voice": "🎙 *Passo 5:* Descreva\n\n🎤 *Áudio* ou ⌨️ *escreva*",
        "step_text": "📝 *Passo 6:* Mais alguma coisa?\n\nDigite ou envie 👇",
        "step_text_skip": "✅ Enviar",
        "submitting": "⏳ Enviando relatório...",
        "done_1": "✅ *Relatório Enviado!*",
        "done_2": "Equipes de resgate verão isso. Obrigado. 🙏",
        "done_another_prompt": "👇 *Precisa relatar outro incidente?*",
        "done_another": "🚨 Relatar Outro",
        "done_stop": "✅ Pronto",
        "error": "⚠️ Erro. Tente novamente.",
        "sev_1": "🔴 Muito Grave", "sev_2": "🟠 Moderado", "sev_3": "🟢 Leve",
        "type_road": "🛣 Estrada", "type_hospital": "🏥 Hospital", "type_house": "🏠 Casa",
        "type_power": "⚡ Energia", "type_water": "💧 Água", "type_other": "❓ Outro",
    },
    "sw": {
        "welcome_1": "🆘 *CRISP — Ripoti Dharura*",
        "welcome_2": "Saidia timu za uokoaji kukupata.\nNitakuongoza hatua kwa hatua.",
        "welcome_btn": "🚨 Ripoti Dharura",
        "step_loc": "📍 *Hatua 1:* Tuma eneo lako\n\nBonyeza kitufe hapo chini 👇",
        "step_loc_btn": "📍 Tuma Eneo Langu",
        "step_loc_done": "✅ Eneo limepokelewa!",
        "step_type": "🏗 *Hatua 2:* Nini kimeharibiwa?",
        "step_sev": "⚠️ *Hatua 3:* Ni mbaya kiasi gani?",
        "step_photo": "📸 *Hatua 4:* Picha ya uharibifu 👇\n\n🔒 _Nyuso zitafichwa kiotomatiki kwa faragha_",
        "step_voice": "🎙 *Hatua 5:* Eleza\n\n🎤 *Sauti* au ⌨️ *andika*",
        "step_text": "📝 *Hatua 6:* Kitu kingine?\n\nAndika au tuma 👇",
        "step_text_skip": "✅ Tuma",
        "submitting": "⏳ Inatuma ripoti...",
        "done_1": "✅ *Ripoti Imetumwa!*",
        "done_2": "Timu za uokoaji wataona. Asante. 🙏",
        "done_another_prompt": "👇 *Unahitaji kuripoti tukio lingine?*",
        "done_another": "🚨 Ripoti Nyingine",
        "done_stop": "✅ Nimemaliza",
        "error": "⚠️ Kuna tatizo. Jaribu tena.",
        "sev_1": "🔴 Mbaya Sana", "sev_2": "🟠 Wastani", "sev_3": "🟢 Kidogo",
        "type_road": "🛣 Barabara", "type_hospital": "🏥 Hospitali", "type_house": "🏠 Nyumba",
        "type_power": "⚡ Umeme", "type_water": "💧 Maji", "type_other": "❓ Nyingine",
    },
    "zh": {
        "welcome_1": "🆘 *CRISP — 紧急报告*",
        "welcome_2": "帮助救援队找到您。\n\n*3个简单步骤:*\n📍 分享位置\n📸 发送照片\n✅ 完成!\n\n💡 *快捷方式:* 发送带说明的照片即可!",
        "welcome_btn": "🚨 报告紧急情况",
        "lang_select": "🌐 *选择语言:*",
        "step_loc": "📍 *第1步/共3步:* 分享您的位置\n\n点击下面的按钮 👇",
        "step_loc_btn": "📍 分享我的位置",
        "step_loc_done": "✅ 已收到位置!",
        "step_type": "🏗 什么损坏了?",
        "step_sev": "⚠️ 严重程度?",
        "step_photo": "📸 *第2步/共3步:* 发送证据\n\n📸 发送损坏*照片*\n🎤 或发送*语音*\n⌨️ 或*输入*描述\n\n🔒 _面部将自动模糊处理以保护隐私_",
        "step_voice": "🎙 描述发生了什么\n\n🎤 发送*语音消息*\n或 ⌨️ *输入文字*",
        "step_text": "📝 *第3步/共3步:* 还有其他要补充的吗?\n\n输入或点击提交 👇",
        "step_text_skip": "✅ 提交报告",
        "submitting": "⏳ 正在发送报告...",
        "done_1": "✅ *报告已发送!*",
        "done_2": "救援队将看到此报告。谢谢。🙏",
        "done_another_prompt": "👇 *您想做什么?*",
        "done_add_more": "📎 为此报告添加更多详情",
        "done_another": "🚨 报告另一个事件",
        "done_stop": "✅ 暂时完成",
        "add_more_prompt": "📎 *发送更多详情:*\n\n📸 照片 · 🎤 语音 · ⌨️ 文字\n\n完成后点击下方 👇",
        "add_more_done": "✅ 已添加详情",
        "error": "⚠️ 出错了。请重试。",
        "sev_1": "🔴 非常严重", "sev_2": "🟠 中等", "sev_3": "🟢 轻微",
        "type_road": "🛣 道路", "type_hospital": "🏥 医院", "type_house": "🏠 房屋",
        "type_power": "⚡ 电力", "type_water": "💧 水", "type_other": "❓ 其他",
    },
    "ru": {
        "welcome_1": "🆘 *CRISP — Экстренный отчет*",
        "welcome_2": "Помогите спасательным командам найти вас.\n\n*3 простых шага:*\n📍 Поделитесь местоположением\n📸 Отправьте фото\n✅ Готово!\n\n💡 *Быстрый способ:* Отправьте фото с описанием!",
        "welcome_btn": "🚨 Сообщить о ЧС",
        "lang_select": "🌐 *Выберите язык:*",
        "step_loc": "📍 *Шаг 1 из 3:* Поделитесь местоположением\n\nНажмите кнопку ниже 👇",
        "step_loc_btn": "📍 Отправить местоположение",
        "step_loc_done": "✅ Местоположение получено!",
        "step_type": "🏗 Что повреждено?",
        "step_sev": "⚠️ Насколько серьезно?",
        "step_photo": "📸 *Шаг 2 из 3:* Отправьте доказательства\n\n📸 *Фото* повреждения\n🎤 Или *голосовое сообщение*\n⌨️ Или *напишите* что произошло\n\n🔒 _Лица будут автоматически размыты для конфиденциальности_",
        "step_voice": "🎙 Опишите что произошло\n\n🎤 *Голосовое* сообщение\nили ⌨️ *напишите*",
        "step_text": "📝 *Шаг 3 из 3:* Что-то ещё?\n\nНапишите или нажмите Отправить 👇",
        "step_text_skip": "✅ Отправить отчет",
        "submitting": "⏳ Отправка отчета...",
        "done_1": "✅ *Отчет отправлен!*",
        "done_2": "Спасательные команды увидят это. Спасибо. 🙏",
        "done_another_prompt": "👇 *Что хотите сделать?*",
        "done_add_more": "📎 Добавить детали к этому отчету",
        "done_another": "🚨 Сообщить о другом инциденте",
        "done_stop": "✅ Пока всё",
        "add_more_prompt": "📎 *Отправьте дополнительные данные:*\n\n📸 Фото · 🎤 Голос · ⌨️ Текст\n\nГотово — нажмите ниже 👇",
        "add_more_done": "✅ Данные добавлены",
        "error": "⚠️ Ошибка. Попробуйте снова.",
        "sev_1": "🔴 Очень серьезно", "sev_2": "🟠 Средне", "sev_3": "🟢 Незначительно",
        "type_road": "🛣 Дорога", "type_hospital": "🏥 Больница", "type_house": "🏠 Дом",
        "type_power": "⚡ Электричество", "type_water": "💧 Вода", "type_other": "❓ Другое",
    },
}

# Map unsupported language codes to the closest supported language
_LANG_FALLBACK = {
    "kn": "hi", "ta": "hi", "te": "hi", "ml": "hi", "mr": "hi",
    "gu": "hi", "pa": "hi", "bn": "hi", "or": "hi", "as": "hi",
    "ur": "hi", "ne": "hi", "si": "hi",
    "am": "sw", "rw": "sw", "so": "sw",
    "de": "en", "it": "en", "nl": "en", "pl": "en", "ro": "en",
    "uk": "ru", "cs": "en", "sk": "en", "hu": "en",
    "bg": "en", "sr": "en", "hr": "en", "sl": "en",
    "sv": "en", "no": "en", "da": "en", "fi": "en",
    "ja": "zh", "ko": "en", "th": "en", "vi": "en",
    "id": "en", "ms": "en", "tl": "en", "km": "en", "lo": "en", "my": "en",
    "tr": "en", "fa": "en", "he": "en", "el": "en",
    "az": "en", "ka": "en", "hy": "en",
}


def t(lang: str, key: str) -> str:
    """Get translated string. Falls back through chain: lang → fallback → English."""
    resolved = lang if lang in _STRINGS else _LANG_FALLBACK.get(lang, "en")
    strings = _STRINGS.get(resolved, _STRINGS["en"])
    return strings.get(key, _STRINGS["en"].get(key, key))


def detect_lang(user: dict) -> str:
    """Detect language from Telegram user's language_code (initial guess before location override)."""
    code = (user.get("language_code") or "en").split("-")[0].lower()
    if code in _STRINGS:
        return code
    return _LANG_FALLBACK.get(code, "en")
    return MAP.get(code, "en")


# ── Send Functions ─────────────────────────────────────────────────────────────

async def _send(method: str, data: dict):
    if not BOT_TOKEN:
        return
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.post(f"{API_BASE}/{method}", json=data)
            if r.status_code != 200:
                logger.warning(f"TG API error ({r.status_code}): {r.text[:200]}")
    except Exception as e:
        logger.error(f"TG send error: {e}")


async def send_text(chat_id: int, text: str, **kwargs):
    data = {"chat_id": chat_id, "text": text, "parse_mode": "Markdown"}
    data.update(kwargs)
    await _send("sendMessage", data)


async def answer_callback(cq_id: str, text: str = ""):
    await _send("answerCallbackQuery", {"callback_query_id": cq_id, "text": text})


# ── Step-by-Step Guided Messages ───────────────────────────────────────────────

async def send_welcome(chat_id: int, lang: str):
    """Send welcome message with language selector + instructions."""
    # First: language selection buttons (always show so user can switch)
    await _send("sendMessage", {
        "chat_id": chat_id,
        "text": f"{t(lang, 'welcome_1')}\n\n{t(lang, 'welcome_2')}",
        "parse_mode": "Markdown",
        "reply_markup": {
            "inline_keyboard": [
                [{"text": t(lang, "welcome_btn"), "callback_data": "start_report"}],
                [
                    {"text": "🇬🇧 English", "callback_data": "lang_en"},
                    {"text": "🇨🇳 中文", "callback_data": "lang_zh"},
                    {"text": "🇷🇺 Русский", "callback_data": "lang_ru"},
                ],
                [
                    {"text": "🇪🇸 Espanol", "callback_data": "lang_es"},
                    {"text": "🇫🇷 Francais", "callback_data": "lang_fr"},
                    {"text": "🇸🇦 عربي", "callback_data": "lang_ar"},
                ],
                [
                    {"text": "🇮🇳 हिन्दी", "callback_data": "lang_hi"},
                    {"text": "🇧🇷 Portugues", "callback_data": "lang_pt"},
                    {"text": "🇰🇪 Kiswahili", "callback_data": "lang_sw"},
                ],
            ]
        },
    })


async def send_step_location(chat_id: int, lang: str):
    await _send("sendMessage", {
        "chat_id": chat_id,
        "text": t(lang, "step_loc"),
        "parse_mode": "Markdown",
        "reply_markup": {
            "keyboard": [[{"text": t(lang, "step_loc_btn"), "request_location": True}]],
            "one_time_keyboard": True,
            "resize_keyboard": True,
        },
    })


async def send_step_photo(chat_id: int, lang: str):
    """Ask for evidence — photo, voice, or text. Any one is enough."""
    await _send("sendMessage", {
        "chat_id": chat_id,
        "text": t(lang, "step_photo"),
        "parse_mode": "Markdown",
        "reply_markup": {
            "inline_keyboard": [
                [{"text": "⌨️ " + t(lang, "step_text_skip").replace("✅ ", ""), "callback_data": "skip_text"}],
                [{"text": "❌ Cancel", "callback_data": "cancel_report"}],
            ],
        },
    })


async def send_step_evidence(chat_id: int, lang: str):
    """Alias for photo step."""
    await send_step_photo(chat_id, lang)


async def send_step_severity(chat_id: int, lang: str):
    await _send("sendMessage", {
        "chat_id": chat_id,
        "text": t(lang, "step_sev"),
        "parse_mode": "Markdown",
        "reply_markup": {
            "inline_keyboard": [
                [
                    {"text": t(lang, "sev_1"), "callback_data": "sev_severe"},
                    {"text": t(lang, "sev_2"), "callback_data": "sev_moderate"},
                    {"text": t(lang, "sev_3"), "callback_data": "sev_minor"},
                ],
                [{"text": "❌ Cancel & Start Over", "callback_data": "cancel_report"}],
            ],
        },
    })


async def send_step_type(chat_id: int, lang: str):
    await _send("sendMessage", {
        "chat_id": chat_id,
        "text": t(lang, "step_type"),
        "parse_mode": "Markdown",
        "reply_markup": {
            "inline_keyboard": [
                [{"text": t(lang, "type_road"), "callback_data": "type_road"},
                 {"text": t(lang, "type_hospital"), "callback_data": "type_hospital"}],
                [{"text": t(lang, "type_house"), "callback_data": "type_house"},
                 {"text": t(lang, "type_power"), "callback_data": "type_power"}],
                [{"text": t(lang, "type_water"), "callback_data": "type_water"},
                 {"text": t(lang, "type_other"), "callback_data": "type_other"}],
                [{"text": "❌ Cancel & Start Over", "callback_data": "cancel_report"}],
            ],
        },
    })


async def send_step_voice(chat_id: int, lang: str):
    """Ask for voice note OR text — one is required."""
    await _send("sendMessage", {
        "chat_id": chat_id,
        "text": t(lang, "step_voice"),
        "parse_mode": "Markdown",
        "reply_markup": {
            "inline_keyboard": [
                [{"text": "❌ Cancel & Start Over", "callback_data": "cancel_report"}],
            ],
        },
    })


async def send_step_text(chat_id: int, lang: str):
    """Ask for optional text description after audio — or skip to submit."""
    await _send("sendMessage", {
        "chat_id": chat_id,
        "text": t(lang, "step_text"),
        "parse_mode": "Markdown",
        "reply_markup": {
            "inline_keyboard": [
                [{"text": t(lang, "step_text_skip"), "callback_data": "skip_text"}],
                [{"text": "❌ Cancel & Start Over", "callback_data": "cancel_report"}],
            ],
        },
    })


async def send_confirmation(chat_id: int, lang: str, report_id: str,
                            infra_type: str, severity: str,
                            lat: float = None, lng: float = None,
                            location_name: str = None,
                            has_photo: bool = False, has_audio: bool = False):
    loc_str = location_name or (f"{lat:.4f}, {lng:.4f}" if lat and lng else "—")

    # Message 1: Confirmation summary
    msg = (
        f"{t(lang, 'done_1')}\n"
        f"━━━━━━━━━━━━━━━━━━━\n\n"
        f"📋 *Type:* {infra_type.replace('_', ' ')}\n"
        f"⚠️ *Severity:* {severity}\n"
        f"📍 *Location:* {loc_str}\n"
        f"📸 *Photo:* {'✅' if has_photo else '❌'}  🎙 *Audio:* {'✅' if has_audio else '❌'}\n"
        f"🆔 *ID:* `{report_id[:12]}...`\n\n"
        f"━━━━━━━━━━━━━━━━━━━\n"
        f"{t(lang, 'done_2')}"
    )
    await _send("sendMessage", {
        "chat_id": chat_id,
        "text": msg,
        "parse_mode": "Markdown",
        "reply_markup": {"remove_keyboard": True},
    })

    # Message 2: Post-submit options (add more / report another / done)
    await _send("sendMessage", {
        "chat_id": chat_id,
        "text": t(lang, "done_another_prompt"),
        "parse_mode": "Markdown",
        "reply_markup": {
            "inline_keyboard": [
                [{"text": t(lang, "done_add_more"), "callback_data": f"add_more:{report_id}"}],
                [{"text": t(lang, "done_another"), "callback_data": "start_report"}],
                [{"text": t(lang, "done_stop"), "callback_data": "stop"}],
            ],
        },
    })


async def send_add_more_prompt(chat_id: int, lang: str):
    """Ask user to send additional details for their existing report."""
    await _send("sendMessage", {
        "chat_id": chat_id,
        "text": t(lang, "add_more_prompt"),
        "parse_mode": "Markdown",
        "reply_markup": {
            "inline_keyboard": [
                [{"text": t(lang, "add_more_done"), "callback_data": "add_more_done"}],
            ],
        },
    })
