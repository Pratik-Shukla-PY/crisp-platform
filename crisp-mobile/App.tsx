/**
 * CRISP Mobile — Crisis Response Intelligence & Situation Platform
 * React Native Android App — Offline-first crisis reporting.
 *
 * Screen flow: Home → Photo → Audio → Review → Send → Success
 */
import React, { useEffect, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, SafeAreaView,
  ScrollView, TextInput, Alert, Image, StatusBar, Platform,
} from 'react-native';
import { Colors } from './constants/colors';
import { t, setLanguage, detectLanguage, getAvailableLanguages } from './services/i18n';
import { initDatabase, enqueueReport, getQueueCount } from './services/database';
import { processQueue } from './services/syncEngine';
import NetInfo from '@react-native-community/netinfo';
import * as crypto from 'expo-crypto';

type Screen = 'home' | 'photo' | 'audio' | 'review' | 'send' | 'success';

export default function App() {
  const [screen, setScreen] = useState<Screen>('home');
  const [lang, setLang] = useState('en');
  const [queueCount, setQueueCount] = useState(0);
  const [isOnline, setIsOnline] = useState(true);
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [audioUri, setAudioUri] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [infraType, setInfraType] = useState('ROAD');
  const [severity, setSeverity] = useState('MODERATE');
  const [location, setLocation] = useState<{ lat: number; lng: number; acc: number } | null>(null);
  const [locationName, setLocationName] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [reportId, setReportId] = useState('');

  useEffect(() => {
    const detected = detectLanguage();
    setLanguage(detected);
    setLang(detected);
    initDatabase();
    updateQueueCount();
    const unsub = NetInfo.addEventListener(state => {
      const online = !!(state.isConnected && state.isInternetReachable);
      setIsOnline(online);
      if (online) processQueue().then(updateQueueCount);
    });
    const interval = setInterval(async () => {
      const net = await NetInfo.fetch();
      if (net.isConnected) { await processQueue(); await updateQueueCount(); }
    }, 30000);
    return () => { unsub(); clearInterval(interval); };
  }, []);

  const updateQueueCount = async () => setQueueCount(await getQueueCount());
  const changeLang = (code: string) => { setLanguage(code); setLang(code); };
  const resetReport = () => {
    setPhotoUri(null); setAudioUri(null); setDescription('');
    setInfraType('ROAD'); setSeverity('MODERATE');
    setLocation(null); setLocationName(''); setIsSending(false); setReportId('');
  };

  const submitReport = async () => {
    setIsSending(true);
    const clientId = crypto.randomUUID();
    const meta = {
      device_hash: `APP-${Platform.OS}-${crypto.randomUUID().substring(0, 8)}`,
      client_report_id: clientId, source: 'APP', severity, infrastructure_type: infraType,
      description: description || '', detected_language: lang,
      expected_media: (photoUri ? 1 : 0) + (audioUri ? 1 : 0),
      ...(location ? { location: { latitude: location.lat, longitude: location.lng, device_latitude: location.lat, device_longitude: location.lng, accuracy_meters: location.acc || 0, device_location_name: locationName || null } } : {}),
    };
    await enqueueReport({ client_report_id: clientId, meta: JSON.stringify(meta), photo: photoUri, audio: audioUri, text_description: description, status: 'pending_sync' });
    setReportId(clientId.substring(0, 8));
    await updateQueueCount();
    if (isOnline) processQueue().then(updateQueueCount);
    setScreen('success');
    setIsSending(false);
  };

  const types = [
    { key: 'ROAD', icon: '🛣', label: t('type_road') }, { key: 'HOSPITAL', icon: '🏥', label: t('type_hospital') },
    { key: 'HOUSE', icon: '🏠', label: t('type_house') }, { key: 'POWER', icon: '⚡', label: t('type_power') },
    { key: 'WATER', icon: '💧', label: t('type_water') }, { key: 'OTHER', icon: '❓', label: t('type_other') },
  ];
  const sevs = [
    { key: 'MINOR', icon: '🟢', label: t('sev_minor') },
    { key: 'MODERATE', icon: '🟠', label: t('sev_moderate') },
    { key: 'SEVERE', icon: '🔴', label: t('sev_severe') },
  ];

  return (
    <SafeAreaView style={s.container}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.bg} />

      {screen === 'home' && (
        <View style={s.screen}>
          <Text style={s.emoji}>🆘</Text>
          <Text style={s.title}>{t('welcome_title')}</Text>
          <Text style={s.subtitle}>{t('welcome_sub')}</Text>
          <View style={s.langRow}>
            {getAvailableLanguages().map(l => (
              <TouchableOpacity key={l.code} style={[s.langBtn, lang === l.code && s.langBtnActive]} onPress={() => changeLang(l.code)}>
                <Text style={s.langFlag}>{l.flag}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <TouchableOpacity style={s.bigBtn} onPress={() => setScreen('photo')}>
            <Text style={s.bigBtnText}>{t('welcome_start')}</Text>
          </TouchableOpacity>
          {queueCount > 0 && <View style={s.queueBadge}><Text style={s.queueText}>{isOnline ? '🔄' : '📴'} {queueCount} {t('queued')}</Text></View>}
          {!isOnline && <Text style={s.offlineText}>{t('offline')}</Text>}
        </View>
      )}

      {screen === 'photo' && (
        <View style={s.screen}>
          <Text style={s.stepLabel}>1/4</Text>
          <Text style={s.title}>{t('photo_title')}</Text>
          <View style={s.piiWarning}><Text style={s.piiText}>🛡 {t('pii_warning')}</Text></View>
          {photoUri ? <Image source={{ uri: photoUri }} style={s.photoPreview} /> : <View style={s.photoPlaceholder}><Text style={{ fontSize: 48 }}>📸</Text></View>}
          <View style={s.row}>
            <TouchableOpacity style={s.choiceBtn} onPress={() => Alert.alert('Camera', 'expo-camera integration pending')}><Text style={s.choiceBtnText}>📷 {t('camera')}</Text></TouchableOpacity>
            <TouchableOpacity style={s.choiceBtn} onPress={() => Alert.alert('Browse', 'expo-image-picker integration pending')}><Text style={s.choiceBtnText}>📁 {t('browse')}</Text></TouchableOpacity>
          </View>
          <View style={s.navRow}>
            <TouchableOpacity onPress={() => setScreen('home')}><Text style={s.backText}>← Back</Text></TouchableOpacity>
            <TouchableOpacity style={s.nextBtn} onPress={() => setScreen('audio')}><Text style={s.nextBtnText}>{t('next')} →</Text></TouchableOpacity>
          </View>
        </View>
      )}

      {screen === 'audio' && (
        <View style={s.screen}>
          <Text style={s.stepLabel}>2/4</Text>
          <Text style={s.title}>{t('audio_title')}</Text>
          <TouchableOpacity style={s.micBtn} onPress={() => Alert.alert('Record', 'expo-av integration pending')}>
            <Text style={{ fontSize: 40 }}>🎤</Text>
            <Text style={{ color: Colors.white, fontSize: 12, fontWeight: '600', marginTop: 4 }}>{t('tap_mic')}</Text>
          </TouchableOpacity>
          <TextInput style={s.textInput} placeholder={t('type_text')} placeholderTextColor={Colors.textDim} value={description} onChangeText={setDescription} multiline numberOfLines={4} />
          <View style={s.navRow}>
            <TouchableOpacity onPress={() => setScreen('photo')}><Text style={s.backText}>← Back</Text></TouchableOpacity>
            <TouchableOpacity style={s.nextBtn} onPress={() => setScreen('review')}><Text style={s.nextBtnText}>{t('next')} →</Text></TouchableOpacity>
          </View>
        </View>
      )}

      {screen === 'review' && (
        <ScrollView style={{ flex: 1, backgroundColor: Colors.bg }} contentContainerStyle={{ padding: 24 }}>
          <Text style={s.stepLabel}>3/4</Text>
          <Text style={s.title}>{t('review_title')}</Text>
          <Text style={s.label}>{t('type_label')}</Text>
          <View style={s.chipRow}>{types.map(tp => <TouchableOpacity key={tp.key} style={[s.chip, infraType === tp.key && s.chipActive]} onPress={() => setInfraType(tp.key)}><Text style={s.chipText}>{tp.icon} {tp.label}</Text></TouchableOpacity>)}</View>
          <Text style={s.label}>{t('severity_label')}</Text>
          <View style={s.chipRow}>{sevs.map(sv => <TouchableOpacity key={sv.key} style={[s.chip, severity === sv.key && s.chipActive]} onPress={() => setSeverity(sv.key)}><Text style={s.chipText}>{sv.icon} {sv.label}</Text></TouchableOpacity>)}</View>
          <Text style={s.label}>{t('description_label')}</Text>
          <TextInput style={s.textInput} value={description} onChangeText={setDescription} multiline numberOfLines={3} placeholderTextColor={Colors.textDim} placeholder={t('type_text')} />
          <View style={s.navRow}>
            <TouchableOpacity onPress={() => setScreen('audio')}><Text style={s.backText}>← Back</Text></TouchableOpacity>
            <TouchableOpacity style={s.nextBtn} onPress={() => setScreen('send')}><Text style={s.nextBtnText}>{t('next')} →</Text></TouchableOpacity>
          </View>
        </ScrollView>
      )}

      {screen === 'send' && (
        <View style={s.screen}>
          <Text style={s.stepLabel}>4/4</Text>
          <View style={s.summaryCard}>
            <Text style={s.summaryRow}>📋 {infraType} | ⚠️ {severity}</Text>
            <Text style={s.summaryRow}>📸 {photoUri ? '✅' : '❌'}  🎤 {audioUri ? '✅' : '❌'}</Text>
            {description ? <Text style={s.summaryDesc} numberOfLines={2}>{description}</Text> : null}
          </View>
          <TouchableOpacity style={[s.bigBtn, isSending && { opacity: 0.5 }]} onPress={submitReport} disabled={isSending}>
            <Text style={s.bigBtnText}>{isSending ? t('sending') : t('send')}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setScreen('review')}><Text style={s.backText}>← Back</Text></TouchableOpacity>
        </View>
      )}

      {screen === 'success' && (
        <View style={s.screen}>
          <Text style={s.emoji}>✅</Text>
          <Text style={s.title}>{t('success_title')}</Text>
          <Text style={s.subtitle}>{t('success_sub')}</Text>
          <Text style={{ color: Colors.accent, fontSize: 14, fontFamily: 'monospace', marginBottom: 16 }}>🆔 {reportId}...</Text>
          {!isOnline && <View style={s.queueBadge}><Text style={s.queueText}>📴 {t('offline')}</Text></View>}
          <TouchableOpacity style={s.bigBtn} onPress={() => { resetReport(); setScreen('home'); }}>
            <Text style={s.bigBtnText}>{t('new_report')}</Text>
          </TouchableOpacity>
        </View>
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  screen: { flex: 1, padding: 24, justifyContent: 'center', alignItems: 'center' },
  emoji: { fontSize: 64, marginBottom: 16 },
  title: { fontSize: 28, fontWeight: '800', color: Colors.text, textAlign: 'center', marginBottom: 8 },
  subtitle: { fontSize: 16, color: Colors.textDim, textAlign: 'center', marginBottom: 24, lineHeight: 22 },
  stepLabel: { fontSize: 12, fontWeight: '700', color: Colors.accent, textAlign: 'center', marginBottom: 8, letterSpacing: 1 },
  label: { fontSize: 13, fontWeight: '700', color: Colors.textDim, marginTop: 16, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 },
  langRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8, marginBottom: 32 },
  langBtn: { padding: 8, borderRadius: 8, borderWidth: 1, borderColor: Colors.border },
  langBtnActive: { borderColor: Colors.accent, backgroundColor: 'rgba(124,58,237,0.1)' },
  langFlag: { fontSize: 22 },
  bigBtn: { backgroundColor: Colors.accent, paddingVertical: 16, paddingHorizontal: 48, borderRadius: 14, marginTop: 16, width: '100%', alignItems: 'center', elevation: 6 },
  bigBtnText: { color: Colors.white, fontSize: 18, fontWeight: '800', letterSpacing: 1 },
  piiWarning: { backgroundColor: 'rgba(234,179,8,0.1)', borderWidth: 1, borderColor: 'rgba(234,179,8,0.25)', borderRadius: 10, padding: 10, marginBottom: 12, width: '100%' },
  piiText: { color: '#d97706', fontSize: 12, textAlign: 'center' },
  photoPreview: { width: '100%', height: 240, borderRadius: 16, marginBottom: 16 },
  photoPlaceholder: { width: '100%', height: 200, borderRadius: 16, backgroundColor: Colors.surface, justifyContent: 'center', alignItems: 'center', marginBottom: 16, borderWidth: 2, borderColor: Colors.border, borderStyle: 'dashed' },
  row: { flexDirection: 'row', gap: 12, width: '100%', marginBottom: 16 },
  choiceBtn: { flex: 1, backgroundColor: Colors.surface, padding: 16, borderRadius: 12, alignItems: 'center', borderWidth: 1, borderColor: Colors.border },
  choiceBtnText: { color: Colors.text, fontSize: 15, fontWeight: '600' },
  navRow: { flexDirection: 'row', justifyContent: 'space-between', width: '100%', marginTop: 16 },
  backText: { color: Colors.textDim, fontSize: 15, fontWeight: '500', padding: 8 },
  nextBtn: { backgroundColor: Colors.accent, paddingVertical: 10, paddingHorizontal: 24, borderRadius: 10 },
  nextBtnText: { color: Colors.white, fontSize: 15, fontWeight: '700' },
  micBtn: { width: 120, height: 120, borderRadius: 60, backgroundColor: Colors.accent, justifyContent: 'center', alignItems: 'center', marginBottom: 24, elevation: 8 },
  textInput: { width: '100%', backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, borderRadius: 12, padding: 14, color: Colors.text, fontSize: 15, textAlignVertical: 'top', marginBottom: 16 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
  chip: { paddingVertical: 10, paddingHorizontal: 14, borderRadius: 10, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border },
  chipActive: { borderColor: Colors.accent, backgroundColor: 'rgba(124,58,237,0.12)' },
  chipText: { color: Colors.text, fontSize: 14, fontWeight: '600' },
  summaryCard: { backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, borderRadius: 14, padding: 18, width: '100%', marginBottom: 16 },
  summaryRow: { color: Colors.text, fontSize: 14, marginBottom: 6 },
  summaryDesc: { color: Colors.textDim, fontSize: 13, fontStyle: 'italic', marginTop: 4 },
  queueBadge: { backgroundColor: 'rgba(245,158,11,0.1)', borderWidth: 1, borderColor: 'rgba(245,158,11,0.25)', borderRadius: 8, padding: 8, marginTop: 16 },
  queueText: { color: '#f59e0b', fontSize: 12, fontWeight: '600', textAlign: 'center' },
  offlineText: { color: Colors.textDim, fontSize: 12, marginTop: 8, textAlign: 'center' },
});
