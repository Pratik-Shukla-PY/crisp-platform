"""Canonical definition of the UNDP Appendix-1 mandatory crisis-form questions.

UNDP Appendix-1 ("Modular Form Fields") mandates three *core* questions a
reporter is required to answer to submit their damage-assessment images:

    1. Electricity infrastructure condition  (6 options)
    2. Overall functioning of health services (5 options)
    3. Most pressing needs                    (10 options, incl. "Other, please specify")

They are delivered through the crisis-form-pack engine - the "ability to adjust
the form fields used for upload of damage reports" UNDP explicitly rewards - and
NOT hardcoded into the default report flow (packs are geo-gated, so the default
no-crisis flow stays lean). The option *text* is verbatim from UNDP and must not
be modified, simplified, or diluted.

This module is the single backend source of truth: the seed script
(`backend/scripts/seed_undp_pack.py`) and the backend tests both import it. The
dashboard pack-builder (`web-dashboard/src/cc-crisis.js` `UNDP_BLOCKS`) carries an
equivalent definition for the authoring UI; the two are kept identical by review.

Design notes:
  * All three are ``multi_select`` (UNDP's literal "multi-select questions"
    wording). ``pressing_needs`` carries an ``OTHER`` option flagged ``other:true``
    that drives the conditional ``pressing_needs_other`` free-text sibling.
  * Answers land in ``Report.form_data`` (no ``maps_to``). UNDP's electricity
    scale is a *damage* scale, incompatible with the operational
    ``ServiceStatusEnum``, so it is never coerced into ``service_status``.
  * ``channels`` = APP / ANDROID / WHATSAPP / TELEGRAM - the channels that can
    render multi-selects. SMS / IVR (coarse text / voice) never render packs.
  * ``label_i18n`` carries the 6 UN languages (must-have #2).
"""
from __future__ import annotations

from typing import Any, Dict

UNDP_PACK_KEY = "undp-core-damage-assessment"
UNDP_PACK_TITLE = "UNDP Core Damage Assessment"
UNDP_CHANNELS = ["APP", "ANDROID", "WHATSAPP", "TELEGRAM"]


def _o(value: str, en: str, ar: str, zh: str, fr: str, ru: str, es: str,
       other: bool = False) -> Dict[str, Any]:
    opt: Dict[str, Any] = {
        "value": value,
        "label": en,
        "label_i18n": {"en": en, "ar": ar, "zh": zh, "fr": fr, "ru": ru, "es": es},
    }
    if other:
        opt["other"] = True
    return opt


_ELECTRICITY = [
    _o("NO_DAMAGE", "No damage observed",
       "لا يوجد ضرر ملحوظ", "未观察到损坏", "Aucun dommage observé",
       "Повреждений не обнаружено", "No se observan daños"),
    _o("MINOR", "Minor damage (service disruptions but quickly repairable)",
       "ضرر طفيف (انقطاعات في الخدمة لكن يمكن إصلاحها بسرعة)", "轻微损坏（服务中断但可快速修复）",
       "Dommages mineurs (interruptions de service mais réparables rapidement)",
       "Незначительные повреждения (перебои, но быстро устранимы)",
       "Daños menores (interrupciones del servicio pero reparables rápidamente)"),
    _o("MODERATE", "Moderate damage (partial outages requiring repairs)",
       "ضرر متوسط (انقطاعات جزئية تتطلب إصلاحات)", "中度损坏（部分停电，需要维修）",
       "Dommages modérés (pannes partielles nécessitant des réparations)",
       "Умеренные повреждения (частичные отключения, требующие ремонта)",
       "Daños moderados (cortes parciales que requieren reparación)"),
    _o("SEVERE", "Severe damage (major infrastructure damaged, prolonged outages)",
       "ضرر شديد (تضرر بنية تحتية رئيسية، انقطاعات طويلة)", "严重损坏（主要基础设施受损，长时间停电）",
       "Dommages graves (infrastructures majeures endommagées, pannes prolongées)",
       "Серьёзные повреждения (повреждена основная инфраструктура, длительные отключения)",
       "Daños graves (infraestructura principal dañada, cortes prolongados)"),
    _o("DESTROYED", "Completely destroyed (no electricity infrastructure functioning)",
       "مدمّر بالكامل (لا تعمل أي بنية تحتية للكهرباء)", "完全损毁（电力基础设施全部瘫痪）",
       "Entièrement détruit (aucune infrastructure électrique fonctionnelle)",
       "Полностью разрушено (электроинфраструктура не функционирует)",
       "Completamente destruida (ninguna infraestructura eléctrica en funcionamiento)"),
    _o("UNKNOWN", "Unknown/cannot be assessed",
       "غير معروف/لا يمكن تقييمه", "未知/无法评估", "Inconnu / impossible à évaluer",
       "Неизвестно / невозможно оценить", "Desconocido / no se puede evaluar"),
]

_HEALTH = [
    _o("FULLY_FUNCTIONAL", "Fully functional",
       "يعمل بالكامل", "完全正常运作", "Pleinement fonctionnel",
       "Полностью функционирует", "Plenamente funcional"),
    _o("PARTIALLY_FUNCTIONAL", "Partially functional",
       "يعمل جزئيًا", "部分运作", "Partiellement fonctionnel",
       "Частично функционирует", "Parcialmente funcional"),
    _o("LARGELY_DISRUPTED", "Largely disrupted",
       "متعطّل إلى حد كبير", "大面积中断", "Largement perturbé",
       "В значительной степени нарушено", "Mayormente interrumpido"),
    _o("NOT_FUNCTIONING", "Not functioning at all",
       "لا يعمل على الإطلاق", "完全无法运作", "Ne fonctionne pas du tout",
       "Совсем не функционирует", "No funciona en absoluto"),
    _o("UNKNOWN", "Unknown",
       "غير معروف", "未知", "Inconnu", "Неизвестно", "Desconocido"),
]

_NEEDS = [
    _o("FOOD_WATER", "Food assistance and safe drinking water",
       "المساعدة الغذائية ومياه الشرب الآمنة", "食物援助和安全饮用水", "Aide alimentaire et eau potable",
       "Продовольственная помощь и безопасная питьевая вода", "Asistencia alimentaria y agua potable segura"),
    _o("CASH", "Cash or financial assistance",
       "المساعدة النقدية أو المالية", "现金或财务援助", "Aide en espèces ou financière",
       "Денежная или финансовая помощь", "Asistencia en efectivo o financiera"),
    _o("HEALTHCARE", "Access to healthcare and essential medicines",
       "الوصول إلى الرعاية الصحية والأدوية الأساسية", "获得医疗保健和基本药品",
       "Accès aux soins de santé et aux médicaments essentiels",
       "Доступ к медицинской помощи и основным лекарствам", "Acceso a atención médica y medicamentos esenciales"),
    _o("SHELTER", "Shelter, housing repair, or temporary accommodation",
       "المأوى أو إصلاح المساكن أو الإقامة المؤقتة", "住所、房屋修缮或临时住宿",
       "Abri, réparation de logement ou hébergement temporaire",
       "Жильё, ремонт жилья или временное размещение", "Refugio, reparación de viviendas o alojamiento temporal"),
    _o("LIVELIHOODS", "Restoration of livelihoods or income sources",
       "استعادة سبل العيش أو مصادر الدخل", "恢复生计或收入来源",
       "Rétablissement des moyens de subsistance ou des sources de revenus",
       "Восстановление средств к существованию или источников дохода", "Restauración de medios de vida o fuentes de ingresos"),
    _o("WASH", "Water, sanitation, and hygiene (toilets, washing facilities)",
       "المياه والصرف الصحي والنظافة (المراحيض ومرافق الاغتسال)", "水、环境卫生和个人卫生（厕所、洗浴设施）",
       "Eau, assainissement et hygiène (toilettes, installations de lavage)",
       "Вода, санитария и гигиена (туалеты, места для мытья)", "Agua, saneamiento e higiene (baños, instalaciones de lavado)"),
    _o("BASIC_SERVICES", "Restoration of basic services and infrastructure (electricity, roads, schools)",
       "استعادة الخدمات الأساسية والبنية التحتية (الكهرباء، الطرق، المدارس)", "恢复基本服务和基础设施（电力、道路、学校）",
       "Rétablissement des services de base et des infrastructures (électricité, routes, écoles)",
       "Восстановление базовых услуг и инфраструктуры (электричество, дороги, школы)",
       "Restauración de servicios básicos e infraestructura (electricidad, carreteras, escuelas)"),
    _o("PROTECTION", "Protection services and psychosocial support",
       "خدمات الحماية والدعم النفسي والاجتماعي", "保护服务和心理社会支持",
       "Services de protection et soutien psychosocial",
       "Услуги защиты и психосоциальная поддержка", "Servicios de protección y apoyo psicosocial"),
    _o("LOCAL_AUTHORITIES", "Support from local authorities and community organizations",
       "الدعم من السلطات المحلية والمنظمات المجتمعية", "来自地方当局和社区组织的支持",
       "Soutien des autorités locales et des organisations communautaires",
       "Поддержка со стороны местных властей и общественных организаций", "Apoyo de autoridades locales y organizaciones comunitarias"),
    _o("OTHER", "Other, please specify",
       "أخرى، يُرجى التحديد", "其他，请说明", "Autre, veuillez préciser",
       "Другое, укажите", "Otro, especifique", other=True),
]


def _field(key: str, label: str, label_i18n: Dict[str, str], options=None,
           field_type: str = "multi_select", required: bool = True,
           validation=None, show_if=None) -> Dict[str, Any]:
    f: Dict[str, Any] = {
        "key": key, "type": field_type, "label": label, "label_i18n": label_i18n,
        "required": required, "channels": list(UNDP_CHANNELS),
    }
    if options is not None:
        f["options"] = options
    if validation is not None:
        f["validation"] = validation
    if show_if is not None:
        f["show_if"] = show_if
    return f


# The canonical published schema for the seeded "UNDP Core Damage Assessment" pack.
UNDP_CORE_SCHEMA: Dict[str, Any] = {
    "schema_version": 1,
    "key": UNDP_PACK_KEY,
    "title": UNDP_PACK_TITLE,
    "sections": [
        {
            "id": "details", "stage": 3, "title": "Impact assessment",
            "fields": [
                _field(
                    "electricity_condition",
                    "What is the current condition of electricity infrastructure in your community following the crisis?",
                    {
                        "en": "What is the current condition of electricity infrastructure in your community following the crisis?",
                        "ar": "ما هي الحالة الحالية للبنية التحتية للكهرباء في مجتمعك بعد الأزمة؟",
                        "zh": "危机发生后，您所在社区的电力基础设施目前处于什么状况？",
                        "fr": "Quel est l’état actuel des infrastructures électriques dans votre communauté à la suite de la crise ?",
                        "ru": "Каково текущее состояние электроэнергетической инфраструктуры в вашем районе после кризиса?",
                        "es": "¿Cuál es el estado actual de la infraestructura eléctrica en su comunidad tras la crisis?",
                    },
                    options=_ELECTRICITY),
                _field(
                    "health_services_status",
                    "How would you rate the overall functioning of health services in your community since the event?",
                    {
                        "en": "How would you rate the overall functioning of health services in your community since the event?",
                        "ar": "كيف تقيّم الأداء العام للخدمات الصحية في مجتمعك منذ وقوع الحدث؟",
                        "zh": "自事件发生以来，您如何评价社区医疗服务的整体运作情况？",
                        "fr": "Comment évalueriez-vous le fonctionnement global des services de santé dans votre communauté depuis l’événement ?",
                        "ru": "Как бы вы оценили общее функционирование медицинских служб в вашем районе после события?",
                        "es": "¿Cómo calificaría el funcionamiento general de los servicios de salud en su comunidad desde el evento?",
                    },
                    options=_HEALTH),
                _field(
                    "pressing_needs",
                    "What are the most pressing needs?",
                    {
                        "en": "What are the most pressing needs?",
                        "ar": "ما هي أكثر الاحتياجات إلحاحًا؟",
                        "zh": "最迫切的需求是什么？",
                        "fr": "Quels sont les besoins les plus urgents ?",
                        "ru": "Каковы самые насущные потребности?",
                        "es": "¿Cuáles son las necesidades más urgentes?",
                    },
                    options=_NEEDS),
                _field(
                    "pressing_needs_other",
                    "Please specify the other pressing need",
                    {
                        "en": "Please specify the other pressing need",
                        "ar": "يُرجى تحديد الحاجة الملحّة الأخرى",
                        "zh": "请说明其他迫切需求",
                        "fr": "Veuillez préciser l’autre besoin urgent",
                        "ru": "Укажите другую насущную потребность",
                        "es": "Especifique la otra necesidad urgente",
                    },
                    field_type="short_text", required=False,
                    validation={"max_length": 200},
                    show_if={"field": "pressing_needs", "includes": "OTHER"}),
            ],
        },
    ],
}
