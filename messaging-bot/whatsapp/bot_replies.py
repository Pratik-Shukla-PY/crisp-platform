"""
WhatsApp Bot Reply Templates - Multilingual guided prompts (6 UN languages + local).
Uses WhatsApp Cloud API. Language detected from phone country prefix.
"""
import os
import logging
import httpx

logger = logging.getLogger(__name__)

GRAPH_API = "https://graph.facebook.com/v19.0"
PHONE_ID = os.getenv("WHATSAPP_PHONE_NUMBER_ID", "")
TOKEN = os.getenv("WHATSAPP_ACCESS_TOKEN", "")

# ── Multilingual strings (6 UN + Hindi, Portuguese, Swahili) ────────────────
_STRINGS = {
    "en": {
        "pack_multi_hint_wa": "Reply with the numbers that apply (e.g. 1 3), then send 0 when done.",
        "pack_other_prompt": "Please reply with your other pressing need.",
        "welcome": "🆘 *CRISP - Crisis Report Bot*\n\nReport damage in 3 steps:\n📍 Share location\n📸 Send photo\n✅ Done!\n\n💡 Or just send a photo with a caption.\n\nReply LANG to change language.\n🔒 _Faces auto-blurred for privacy_",
        "sev_prompt": "How severe is the damage?",
        "type_prompt": "What type of infrastructure is affected?",
        "loc_request": "📍 Share your location so rescue teams can find it.\n\nTap 📎 → Location → Send Current Location.",
        "ack_image": "📸 Photo received! 🔒 Faces will be auto-blurred.",
        "ack_audio": "🎙 Voice note received!",
        "ack_text": "📝 Text noted.",
        "ack_location": "📍 Location received!",
        "confirmation": "✅ *Report Submitted!*\n\nRescue teams will see this. Thank you. 🙏\n🔒 _Your data is anonymized._",
        "lang_menu": "🌐 Choose your language:\n\n1. English\n2. 中文\n3. Русский\n4. Espanol\n5. Francais\n6. العربية\n7. हिन्दी\n\nReply with the number.",
    },
    "zh": {
        "pack_multi_hint_wa": "回复适用的编号（例如 1 3），完成后发送 0。",
        "pack_other_prompt": "请回复您的其他迫切需求。",
        "welcome": "🆘 *CRISP - 危机报告*\n\n3步报告损失:\n📍 分享位置\n📸 发送照片\n✅ 完成!\n\n回复 LANG 更改语言\n🔒 _面部自动模糊_",
        "sev_prompt": "损坏严重程度?",
        "type_prompt": "哪种基础设施受损?",
        "loc_request": "📍 分享位置帮助救援队。\n\n点击 📎 → 位置 → 发送当前位置。",
        "ack_image": "📸 照片已收到! 🔒 面部将自动模糊。",
        "ack_audio": "🎙 语音已收到!",
        "ack_text": "📝 已记录。",
        "ack_location": "📍 位置已收到!",
        "confirmation": "✅ *报告已提交!*\n\n救援队将查看。谢谢。🙏\n🔒 _数据已匿名化_",
        "lang_menu": "🌐 选择语言:\n\n1. English\n2. 中文\n3. Русский\n4. Espanol\n5. Francais\n6. العربية\n7. हिन्दी\n\n回复数字。",
    },
    "ru": {
        "pack_multi_hint_wa": "Отправьте подходящие номера (напр. 1 3), затем отправьте 0 для завершения.",
        "pack_other_prompt": "Опишите вашу другую насущную потребность.",
        "welcome": "🆘 *CRISP - Экстренный отчет*\n\n3 шага:\n📍 Местоположение\n📸 Фото\n✅ Готово!\n\nОтветьте LANG для смены языка\n🔒 _Лица размываются автоматически_",
        "sev_prompt": "Насколько серьезно повреждение?",
        "type_prompt": "Какая инфраструктура повреждена?",
        "loc_request": "📍 Поделитесь местоположением.\n\n📎 → Геолокация → Отправить.",
        "ack_image": "📸 Фото получено! 🔒 Лица будут размыты.",
        "ack_audio": "🎙 Голосовое получено!",
        "ack_text": "📝 Записано.",
        "ack_location": "📍 Местоположение получено!",
        "confirmation": "✅ *Отчет отправлен!*\n\nСпасатели увидят. Спасибо. 🙏\n🔒 _Данные анонимизированы_",
        "lang_menu": "🌐 Выберите язык:\n\n1. English\n2. 中文\n3. Русский\n4. Espanol\n5. Francais\n6. العربية\n7. हिन्दी\n\nОтветьте цифрой.",
    },
    "es": {
        "pack_multi_hint_wa": "Responda con los números que correspondan (p. ej. 1 3) y envíe 0 al terminar.",
        "pack_other_prompt": "Responda con su otra necesidad urgente.",
        "welcome": "🆘 *CRISP - Reporte de Crisis*\n\n3 pasos:\n📍 Ubicacion\n📸 Foto\n✅ Listo!\n\nResponde LANG para cambiar idioma\n🔒 _Rostros se difuminan automaticamente_",
        "sev_prompt": "¿Que tan grave es el dano?",
        "type_prompt": "¿Que infraestructura esta afectada?",
        "loc_request": "📍 Comparte tu ubicacion.\n\n📎 → Ubicacion → Enviar ubicacion actual.",
        "ack_image": "📸 Foto recibida! 🔒 Rostros seran difuminados.",
        "ack_audio": "🎙 Nota de voz recibida!",
        "ack_text": "📝 Texto anotado.",
        "ack_location": "📍 Ubicacion recibida!",
        "confirmation": "✅ *Reporte enviado!*\n\nEquipos de rescate lo veran. Gracias. 🙏\n🔒 _Datos anonimizados_",
        "lang_menu": "🌐 Elige idioma:\n\n1. English\n2. 中文\n3. Русский\n4. Espanol\n5. Francais\n6. العربية\n7. हिन्दी\n\nResponde con el numero.",
    },
    "fr": {
        "pack_multi_hint_wa": "Répondez avec les numéros qui s'appliquent (ex. 1 3), puis envoyez 0 pour terminer.",
        "pack_other_prompt": "Veuillez indiquer votre autre besoin urgent.",
        "welcome": "🆘 *CRISP - Rapport de Crise*\n\n3 etapes:\n📍 Position\n📸 Photo\n✅ Fini!\n\nRepondez LANG pour changer de langue\n🔒 _Visages floutes automatiquement_",
        "sev_prompt": "Quelle est la gravite?",
        "type_prompt": "Quel type d'infrastructure est touche?",
        "loc_request": "📍 Partagez votre position.\n\n📎 → Position → Envoyer la position.",
        "ack_image": "📸 Photo recue! 🔒 Visages seront floutes.",
        "ack_audio": "🎙 Message vocal recu!",
        "ack_text": "📝 Texte note.",
        "ack_location": "📍 Position recue!",
        "confirmation": "✅ *Rapport envoye!*\n\nLes secours le verront. Merci. 🙏\n🔒 _Donnees anonymisees_",
        "lang_menu": "🌐 Choisissez la langue:\n\n1. English\n2. 中文\n3. Русский\n4. Espanol\n5. Francais\n6. العربية\n7. हिन्दी\n\nRepondez avec le numero.",
    },
    "ar": {
        "pack_multi_hint_wa": "أرسل الأرقام المناسبة (مثل 1 3)، ثم أرسل 0 عند الانتهاء.",
        "pack_other_prompt": "يُرجى إرسال حاجتك الملحّة الأخرى.",
        "welcome": "🆘 *CRISP - تقرير الأزمات*\n\n3 خطوات:\n📍 الموقع\n📸 صورة\n✅ تم!\n\nأرسل LANG لتغيير اللغة\n🔒 _يتم تشويش الوجوه تلقائياً_",
        "sev_prompt": "ما مدى خطورة الضرر؟",
        "type_prompt": "ما نوع البنية التحتية المتضررة؟",
        "loc_request": "📍 شارك موقعك.\n\n📎 ← الموقع ← إرسال الموقع الحالي.",
        "ack_image": "📸 تم استلام الصورة! 🔒 سيتم تشويش الوجوه.",
        "ack_audio": "🎙 تم استلام الرسالة الصوتية!",
        "ack_text": "📝 تم تسجيل النص.",
        "ack_location": "📍 تم استلام الموقع!",
        "confirmation": "✅ *تم إرسال التقرير!*\n\nفرق الإنقاذ ستراه. شكراً. 🙏\n🔒 _البيانات مجهولة الهوية_",
        "lang_menu": "🌐 اختر اللغة:\n\n1. English\n2. 中文\n3. Русский\n4. Espanol\n5. Francais\n6. العربية\n7. हिन्दी\n\nأرسل الرقم.",
    },
    "hi": {
        "welcome": "🆘 *CRISP - आपातकालीन रिपोर्ट*\n\n3 आसान कदम:\n📍 स्थान भेजें\n📸 फोटो भेजें\n✅ हो गया!\n\nLANG भेजें भाषा बदलने के लिए\n🔒 _चेहरे स्वचालित रूप से धुंधले होंगे_",
        "sev_prompt": "नुकसान कितना गंभीर है?",
        "type_prompt": "किस प्रकार का ढांचा प्रभावित है?",
        "loc_request": "📍 अपना स्थान भेजें।\n\n📎 → स्थान → वर्तमान स्थान भेजें।",
        "ack_image": "📸 फोटो मिल गई! 🔒 चेहरे धुंधले कर दिए जाएंगे।",
        "ack_audio": "🎙 आवाज़ संदेश मिला!",
        "ack_text": "📝 लिखा गया।",
        "ack_location": "📍 स्थान मिल गया!",
        "confirmation": "✅ *रिपोर्ट भेज दी!*\n\nबचाव दल इसे देखेंगे। धन्यवाद। 🙏\n🔒 _डेटा गुमनाम है_",
        "lang_menu": "🌐 भाषा चुनें:\n\n1. English\n2. 中文\n3. Русский\n4. Espanol\n5. Francais\n6. العربية\n7. हिन्दी\n\nनंबर भेजें।",
    },
}

# Phone prefix → language mapping
_PHONE_LANG = {
    "86": "zh", "852": "zh", "853": "zh", "886": "zh",       # China, HK, Macau, Taiwan
    "7": "ru",                                                  # Russia
    "34": "es", "52": "es", "54": "es", "57": "es", "56": "es", "51": "es",  # Spain, LatAm
    "33": "fr", "32": "fr", "41": "fr",                        # France, Belgium, Switzerland
    "212": "ar", "966": "ar", "971": "ar", "20": "ar", "213": "ar",  # Arab countries
    "91": "hi",                                                  # India
    "1": "en", "44": "en", "61": "en", "64": "en",             # US, UK, AU, NZ
}

_LANG_BY_NUMBER = {"1": "en", "2": "zh", "3": "ru", "4": "es", "5": "fr", "6": "ar", "7": "hi"}


def detect_lang_from_phone(phone: str) -> str:
    """Detect language from phone number country prefix."""
    clean = phone.lstrip('+').replace(' ', '').replace('-', '')
    for prefix in sorted(_PHONE_LANG.keys(), key=len, reverse=True):
        if clean.startswith(prefix):
            return _PHONE_LANG[prefix]
    return "en"


def t(lang: str, key: str) -> str:
    """Get translated string. Fallback to English."""
    return _STRINGS.get(lang, _STRINGS["en"]).get(key, _STRINGS["en"].get(key, ""))


def parse_lang_selection(text: str) -> str:
    """Parse language selection from user reply (number or LANG keyword)."""
    text = text.strip().upper()
    if text in ("LANG", "LANGUAGE", "IDIOMA", "LANGUE", "BHASHA", "语言", "ЯЗЫК"):
        return "__SHOW_MENU__"
    if text in _LANG_BY_NUMBER:
        return _LANG_BY_NUMBER[text]
    return ""


def _headers():
    return {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}


async def send_text(to: str, text: str):
    """Send a plain text message."""
    url = f"{GRAPH_API}/{PHONE_ID}/messages"
    payload = {"messaging_product": "whatsapp", "to": to, "type": "text", "text": {"body": text}}
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.post(url, json=payload, headers=_headers())
            if r.status_code != 200:
                logger.warning(f"WhatsApp send failed ({r.status_code}): {r.text[:200]}")
    except Exception as e:
        logger.error(f"WhatsApp send error: {e}")


async def send_severity_prompt(to: str, lang: str = "en"):
    url = f"{GRAPH_API}/{PHONE_ID}/messages"
    payload = {
        "messaging_product": "whatsapp", "to": to, "type": "interactive",
        "interactive": {
            "type": "button",
            "body": {"text": t(lang, "sev_prompt")},
            "action": {"buttons": [
                {"type": "reply", "reply": {"id": "sev_severe", "title": "🔴 Severe"}},
                {"type": "reply", "reply": {"id": "sev_moderate", "title": "🟠 Moderate"}},
                {"type": "reply", "reply": {"id": "sev_minor", "title": "🟢 Minor"}},
            ]},
        },
    }
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            await c.post(url, json=payload, headers=_headers())
    except Exception as e:
        logger.error(f"Severity prompt error: {e}")


async def send_type_prompt(to: str, lang: str = "en"):
    url = f"{GRAPH_API}/{PHONE_ID}/messages"
    payload = {
        "messaging_product": "whatsapp", "to": to, "type": "interactive",
        "interactive": {
            "type": "list",
            "body": {"text": t(lang, "type_prompt")},
            "action": {
                "button": "Select",
                "sections": [{"title": "Infrastructure", "rows": [
                    {"id": "type_road", "title": "🛣 Road / Bridge"},
                    {"id": "type_hospital", "title": "🏥 Hospital"},
                    {"id": "type_house", "title": "🏠 House"},
                    {"id": "type_power", "title": "⚡ Power"},
                    {"id": "type_water", "title": "💧 Water"},
                    {"id": "type_other", "title": "❓ Other"},
                ]}],
            },
        },
    }
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            await c.post(url, json=payload, headers=_headers())
    except Exception as e:
        logger.error(f"Type prompt error: {e}")


async def send_location_request(to: str, lang: str = "en"):
    await send_text(to, t(lang, "loc_request"))


async def send_confirmation(to: str, report_id: str, infra_type: str, severity: str,
                            lat=None, lng=None, has_photo=False, has_audio=False, lang="en"):
    await send_text(to, t(lang, "confirmation") + f"\n\n🆔 {report_id[:12]}...")


async def send_welcome(to: str, lang: str = "en"):
    await send_text(to, t(lang, "welcome"))


async def send_lang_menu(to: str, lang: str = "en"):
    await send_text(to, t(lang, "lang_menu"))


async def send_received_ack(to: str, media_type: str, lang: str = "en"):
    key = f"ack_{media_type}"
    await send_text(to, t(lang, key) if t(lang, key) else "✓")
