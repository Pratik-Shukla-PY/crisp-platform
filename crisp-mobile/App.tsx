/**
 * CRISP Mobile — Crisis Response Intelligence & Situation Platform
 * React Native Android App — Offline-first crisis reporting.
 *
 * Screen flow: Home → Photo → Audio → Review → Send → Success
 */
import React, { useEffect, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  ScrollView, TextInput, Alert, Image, StatusBar, Platform,
  Keyboard, TouchableWithoutFeedback, KeyboardAvoidingView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors } from './constants/colors';
import { t, setLanguage, detectLanguage, getAvailableLanguages } from './services/i18n';
import { initDatabase, enqueueReport, getQueueCount } from './services/database';
import { processQueue } from './services/syncEngine';
import NetInfo from '@react-native-community/netinfo';
import * as crypto from 'expo-crypto';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import * as FileSystem from 'expo-file-system';
import { useAudioRecorder, AudioModule } from 'expo-audio';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { detectNetworkTier, getAdaptiveConfig, getCurrentTier } from './services/networkAdaptive';
import { getHistory, getImpactStats, markHistoryDeletionRequested, updateHistoryStatus, HistoryReport } from './services/database';
import { getDeviceStatusSince, deleteReportFromServer } from './services/api';

type Screen = 'home' | 'photo' | 'audio' | 'review' | 'send' | 'success' | 'history';

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
  const [isRecording, setIsRecording] = useState(false);
  const [deviceHash, setDeviceHash] = useState('');
  const [history, setHistory] = useState<HistoryReport[]>([]);
  const [impactStats, setImpactStats] = useState({ totalLives: 0, resolvedCount: 0 });
  const audioRecorder = useAudioRecorder({
    extension: '.m4a', sampleRate: 44100, numberOfChannels: 1, bitRate: 128000,
    android: { audioEncoder: 'aac' as any, outputFormat: 'mpeg4' as any },
    ios: { audioQuality: 96 as any, outputFormat: 'aac' as any },
    web: { mimeType: 'audio/webm', bitsPerSecond: 128000 },
  });

  // Store base64 separately from URI (URI for preview, base64 for upload)
  const [photoBase64, setPhotoBase64] = useState<string | null>(null);

  const takePhoto = async () => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Camera access is required to take photos.');
      return;
    }
    // Adaptive compression based on network speed
    await detectNetworkTier();
    const config = getAdaptiveConfig();
    console.log(`[Camera] Network: ${config.tier}, quality: ${config.imageQuality}, maxWidth: ${config.imageMaxWidth}`);

    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images'],
      quality: config.imageQuality,
      base64: true,
    });
    if (!result.canceled && result.assets[0]) {
      setPhotoUri(result.assets[0].uri);
      if (result.assets[0].base64) {
        setPhotoBase64(result.assets[0].base64);
        console.log(`[Camera] Photo: ${Math.round(result.assets[0].base64.length / 1024)}KB (${config.tier})`);
      }
    }
  };

  const pickImage = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Gallery access is required.');
      return;
    }
    await detectNetworkTier();
    const config = getAdaptiveConfig();

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: config.imageQuality,
      base64: true,
    });
    if (!result.canceled && result.assets[0]) {
      setPhotoUri(result.assets[0].uri);
      if (result.assets[0].base64) {
        setPhotoBase64(result.assets[0].base64);
        console.log(`[Gallery] Photo: ${Math.round(result.assets[0].base64.length / 1024)}KB (${config.tier})`);
      }
    }
  };

  const startRecording = async () => {
    try {
      const status = await AudioModule.requestRecordingPermissionsAsync();
      if (!status.granted) {
        Alert.alert('Permission needed', 'Microphone access is required.');
        return;
      }
      // iOS requires audio mode to be set before recording
      await AudioModule.setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });

      // Adaptive audio bitrate based on network speed
      await detectNetworkTier();
      const config = getAdaptiveConfig();
      const adaptiveBitrate = config.audioBitrate * 1000; // kbps → bps
      console.log(`[Audio] Network: ${config.tier}, bitrate: ${config.audioBitrate}kbps`);
      await audioRecorder.prepareToRecordAsync({ bitRate: adaptiveBitrate });

      audioRecorder.record();
      setIsRecording(true);
    } catch (e: any) {
      console.error('[Audio] Start failed:', e);
      Alert.alert('Error', `Could not start recording: ${e.message || 'unknown'}`);
    }
  };

  const stopRecording = async () => {
    try {
      await audioRecorder.stop();
      setIsRecording(false);
      const uri = audioRecorder.uri;
      if (uri) {
        setAudioUri(uri);
        console.log('[Audio] Recorded:', uri);
      }
      // Reset audio mode for playback
      await AudioModule.setAudioModeAsync({ allowsRecording: false });
    } catch (e: any) {
      console.error('[Audio] Stop failed:', e);
      setIsRecording(false);
    }
  };

  const getLocation = async () => {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') return;
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      setLocation({ lat: loc.coords.latitude, lng: loc.coords.longitude, acc: loc.coords.accuracy || 0 });
      // Reverse geocode
      try {
        const geo = await Location.reverseGeocodeAsync({ latitude: loc.coords.latitude, longitude: loc.coords.longitude });
        if (geo[0]) {
          const parts = [geo[0].name, geo[0].city, geo[0].region].filter(Boolean);
          setLocationName(parts.join(', '));
        }
      } catch {}
    } catch {}
  };

  useEffect(() => {
    const detected = detectLanguage();
    setLanguage(detected);
    setLang(detected);
    initDatabase();
    updateQueueCount();
    getLocation();
    // Stable device hash (persist across sessions for status tracking)
    AsyncStorage.getItem('crisp_device_hash').then(async (stored) => {
      if (stored) { setDeviceHash(stored); } else {
        const hash = `ANDROID-${crypto.randomUUID().substring(0, 12)}`;
        await AsyncStorage.setItem('crisp_device_hash', hash);
        setDeviceHash(hash);
      }
    });
    // Load history
    refreshHistory();
    // Network listener — sync silently in background, never show errors
    const unsub = NetInfo.addEventListener(state => {
      const online = !!(state.isConnected && state.isInternetReachable);
      setIsOnline(online);
      if (online) processQueue().then(updateQueueCount).catch(() => {});
    });
    const interval = setInterval(async () => {
      try {
        const net = await NetInfo.fetch();
        if (net.isConnected) { await processQueue(); await updateQueueCount(); }
      } catch {}
    }, 30000);
    return () => { unsub(); clearInterval(interval); };
  }, []);

  const updateQueueCount = async () => setQueueCount(await getQueueCount());
  const refreshHistory = async () => {
    try {
      setHistory(await getHistory());
      setImpactStats(await getImpactStats());
    } catch {}
  };
  const pollStatus = async () => {
    if (!deviceHash || !isOnline) return;
    try {
      const lastPoll = await AsyncStorage.getItem('crisp_last_poll');
      const updates = await getDeviceStatusSince(deviceHash, lastPoll || undefined);
      for (const u of updates) {
        await updateHistoryStatus(u.id, u.status, u.lives_impacted);
      }
      await AsyncStorage.setItem('crisp_last_poll', new Date().toISOString());
      await refreshHistory();
    } catch {}
  };
  const changeLang = (code: string) => { setLanguage(code); setLang(code); };
  const resetReport = () => {
    setPhotoUri(null); setPhotoBase64(null); setAudioUri(null); setDescription('');
    setInfraType('ROAD'); setSeverity('MODERATE');
    setLocation(null); setLocationName(''); setIsSending(false); setReportId('');
  };

  const submitReport = async () => {
    setIsSending(true);
    try {
      const clientId = crypto.randomUUID();

      // ── ALL LOCAL — no network calls here ──
      // Photo: already captured as base64 from ImagePicker (no network needed)
      const photoData = photoBase64 ? `data:image/jpeg;base64,${photoBase64}` : null;

      // Audio: read local file as base64 (no network needed)
      let audioData: string | null = null;
      if (audioUri) {
        try {
          const b64 = await FileSystem.readAsStringAsync(audioUri, { encoding: 'base64' as any });
          audioData = `data:audio/m4a;base64,${b64}`;
        } catch (e) {
          console.warn('[Offline] Audio read failed (file may be gone):', e);
        }
      }

      const meta = {
        device_hash: deviceHash || `ANDROID-${crypto.randomUUID().substring(0, 8)}`,
        client_report_id: clientId, source: 'ANDROID', severity, infrastructure_type: infraType,
        description: description || '', detected_language: lang,
        expected_media: (photoData ? 1 : 0) + (audioData ? 1 : 0),
        ...(location ? { location: { latitude: location.lat, longitude: location.lng, device_latitude: location.lat, device_longitude: location.lng, accuracy_meters: location.acc || 0, device_location_name: locationName || null } } : {}),
      };

      // Save to LOCAL SQLite — works 100% offline, no network needed
      await enqueueReport({ client_report_id: clientId, meta: JSON.stringify(meta), photo: photoData, audio: audioData, text_description: description, status: 'pending_sync' });
      setReportId(clientId.substring(0, 8));
      await updateQueueCount();

      // Show success immediately — data is safe in local DB
      setScreen('success');

      // Try background sync SILENTLY — never show errors to user
      // If offline, sync will happen automatically when network returns
      processQueue().then(updateQueueCount).catch(() => {});

    } catch (e: any) {
      console.error('[Submit] Local save error:', e);
      Alert.alert('Error', 'Could not save report locally. Please try again.');
    }
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
    <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
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

          <TouchableOpacity style={{ backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, paddingVertical: 14, borderRadius: 12, marginTop: 12, width: '100%', alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 8 }}
            onPress={() => { refreshHistory(); pollStatus(); setScreen('history'); }}>
            <Text style={{ color: Colors.text, fontSize: 15, fontWeight: '600' }}>📋 My Reports</Text>
            {impactStats.totalLives > 0 && <Text style={{ color: Colors.green, fontSize: 12, fontWeight: '700' }}>💚 {impactStats.totalLives} lives saved</Text>}
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
            <TouchableOpacity style={s.choiceBtn} onPress={takePhoto}><Text style={s.choiceBtnText}>📷 {t('camera')}</Text></TouchableOpacity>
            <TouchableOpacity style={s.choiceBtn} onPress={pickImage}><Text style={s.choiceBtnText}>📁 {t('browse')}</Text></TouchableOpacity>
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
          <TouchableOpacity style={[s.micBtn, isRecording && { backgroundColor: Colors.red }]}
            onPress={isRecording ? stopRecording : startRecording}>
            <Text style={{ fontSize: 40 }}>{isRecording ? '⏹' : '🎤'}</Text>
            <Text style={{ color: Colors.white, fontSize: 12, fontWeight: '600', marginTop: 4 }}>
              {isRecording ? t('stop') : t('tap_mic')}
            </Text>
          </TouchableOpacity>
          {audioUri && <Text style={{ color: Colors.green, fontSize: 12, marginBottom: 8 }}>✅ Audio recorded</Text>}
          <TextInput style={s.textInput} placeholder={t('type_text')} placeholderTextColor={Colors.textDim} value={description} onChangeText={setDescription} multiline numberOfLines={4} returnKeyType="done" blurOnSubmit={true} onSubmitEditing={Keyboard.dismiss} />
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

      {screen === 'history' && (
        <ScrollView style={{ flex: 1, backgroundColor: Colors.bg }} contentContainerStyle={{ padding: 20 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <TouchableOpacity onPress={() => setScreen('home')}><Text style={s.backText}>← Back</Text></TouchableOpacity>
            <TouchableOpacity onPress={() => { pollStatus(); refreshHistory(); }}>
              <Text style={{ color: Colors.cyan, fontSize: 13, fontWeight: '600' }}>🔄 Refresh</Text>
            </TouchableOpacity>
          </View>

          {/* Impact Stats */}
          {impactStats.totalLives > 0 && (
            <View style={{ backgroundColor: 'rgba(34,197,94,0.1)', borderWidth: 1, borderColor: 'rgba(34,197,94,0.3)', borderRadius: 14, padding: 16, marginBottom: 16, alignItems: 'center' }}>
              <Text style={{ fontSize: 36, fontWeight: '900', color: Colors.green }}>{impactStats.totalLives}</Text>
              <Text style={{ fontSize: 14, color: Colors.green, fontWeight: '600' }}>Lives Saved</Text>
              <Text style={{ fontSize: 12, color: Colors.textDim, marginTop: 4 }}>across {impactStats.resolvedCount} resolved incidents</Text>
            </View>
          )}

          <Text style={{ fontSize: 18, fontWeight: '800', color: Colors.text, marginBottom: 12 }}>My Reports</Text>

          {history.length === 0 ? (
            <View style={{ alignItems: 'center', padding: 32 }}>
              <Text style={{ fontSize: 48, marginBottom: 12 }}>📋</Text>
              <Text style={{ color: Colors.textDim, fontSize: 14, textAlign: 'center' }}>No reports yet.{'\n'}Your first report could save lives.</Text>
            </View>
          ) : (
            history.map((h) => {
              const typeEmoji: Record<string, string> = { ROAD: '🛣', HOSPITAL: '🏥', HOUSE: '🏠', POWER: '⚡', WATER: '💧', OTHER: '❓' };
              const statusColor: Record<string, string> = { PENDING: '#64748b', VERIFIED: '#38bdf8', RESPONDING: '#f59e0b', RESOLVED: '#22c55e', FALSE_ALARM: '#ef4444' };
              const sc = statusColor[h.status] || '#64748b';
              return (
                <View key={h.client_report_id} style={{ backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, borderRadius: 12, padding: 14, marginBottom: 8 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    <Text style={{ fontSize: 28 }}>{typeEmoji[h.infrastructure_type] || '❓'}</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: Colors.text, fontSize: 14, fontWeight: '700' }}>{(h.infrastructure_type || 'OTHER').replace(/_/g, ' ')}</Text>
                      <Text style={{ color: Colors.textDim, fontSize: 11 }}>{h.description?.substring(0, 50) || 'No description'}</Text>
                    </View>
                    <View style={{ backgroundColor: sc + '20', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 }}>
                      <Text style={{ color: sc, fontSize: 10, fontWeight: '800' }}>{h.status}</Text>
                    </View>
                  </View>
                  {h.lives_impacted && h.lives_impacted > 0 ? (
                    <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8, gap: 4 }}>
                      <Text style={{ fontSize: 12, color: Colors.green, fontWeight: '700' }}>💚 {h.lives_impacted} lives impacted</Text>
                    </View>
                  ) : null}
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 }}>
                    <Text style={{ color: Colors.textDim, fontSize: 10 }}>{new Date(h.synced_at).toLocaleDateString()}</Text>
                    <TouchableOpacity onPress={() => {
                      Alert.alert('Delete Report?', 'This report will be permanently deleted within 30 minutes.', [
                        { text: 'Cancel', style: 'cancel' },
                        { text: 'Delete', style: 'destructive', onPress: async () => {
                          try {
                            if (h.server_id) await deleteReportFromServer(h.server_id);
                            await markHistoryDeletionRequested(h.client_report_id);
                            await refreshHistory();
                          } catch (e) { Alert.alert('Error', 'Could not delete. Try again when online.'); }
                        }},
                      ]);
                    }}>
                      <Text style={{ color: Colors.red, fontSize: 12, fontWeight: '600' }}>🗑 Delete</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              );
            })
          )}
        </ScrollView>
      )}
    </SafeAreaView>
    </TouchableWithoutFeedback>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  screen: { flex: 1, padding: 24, justifyContent: 'center', alignItems: 'center' },
  emoji: { fontSize: 96, marginBottom: 20 },
  title: { fontSize: 32, fontWeight: '900', color: Colors.text, textAlign: 'center', marginBottom: 8, letterSpacing: -0.5 },
  subtitle: { fontSize: 17, color: Colors.textDim, textAlign: 'center', marginBottom: 28, lineHeight: 24 },
  stepLabel: { fontSize: 12, fontWeight: '700', color: Colors.accent, textAlign: 'center', marginBottom: 8, letterSpacing: 1 },
  label: { fontSize: 13, fontWeight: '700', color: Colors.textDim, marginTop: 16, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 },
  langRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8, marginBottom: 32 },
  langBtn: { padding: 8, borderRadius: 8, borderWidth: 1, borderColor: Colors.border },
  langBtnActive: { borderColor: Colors.accent, backgroundColor: 'rgba(124,58,237,0.1)' },
  langFlag: { fontSize: 22 },
  bigBtn: { backgroundColor: Colors.accent, paddingVertical: 20, paddingHorizontal: 48, borderRadius: 18, marginTop: 16, width: '100%', alignItems: 'center', elevation: 8, minHeight: 64 },
  bigBtnText: { color: Colors.white, fontSize: 20, fontWeight: '900', letterSpacing: 1.5 },
  piiWarning: { backgroundColor: 'rgba(234,179,8,0.1)', borderWidth: 1, borderColor: 'rgba(234,179,8,0.25)', borderRadius: 10, padding: 10, marginBottom: 12, width: '100%' },
  piiText: { color: '#d97706', fontSize: 12, textAlign: 'center' },
  photoPreview: { width: '100%', height: 240, borderRadius: 16, marginBottom: 16 },
  photoPlaceholder: { width: '100%', height: 200, borderRadius: 16, backgroundColor: Colors.surface, justifyContent: 'center', alignItems: 'center', marginBottom: 16, borderWidth: 2, borderColor: Colors.border, borderStyle: 'dashed' },
  row: { flexDirection: 'row', gap: 12, width: '100%', marginBottom: 16 },
  choiceBtn: { flex: 1, backgroundColor: Colors.surface, padding: 24, borderRadius: 16, alignItems: 'center', borderWidth: 1, borderColor: Colors.border, minHeight: 100, justifyContent: 'center' },
  choiceBtnText: { color: Colors.text, fontSize: 18, fontWeight: '700' },
  navRow: { flexDirection: 'row', justifyContent: 'space-between', width: '100%', marginTop: 16 },
  backText: { color: Colors.textDim, fontSize: 15, fontWeight: '500', padding: 8 },
  nextBtn: { backgroundColor: Colors.accent, paddingVertical: 10, paddingHorizontal: 24, borderRadius: 10 },
  nextBtnText: { color: Colors.white, fontSize: 15, fontWeight: '700' },
  micBtn: { width: 160, height: 160, borderRadius: 80, backgroundColor: Colors.accent, justifyContent: 'center', alignItems: 'center', marginBottom: 24, elevation: 10 },
  textInput: { width: '100%', backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, borderRadius: 12, padding: 14, color: Colors.text, fontSize: 15, textAlignVertical: 'top', marginBottom: 16 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
  chip: { paddingVertical: 16, paddingHorizontal: 18, borderRadius: 14, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, minWidth: '30%', alignItems: 'center' },
  chipActive: { borderColor: Colors.accent, backgroundColor: 'rgba(124,58,237,0.12)' },
  chipText: { color: Colors.text, fontSize: 14, fontWeight: '600' },
  summaryCard: { backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, borderRadius: 14, padding: 18, width: '100%', marginBottom: 16 },
  summaryRow: { color: Colors.text, fontSize: 14, marginBottom: 6 },
  summaryDesc: { color: Colors.textDim, fontSize: 13, fontStyle: 'italic', marginTop: 4 },
  queueBadge: { backgroundColor: 'rgba(245,158,11,0.1)', borderWidth: 1, borderColor: 'rgba(245,158,11,0.25)', borderRadius: 8, padding: 8, marginTop: 16 },
  queueText: { color: '#f59e0b', fontSize: 12, fontWeight: '600', textAlign: 'center' },
  offlineText: { color: Colors.textDim, fontSize: 12, marginTop: 8, textAlign: 'center' },
});
