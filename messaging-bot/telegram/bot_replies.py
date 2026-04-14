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
        "welcome_1": "🆘 *HELP! Report Damage*",
        "welcome_2": "Tell us what is broken.\nWe will send help.\n\n👇 Press the button below",
        "welcome_btn": "🚨 I NEED HELP",
        "lang_select": "🌐 *Pick your language:*",
        "step_loc": "📍 *Where are you?*\n\n👇 Press the button to send your location",
        "step_loc_btn": "📍 Send My Location",
        "step_loc_done": "✅ Got it!",
        "step_photo": "📸 *Show us the damage*\n\n📸 Take a *photo* and send it\n🎤 Or send a *voice message*\n⌨️ Or *write* what happened\n\n🔒 _Faces are hidden for safety_",
        "step_voice": "🎙 *Tell us what happened*\n\n🎤 Hold and talk\nor ⌨️ Write it",
        "step_text": "📝 *Anything else to add?*\n\nWrite more or press Send 👇",
        "step_text_skip": "✅ SEND",
        "step_type": "🏗 What is broken?",
        "step_sev": "⚠️ How bad?",
        "submitting": "⏳ Sending...",
        "done_1": "✅ *Sent!*",
        "done_2": "Help is coming. Thank you! 🙏",
        "done_another_prompt": "👇 *What now?*",
        "done_add_more": "📎 Add More to This Report",
        "done_another": "🚨 Report Something Else",
        "done_stop": "✅ I am done",
        "add_more_prompt": "📎 *Send more:*\n\n📸 Photo · 🎤 Voice · ⌨️ Write\n\nPress Done when finished 👇",
        "add_more_done": "✅ Added!",
        "error": "⚠️ Problem. Try again.",
        "sev_1": "🔴 Very Bad", "sev_2": "🟠 Some Damage", "sev_3": "🟢 Small",
        "type_road": "🛣 Road", "type_hospital": "🏥 Hospital", "type_house": "🏠 House",
        "type_power": "⚡ Electricity", "type_water": "💧 Water",
        "type_school": "🏫 School", "type_telecom": "📡 Telecom", "type_govt": "🏛 Gov.",
        "type_other": "❓ Other",
        "step_crisis": "🌪 *What kind of crisis?*",
        "crisis_earthquake": "🏚 Earthquake", "crisis_flood": "🌊 Flood", "crisis_conflict": "⚔️ Conflict",
        "crisis_hurricane": "🌀 Hurricane", "crisis_wildfire": "🔥 Wildfire", "crisis_landslide": "🏔 Landslide",
        "crisis_pandemic": "🦠 Pandemic", "crisis_other": "❓ Other",
        "step_damage": "🏗 *How much damage?*",
        "dmg_none": "✅ No Damage", "dmg_partial": "⚠️ Partial", "dmg_complete": "❌ Destroyed",
        "step_photo_first": "📸 *Show us the damage*\n\n📸 Send a *photo*\n🎤 Or a *voice message*\n⌨️ Or *write* what happened\n\n🔒 _Faces hidden for safety_",
        "step_desc": "📝 *What happened?*\n\nWrite a short description 👇",
        "step_type_num": "🏗 *What is broken?*\n\nTap one 👇",
        "step_sev_num": "⚠️ *How bad is it?*\n\nTap one 👇",
        "step_loc_num": "📍 *Where is this?*\n\n👇 Press the button to send location",
        "photo_ack": "✅ Got your photo!",
        "desc_ack": "✅ Got it!",
        "step_loc_text_hint": "Or type the place name",
    },
    "hi": {
        "welcome_1": "🆘 *मदद! नुकसान बताएं*",
        "welcome_2": "बताएं क्या टूटा है।\nहम मदद भेजेंगे।\n\n👇 नीचे बटन दबाएं",
        "welcome_btn": "🚨 मुझे मदद चाहिए",
        "lang_select": "🌐 *अपनी भाषा चुनें:*",
        "step_loc": "📍 *आप कहां हैं?*\n\n👇 बटन दबाएं — अपनी जगह भेजें",
        "step_loc_btn": "📍 मेरी जगह भेजें",
        "step_loc_done": "✅ मिल गई!",
        "step_type": "🏗 क्या टूटा है?",
        "step_sev": "⚠️ कितना बुरा?",
        "step_photo": "📸 *नुकसान दिखाएं*\n\n📸 *फोटो* खींचकर भेजें\n🎤 या *बोलकर बताएं*\n⌨️ या *लिखें*\n\n🔒 _चेहरे छुपा दिए जाएंगे_",
        "step_voice": "🎙 *बताएं क्या हुआ*\n\n🎤 दबाकर बोलें\nया ⌨️ लिखें",
        "step_text": "📝 *कुछ और बताना है?*\n\nलिखें या भेजें दबाएं 👇",
        "step_text_skip": "✅ भेजें",
        "submitting": "⏳ भेज रहे हैं...",
        "done_1": "✅ *भेज दिया!*",
        "done_2": "मदद आ रही है। धन्यवाद! 🙏",
        "done_another_prompt": "👇 *अब क्या करें?*",
        "done_add_more": "📎 और जानकारी जोड़ें",
        "done_another": "🚨 नई बात बताएं",
        "done_stop": "✅ बस हो गया",
        "add_more_prompt": "📎 *और भेजें:*\n\n📸 फोटो · 🎤 आवाज़ · ⌨️ लिखें\n\nहो गया तो नीचे दबाएं 👇",
        "add_more_done": "✅ जोड़ दिया!",
        "error": "⚠️ दिक्कत हुई। फिर से करें।",
        "sev_1": "🔴 बहुत बुरा", "sev_2": "🟠 थोड़ा बुरा", "sev_3": "🟢 छोटा",
        "type_road": "🛣 सड़क", "type_hospital": "🏥 अस्पताल", "type_house": "🏠 घर",
        "type_power": "⚡ बिजली", "type_water": "💧 पानी",
        "type_school": "🏫 स्कूल", "type_telecom": "📡 टेलीकॉम", "type_govt": "🏛 सरकारी",
        "type_other": "❓ और कुछ",
        "step_crisis": "🌪 *कैसी आपदा?*",
        "crisis_earthquake": "🏚 भूकंप", "crisis_flood": "🌊 बाढ़", "crisis_conflict": "⚔️ संघर्ष",
        "crisis_hurricane": "🌀 तूफान", "crisis_wildfire": "🔥 आग", "crisis_landslide": "🏔 भूस्खलन",
        "crisis_pandemic": "🦠 महामारी", "crisis_other": "❓ अन्य",
        "step_damage": "🏗 *कितना नुकसान?*",
        "dmg_none": "✅ कोई नहीं", "dmg_partial": "⚠️ कुछ टूटा", "dmg_complete": "❌ पूरा तबाह",
        "step_photo_first": "📸 *नुकसान दिखाएं*\n\n📸 *फोटो* भेजें\n🎤 या *बोलकर बताएं*\n⌨️ या *लिखें*\n\n🔒 _चेहरे छुपा दिए जाएंगे_",
        "step_desc": "📝 *क्या हुआ?*\n\nछोटा सा बताएं 👇",
        "step_type_num": "🏗 *क्या टूटा है?*\n\nएक चुनें 👇",
        "step_sev_num": "⚠️ *कितना बुरा?*\n\nएक चुनें 👇",
        "step_loc_num": "📍 *ये कहां है?*\n\n👇 बटन दबाएं",
        "photo_ack": "✅ फोटो मिल गई!",
        "desc_ack": "✅ मिल गया!",
        "step_loc_text_hint": "या जगह का नाम लिखें",
    },
    "es": {
        "welcome_1": "🆘 *¡AYUDA! Reportar Daño*",
        "welcome_2": "Dinos qué se rompió.\nVamos a enviar ayuda.\n\n👇 Toca el botón abajo",
        "welcome_btn": "🚨 NECESITO AYUDA",
        "lang_select": "🌐 *Elige tu idioma:*",
        "step_loc": "📍 *¿Dónde estás?*\n\n👇 Toca el botón para enviar tu ubicación",
        "step_loc_btn": "📍 Enviar Mi Ubicación",
        "step_loc_done": "✅ ¡Listo!",
        "step_type": "🏗 ¿Qué se rompió?",
        "step_sev": "⚠️ ¿Qué tan malo?",
        "step_photo": "📸 *Muéstranos el daño*\n\n📸 Toma una *foto* y envíala\n🎤 O envía un *mensaje de voz*\n⌨️ O *escribe* qué pasó\n\n🔒 _Las caras se ocultan por seguridad_",
        "step_voice": "🎙 *Dinos qué pasó*\n\n🎤 Mantén y habla\no ⌨️ Escribe",
        "step_text": "📝 *¿Algo más?*\n\nEscribe más o toca Enviar 👇",
        "step_text_skip": "✅ ENVIAR",
        "submitting": "⏳ Enviando...",
        "done_1": "✅ *¡Enviado!*",
        "done_2": "La ayuda viene. ¡Gracias! 🙏",
        "done_another_prompt": "👇 *¿Qué más?*",
        "done_add_more": "📎 Agregar Más a Este Reporte",
        "done_another": "🚨 Reportar Otra Cosa",
        "done_stop": "✅ Ya terminé",
        "add_more_prompt": "📎 *Envía más:*\n\n📸 Foto · 🎤 Voz · ⌨️ Escribe\n\nToca Listo cuando termines 👇",
        "add_more_done": "✅ ¡Agregado!",
        "error": "⚠️ Error. Intenta otra vez.",
        "sev_1": "🔴 Muy Malo", "sev_2": "🟠 Algo Dañado", "sev_3": "🟢 Poco",
        "type_road": "🛣 Camino", "type_hospital": "🏥 Hospital", "type_house": "🏠 Casa",
        "type_power": "⚡ Luz", "type_water": "💧 Agua",
        "type_school": "🏫 Escuela", "type_telecom": "📡 Telecom", "type_govt": "🏛 Gobierno",
        "type_other": "❓ Otro",
        "step_crisis": "🌪 *¿Qué tipo de crisis?*",
        "crisis_earthquake": "🏚 Terremoto", "crisis_flood": "🌊 Inundación", "crisis_conflict": "⚔️ Conflicto",
        "crisis_hurricane": "🌀 Huracán", "crisis_wildfire": "🔥 Incendio", "crisis_landslide": "🏔 Derrumbe",
        "crisis_pandemic": "🦠 Pandemia", "crisis_other": "❓ Otro",
        "step_damage": "🏗 *¿Cuánto daño?*",
        "dmg_none": "✅ Sin daño", "dmg_partial": "⚠️ Parcial", "dmg_complete": "❌ Destruido",
        "step_photo_first": "📸 *Muéstranos el daño*\n\n📸 Envía una *foto*\n🎤 O un *mensaje de voz*\n⌨️ O *escribe* qué pasó\n\n🔒 _Las caras se ocultan_",
        "step_desc": "📝 *¿Qué pasó?*\n\nEscribe una descripción corta 👇",
        "step_type_num": "🏗 *¿Qué se rompió?*\n\nToca uno 👇",
        "step_sev_num": "⚠️ *¿Qué tan malo?*\n\nToca uno 👇",
        "step_loc_num": "📍 *¿Dónde es esto?*\n\n👇 Toca el botón para enviar ubicación",
        "photo_ack": "✅ ¡Recibimos tu foto!",
        "desc_ack": "✅ ¡Listo!",
        "step_loc_text_hint": "O escribe el nombre del lugar",
    },
    "fr": {
        "welcome_1": "🆘 *AU SECOURS ! Signaler un Dégât*",
        "welcome_2": "Dites-nous ce qui est cassé.\nOn envoie de l'aide.\n\n👇 Appuyez en bas",
        "welcome_btn": "🚨 J'AI BESOIN D'AIDE",
        "lang_select": "🌐 *Choisissez votre langue :*",
        "step_loc": "📍 *Où êtes-vous ?*\n\n👇 Appuyez pour envoyer votre position",
        "step_loc_btn": "📍 Envoyer Ma Position",
        "step_loc_done": "✅ Reçu !",
        "step_type": "🏗 Qu'est-ce qui est cassé ?",
        "step_sev": "⚠️ C'est grave ?",
        "step_photo": "📸 *Montrez-nous le dégât*\n\n📸 Prenez une *photo* et envoyez\n🎤 Ou envoyez un *message vocal*\n⌨️ Ou *écrivez*\n\n🔒 _Les visages sont cachés pour la sécurité_",
        "step_voice": "🎙 *Dites-nous ce qui s'est passé*\n\n🎤 Appuyez et parlez\nou ⌨️ Écrivez",
        "step_text": "📝 *Autre chose ?*\n\nÉcrivez ou appuyez Envoyer 👇",
        "step_text_skip": "✅ ENVOYER",
        "submitting": "⏳ Envoi...",
        "done_1": "✅ *Envoyé !*",
        "done_2": "L'aide arrive. Merci ! 🙏",
        "done_another_prompt": "👇 *Et maintenant ?*",
        "done_add_more": "📎 Ajouter Plus à Ce Rapport",
        "done_another": "🚨 Signaler Autre Chose",
        "done_stop": "✅ C'est tout",
        "add_more_prompt": "📎 *Envoyez plus :*\n\n📸 Photo · 🎤 Voix · ⌨️ Écrivez\n\nAppuyez Fini quand c'est bon 👇",
        "add_more_done": "✅ Ajouté !",
        "error": "⚠️ Problème. Réessayez.",
        "sev_1": "🔴 Très Grave", "sev_2": "🟠 Moyen", "sev_3": "🟢 Petit",
        "type_road": "🛣 Route", "type_hospital": "🏥 Hôpital", "type_house": "🏠 Maison",
        "type_power": "⚡ Électricité", "type_water": "💧 Eau",
        "type_school": "🏫 École", "type_telecom": "📡 Télécom", "type_govt": "🏛 Gouvernement",
        "type_other": "❓ Autre",
        "step_crisis": "🌪 *Quel type de crise ?*",
        "crisis_earthquake": "🏚 Séisme", "crisis_flood": "🌊 Inondation", "crisis_conflict": "⚔️ Conflit",
        "crisis_hurricane": "🌀 Ouragan", "crisis_wildfire": "🔥 Incendie", "crisis_landslide": "🏔 Glissement",
        "crisis_pandemic": "🦠 Pandémie", "crisis_other": "❓ Autre",
        "step_damage": "🏗 *Combien de dégâts ?*",
        "dmg_none": "✅ Aucun", "dmg_partial": "⚠️ Partiel", "dmg_complete": "❌ Détruit",
        "step_photo_first": "📸 *Montrez-nous le dégât*\n\n📸 Envoyez une *photo*\n🎤 Ou un *message vocal*\n⌨️ Ou *écrivez*\n\n🔒 _Les visages sont cachés_",
        "step_desc": "📝 *Que s'est-il passé ?*\n\nDécrivez en quelques mots 👇",
        "step_type_num": "🏗 *Qu'est-ce qui est cassé ?*\n\nTouchez un choix 👇",
        "step_sev_num": "⚠️ *C'est grave ?*\n\nTouchez un choix 👇",
        "step_loc_num": "📍 *C'est où ?*\n\n👇 Appuyez pour envoyer la position",
        "photo_ack": "✅ Photo reçue !",
        "desc_ack": "✅ Reçu !",
        "step_loc_text_hint": "Ou tapez le nom du lieu",
    },
    "ar": {
        "welcome_1": "🆘 *نجدة! بلّغ عن ضرر*",
        "welcome_2": "قولنا شو انكسر.\nرح نبعت مساعدة.\n\n👇 اضغط الزر تحت",
        "welcome_btn": "🚨 بدي مساعدة",
        "lang_select": "🌐 *اختار لغتك:*",
        "step_loc": "📍 *وين أنت؟*\n\n👇 اضغط الزر لترسل مكانك",
        "step_loc_btn": "📍 أرسل مكاني",
        "step_loc_done": "✅ وصل!",
        "step_type": "🏗 شو انكسر؟",
        "step_sev": "⚠️ قديش سيء؟",
        "step_photo": "📸 *ورّينا الضرر*\n\n📸 صوّر *صورة* وابعثها\n🎤 أو ابعث *رسالة صوتية*\n⌨️ أو *اكتب* شو صار\n\n🔒 _الوجوه بتتخبّى للأمان_",
        "step_voice": "🎙 *قولنا شو صار*\n\n🎤 اضغط واحكي\nأو ⌨️ اكتب",
        "step_text": "📝 *شي ثاني؟*\n\nاكتب أو اضغط أرسل 👇",
        "step_text_skip": "✅ أرسل",
        "submitting": "⏳ عم يرسل...",
        "done_1": "✅ *انبعث!*",
        "done_2": "المساعدة جاية. شكراً! 🙏",
        "done_another_prompt": "👇 *شو بدك تعمل؟*",
        "done_add_more": "📎 أضف أكثر لهالبلاغ",
        "done_another": "🚨 بلّغ عن شي ثاني",
        "done_stop": "✅ خلصت",
        "add_more_prompt": "📎 *ابعث أكثر:*\n\n📸 صورة · 🎤 صوت · ⌨️ اكتب\n\nاضغط خلصت لما تخلص 👇",
        "add_more_done": "✅ انضاف!",
        "error": "⚠️ صار مشكلة. جرّب مرة ثانية.",
        "sev_1": "🔴 كتير سيء", "sev_2": "🟠 شوي ضرر", "sev_3": "🟢 بسيط",
        "type_road": "🛣 طريق", "type_hospital": "🏥 مستشفى", "type_house": "🏠 بيت",
        "type_power": "⚡ كهرباء", "type_water": "💧 ماي",
        "type_school": "🏫 مدرسة", "type_telecom": "📡 اتصالات", "type_govt": "🏛 حكومة",
        "type_other": "❓ غيره",
        "step_crisis": "🌪 *شو نوع الكارثة؟*",
        "crisis_earthquake": "🏚 زلزال", "crisis_flood": "🌊 فيضان", "crisis_conflict": "⚔️ حرب",
        "crisis_hurricane": "🌀 إعصار", "crisis_wildfire": "🔥 حريق", "crisis_landslide": "🏔 انهيار",
        "crisis_pandemic": "🦠 وباء", "crisis_other": "❓ غيره",
        "step_damage": "🏗 *قديش الضرر؟*",
        "dmg_none": "✅ ما في", "dmg_partial": "⚠️ جزئي", "dmg_complete": "❌ مدمّر",
        "step_photo_first": "📸 *ورّينا الضرر*\n\n📸 ابعث *صورة*\n🎤 أو *رسالة صوتية*\n⌨️ أو *اكتب* شو صار\n\n🔒 _الوجوه بتتخبّى_",
        "step_desc": "📝 *شو صار؟*\n\nاكتب شرح قصير 👇",
        "step_type_num": "🏗 *شو انكسر؟*\n\nاختار واحد 👇",
        "step_sev_num": "⚠️ *قديش سيء؟*\n\nاختار واحد 👇",
        "step_loc_num": "📍 *وين هالشي؟*\n\n👇 اضغط الزر لترسل المكان",
        "photo_ack": "✅ وصلت الصورة!",
        "desc_ack": "✅ وصل!",
        "step_loc_text_hint": "أو اكتب اسم المكان",
    },
    "pt": {
        "welcome_1": "🆘 *SOCORRO! Relatar Dano*",
        "welcome_2": "Diga o que quebrou.\nVamos mandar ajuda.\n\n👇 Aperte o botão abaixo",
        "welcome_btn": "🚨 PRECISO DE AJUDA",
        "lang_select": "🌐 *Escolha seu idioma:*",
        "step_loc": "📍 *Onde você está?*\n\n👇 Aperte para enviar sua localização",
        "step_loc_btn": "📍 Enviar Minha Localização",
        "step_loc_done": "✅ Recebido!",
        "step_type": "🏗 O que quebrou?",
        "step_sev": "⚠️ Quão ruim?",
        "step_photo": "📸 *Mostre o estrago*\n\n📸 Tire uma *foto* e mande\n🎤 Ou mande *áudio*\n⌨️ Ou *escreva*\n\n🔒 _Rostos são escondidos por segurança_",
        "step_voice": "🎙 *Conte o que houve*\n\n🎤 Segure e fale\nou ⌨️ Escreva",
        "step_text": "📝 *Mais alguma coisa?*\n\nEscreva mais ou aperte Enviar 👇",
        "step_text_skip": "✅ ENVIAR",
        "submitting": "⏳ Enviando...",
        "done_1": "✅ *Enviado!*",
        "done_2": "Ajuda a caminho. Obrigado! 🙏",
        "done_another_prompt": "👇 *E agora?*",
        "done_add_more": "📎 Adicionar Mais a Este Relato",
        "done_another": "🚨 Relatar Outra Coisa",
        "done_stop": "✅ Terminei",
        "add_more_prompt": "📎 *Mande mais:*\n\n📸 Foto · 🎤 Áudio · ⌨️ Escreva\n\nAperte Pronto quando acabar 👇",
        "add_more_done": "✅ Adicionado!",
        "error": "⚠️ Deu erro. Tente de novo.",
        "sev_1": "🔴 Muito Ruim", "sev_2": "🟠 Mais ou Menos", "sev_3": "🟢 Pouco",
        "type_road": "🛣 Estrada", "type_hospital": "🏥 Hospital", "type_house": "🏠 Casa",
        "type_power": "⚡ Luz", "type_water": "💧 Água",
        "type_school": "🏫 Escola", "type_telecom": "📡 Telecom", "type_govt": "🏛 Governo",
        "type_other": "❓ Outro",
        "step_crisis": "🌪 *Que tipo de crise?*",
        "crisis_earthquake": "🏚 Terremoto", "crisis_flood": "🌊 Enchente", "crisis_conflict": "⚔️ Conflito",
        "crisis_hurricane": "🌀 Furacão", "crisis_wildfire": "🔥 Incêndio", "crisis_landslide": "🏔 Deslizamento",
        "crisis_pandemic": "🦠 Pandemia", "crisis_other": "❓ Outro",
        "step_damage": "🏗 *Quanto estrago?*",
        "dmg_none": "✅ Nenhum", "dmg_partial": "⚠️ Parcial", "dmg_complete": "❌ Destruído",
        "step_photo_first": "📸 *Mostre o estrago*\n\n📸 Mande uma *foto*\n🎤 Ou *áudio*\n⌨️ Ou *escreva*\n\n🔒 _Rostos são escondidos_",
        "step_desc": "📝 *O que aconteceu?*\n\nEscreva uma descrição curta 👇",
        "step_type_num": "🏗 *O que quebrou?*\n\nToque um 👇",
        "step_sev_num": "⚠️ *Quão ruim?*\n\nToque um 👇",
        "step_loc_num": "📍 *Onde é isso?*\n\n👇 Aperte para enviar localização",
        "photo_ack": "✅ Foto recebida!",
        "desc_ack": "✅ Recebido!",
        "step_loc_text_hint": "Ou escreva o nome do lugar",
    },
    "sw": {
        "welcome_1": "🆘 *MSAADA! Ripoti Uharibifu*",
        "welcome_2": "Tuambie nini kimevunjika.\nTutatuma msaada.\n\n👇 Bonyeza kitufe chini",
        "welcome_btn": "🚨 NAHITAJI MSAADA",
        "lang_select": "🌐 *Chagua lugha yako:*",
        "step_loc": "📍 *Uko wapi?*\n\n👇 Bonyeza kutuma eneo lako",
        "step_loc_btn": "📍 Tuma Eneo Langu",
        "step_loc_done": "✅ Tumepata!",
        "step_type": "🏗 Nini kimevunjika?",
        "step_sev": "⚠️ Ni mbaya kiasi gani?",
        "step_photo": "📸 *Tuonyeshe uharibifu*\n\n📸 Piga *picha* na utume\n🎤 Au tuma *ujumbe wa sauti*\n⌨️ Au *andika* kilichotokea\n\n🔒 _Nyuso zinafichwa kwa usalama_",
        "step_voice": "🎙 *Tuambie kilichotokea*\n\n🎤 Shika na ongea\nau ⌨️ Andika",
        "step_text": "📝 *Kitu kingine?*\n\nAndika zaidi au bonyeza Tuma 👇",
        "step_text_skip": "✅ TUMA",
        "submitting": "⏳ Inatuma...",
        "done_1": "✅ *Imetumwa!*",
        "done_2": "Msaada unakuja. Asante! 🙏",
        "done_another_prompt": "👇 *Nini sasa?*",
        "done_add_more": "📎 Ongeza Zaidi kwa Ripoti Hii",
        "done_another": "🚨 Ripoti Kitu Kingine",
        "done_stop": "✅ Nimemaliza",
        "add_more_prompt": "📎 *Tuma zaidi:*\n\n📸 Picha · 🎤 Sauti · ⌨️ Andika\n\nBonyeza Maliza ukimaliza 👇",
        "add_more_done": "✅ Imeongezwa!",
        "error": "⚠️ Tatizo. Jaribu tena.",
        "sev_1": "🔴 Mbaya Sana", "sev_2": "🟠 Wastani", "sev_3": "🟢 Kidogo",
        "type_road": "🛣 Barabara", "type_hospital": "🏥 Hospitali", "type_house": "🏠 Nyumba",
        "type_power": "⚡ Umeme", "type_water": "💧 Maji",
        "type_school": "🏫 Shule", "type_telecom": "📡 Mawasiliano", "type_govt": "🏛 Serikali",
        "type_other": "❓ Nyingine",
        "step_crisis": "🌪 *Ni aina gani ya maafa?*",
        "crisis_earthquake": "🏚 Tetemeko", "crisis_flood": "🌊 Mafuriko", "crisis_conflict": "⚔️ Vita",
        "crisis_hurricane": "🌀 Kimbunga", "crisis_wildfire": "🔥 Moto", "crisis_landslide": "🏔 Maporomoko",
        "crisis_pandemic": "🦠 Janga", "crisis_other": "❓ Nyingine",
        "step_damage": "🏗 *Uharibifu kiasi gani?*",
        "dmg_none": "✅ Hakuna", "dmg_partial": "⚠️ Kidogo", "dmg_complete": "❌ Kabisa",
        "step_photo_first": "📸 *Tuonyeshe uharibifu*\n\n📸 Tuma *picha*\n🎤 Au *ujumbe wa sauti*\n⌨️ Au *andika*\n\n🔒 _Nyuso zinafichwa_",
        "step_desc": "📝 *Nini kimetokea?*\n\nAndika maelezo mafupi 👇",
        "step_type_num": "🏗 *Nini kimevunjika?*\n\nChagua moja 👇",
        "step_sev_num": "⚠️ *Ni mbaya kiasi gani?*\n\nChagua moja 👇",
        "step_loc_num": "📍 *Hii iko wapi?*\n\n👇 Bonyeza kutuma eneo",
        "photo_ack": "✅ Picha imepokelewa!",
        "desc_ack": "✅ Imepokelewa!",
        "step_loc_text_hint": "Au andika jina la mahali",
    },
    "zh": {
        "welcome_1": "🆘 *救命！报告损坏*",
        "welcome_2": "告诉我们什么坏了。\n我们会派人来帮忙。\n\n👇 点下面的按钮",
        "welcome_btn": "🚨 我需要帮助",
        "lang_select": "🌐 *选择语言:*",
        "step_loc": "📍 *你在哪里?*\n\n👇 点按钮发送你的位置",
        "step_loc_btn": "📍 发送我的位置",
        "step_loc_done": "✅ 收到了!",
        "step_type": "🏗 什么坏了?",
        "step_sev": "⚠️ 多严重?",
        "step_photo": "📸 *给我们看看*\n\n📸 拍一张*照片*发过来\n🎤 或者发*语音*\n⌨️ 或者*打字*告诉我们\n\n🔒 _人脸会自动隐藏保护隐私_",
        "step_voice": "🎙 *告诉我们发生了什么*\n\n🎤 按住说话\n或 ⌨️ 打字",
        "step_text": "📝 *还有别的吗?*\n\n打字或点发送 👇",
        "step_text_skip": "✅ 发送",
        "submitting": "⏳ 正在发送...",
        "done_1": "✅ *发送了!*",
        "done_2": "帮助马上到。谢谢！🙏",
        "done_another_prompt": "👇 *接下来呢?*",
        "done_add_more": "📎 给这个报告加更多",
        "done_another": "🚨 报告别的事",
        "done_stop": "✅ 好了",
        "add_more_prompt": "📎 *发送更多:*\n\n📸 照片 · 🎤 语音 · ⌨️ 文字\n\n好了就点下面 👇",
        "add_more_done": "✅ 加好了!",
        "error": "⚠️ 出问题了。再试一次。",
        "sev_1": "🔴 很严重", "sev_2": "🟠 有点坏", "sev_3": "🟢 一点点",
        "type_road": "🛣 路", "type_hospital": "🏥 医院", "type_house": "🏠 房子",
        "type_power": "⚡ 电", "type_water": "💧 水",
        "type_school": "🏫 学校", "type_telecom": "📡 通讯", "type_govt": "🏛 政府",
        "type_other": "❓ 别的",
        "step_crisis": "🌪 *什么灾害？*",
        "crisis_earthquake": "🏚 地震", "crisis_flood": "🌊 洪水", "crisis_conflict": "⚔️ 冲突",
        "crisis_hurricane": "🌀 飓风", "crisis_wildfire": "🔥 火灾", "crisis_landslide": "🏔 滑坡",
        "crisis_pandemic": "🦠 疫情", "crisis_other": "❓ 别的",
        "step_damage": "🏗 *损坏多严重？*",
        "dmg_none": "✅ 没坏", "dmg_partial": "⚠️ 部分坏", "dmg_complete": "❌ 全毁",
        "step_photo_first": "📸 *给我们看看*\n\n📸 发一张*照片*\n🎤 或*语音*\n⌨️ 或*打字*告诉我们\n\n🔒 _人脸自动隐藏_",
        "step_desc": "📝 *发生了什么?*\n\n简单写一下 👇",
        "step_type_num": "🏗 *什么坏了?*\n\n选一个 👇",
        "step_sev_num": "⚠️ *多严重?*\n\n选一个 👇",
        "step_loc_num": "📍 *在哪里?*\n\n👇 点按钮发送位置",
        "photo_ack": "✅ 照片收到了!",
        "desc_ack": "✅ 收到!",
        "step_loc_text_hint": "或者打字写地名",
    },
    "ru": {
        "welcome_1": "🆘 *ПОМОГИТЕ! Сообщить о повреждении*",
        "welcome_2": "Скажите что сломалось.\nМы пришлем помощь.\n\n👇 Нажмите кнопку внизу",
        "welcome_btn": "🚨 МНЕ НУЖНА ПОМОЩЬ",
        "lang_select": "🌐 *Выберите язык:*",
        "step_loc": "📍 *Где вы?*\n\n👇 Нажмите кнопку чтобы отправить место",
        "step_loc_btn": "📍 Отправить Моё Место",
        "step_loc_done": "✅ Получили!",
        "step_type": "🏗 Что сломалось?",
        "step_sev": "⚠️ Насколько плохо?",
        "step_photo": "📸 *Покажите повреждение*\n\n📸 Сделайте *фото* и отправьте\n🎤 Или пришлите *голосовое*\n⌨️ Или *напишите*\n\n🔒 _Лица скрываются для безопасности_",
        "step_voice": "🎙 *Расскажите что случилось*\n\n🎤 Зажмите и говорите\nили ⌨️ Напишите",
        "step_text": "📝 *Ещё что-то?*\n\nНапишите или нажмите Отправить 👇",
        "step_text_skip": "✅ ОТПРАВИТЬ",
        "submitting": "⏳ Отправляем...",
        "done_1": "✅ *Отправлено!*",
        "done_2": "Помощь идет. Спасибо! 🙏",
        "done_another_prompt": "👇 *Что дальше?*",
        "done_add_more": "📎 Добавить ещё к этому отчету",
        "done_another": "🚨 Сообщить о другом",
        "done_stop": "✅ Всё",
        "add_more_prompt": "📎 *Отправьте ещё:*\n\n📸 Фото · 🎤 Голос · ⌨️ Текст\n\nНажмите Готово когда всё 👇",
        "add_more_done": "✅ Добавлено!",
        "error": "⚠️ Проблема. Попробуйте ещё раз.",
        "sev_1": "🔴 Очень плохо", "sev_2": "🟠 Средне", "sev_3": "🟢 Немного",
        "type_road": "🛣 Дорога", "type_hospital": "🏥 Больница", "type_house": "🏠 Дом",
        "type_power": "⚡ Свет", "type_water": "💧 Вода",
        "type_school": "🏫 Школа", "type_telecom": "📡 Связь", "type_govt": "🏛 Госздание",
        "type_other": "❓ Другое",
        "step_crisis": "🌪 *Какая катастрофа?*",
        "crisis_earthquake": "🏚 Землетрясение", "crisis_flood": "🌊 Наводнение", "crisis_conflict": "⚔️ Конфликт",
        "crisis_hurricane": "🌀 Ураган", "crisis_wildfire": "🔥 Пожар", "crisis_landslide": "🏔 Оползень",
        "crisis_pandemic": "🦠 Пандемия", "crisis_other": "❓ Другое",
        "step_damage": "🏗 *Сколько повреждений?*",
        "dmg_none": "✅ Нет", "dmg_partial": "⚠️ Частично", "dmg_complete": "❌ Разрушено",
        "step_photo_first": "📸 *Покажите повреждение*\n\n📸 Отправьте *фото*\n🎤 Или *голосовое*\n⌨️ Или *напишите*\n\n🔒 _Лица скрываются_",
        "step_desc": "📝 *Что случилось?*\n\nНапишите коротко 👇",
        "step_type_num": "🏗 *Что сломалось?*\n\nВыберите 👇",
        "step_sev_num": "⚠️ *Насколько плохо?*\n\nВыберите 👇",
        "step_loc_num": "📍 *Где это?*\n\n👇 Нажмите чтобы отправить место",
        "photo_ack": "✅ Фото получено!",
        "desc_ack": "✅ Получили!",
        "step_loc_text_hint": "Или напишите название места",
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
    """Show language picker only. Picking a language immediately starts the reporting flow."""
    await _send("sendMessage", {
        "chat_id": chat_id,
        "text": f"{t(lang, 'welcome_1')}\n\n{t(lang, 'lang_select')}",
        "parse_mode": "Markdown",
        "reply_markup": {
            "inline_keyboard": [
                [
                    {"text": "🇬🇧 English", "callback_data": "lang_en"},
                    {"text": "🇨🇳 中文", "callback_data": "lang_zh"},
                    {"text": "🇷🇺 Русский", "callback_data": "lang_ru"},
                ],
                [
                    {"text": "🇪🇸 Español", "callback_data": "lang_es"},
                    {"text": "🇫🇷 Français", "callback_data": "lang_fr"},
                    {"text": "🇸🇦 عربي", "callback_data": "lang_ar"},
                ],
                [
                    {"text": "🇮🇳 हिन्दी", "callback_data": "lang_hi"},
                    {"text": "🇧🇷 Português", "callback_data": "lang_pt"},
                    {"text": "🇰🇪 Kiswahili", "callback_data": "lang_sw"},
                ],
            ]
        },
    })


async def send_step_location(chat_id: int, lang: str):
    await _send("sendMessage", {
        "chat_id": chat_id,
        "text": t(lang, "step_loc_num") + "\n\n" + t(lang, "step_loc_text_hint"),
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


async def send_step_photo_first(chat_id: int, lang: str):
    """First step after language selection: ask for photo/voice/text evidence."""
    await _send("sendMessage", {
        "chat_id": chat_id,
        "text": t(lang, "step_photo_first"),
        "parse_mode": "Markdown",
        "reply_markup": {
            "inline_keyboard": [
                [{"text": "⌨️ Skip — write instead", "callback_data": "skip_photo"}],
            ],
        },
    })


async def send_step_description(chat_id: int, lang: str):
    """Ask for text description of the incident."""
    await _send("sendMessage", {
        "chat_id": chat_id,
        "text": t(lang, "step_desc"),
        "parse_mode": "Markdown",
        "reply_markup": {
            "inline_keyboard": [
                [{"text": t(lang, "step_text_skip"), "callback_data": "skip_description"}],
            ],
        },
    })


async def send_step_severity(chat_id: int, lang: str):
    await _send("sendMessage", {
        "chat_id": chat_id,
        "text": t(lang, "step_sev_num"),
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
        "text": t(lang, "step_type_num"),
        "parse_mode": "Markdown",
        "reply_markup": {
            "inline_keyboard": [
                [{"text": t(lang, "type_road"), "callback_data": "type_road"},
                 {"text": t(lang, "type_hospital"), "callback_data": "type_hospital"},
                 {"text": t(lang, "type_house"), "callback_data": "type_house"}],
                [{"text": t(lang, "type_power"), "callback_data": "type_power"},
                 {"text": t(lang, "type_water"), "callback_data": "type_water"},
                 {"text": t(lang, "type_school"), "callback_data": "type_school"}],
                [{"text": t(lang, "type_telecom"), "callback_data": "type_telecom"},
                 {"text": t(lang, "type_govt"), "callback_data": "type_govt"},
                 {"text": t(lang, "type_other"), "callback_data": "type_other"}],
            ],
        },
    })


async def send_step_crisis_type(chat_id: int, lang: str):
    await _send("sendMessage", {
        "chat_id": chat_id,
        "text": t(lang, "step_crisis"),
        "parse_mode": "Markdown",
        "reply_markup": {
            "inline_keyboard": [
                [{"text": t(lang, "crisis_earthquake"), "callback_data": "crisis_earthquake"},
                 {"text": t(lang, "crisis_flood"), "callback_data": "crisis_flood"},
                 {"text": t(lang, "crisis_conflict"), "callback_data": "crisis_conflict"}],
                [{"text": t(lang, "crisis_hurricane"), "callback_data": "crisis_hurricane"},
                 {"text": t(lang, "crisis_wildfire"), "callback_data": "crisis_wildfire"},
                 {"text": t(lang, "crisis_landslide"), "callback_data": "crisis_landslide"}],
                [{"text": t(lang, "crisis_pandemic"), "callback_data": "crisis_pandemic"},
                 {"text": t(lang, "crisis_other"), "callback_data": "crisis_other"}],
            ],
        },
    })


async def send_step_damage_class(chat_id: int, lang: str):
    await _send("sendMessage", {
        "chat_id": chat_id,
        "text": t(lang, "step_damage"),
        "parse_mode": "Markdown",
        "reply_markup": {
            "inline_keyboard": [
                [{"text": t(lang, "dmg_none"), "callback_data": "dmg_none"},
                 {"text": t(lang, "dmg_partial"), "callback_data": "dmg_partial"},
                 {"text": t(lang, "dmg_complete"), "callback_data": "dmg_complete"}],
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
