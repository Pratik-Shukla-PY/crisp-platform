/**
 * Network-Aware Adaptive Media Processing & Upload Engine
 *
 * Dynamically adjusts image compression, audio compression, and chunk size
 * based on real-time network speed and stability.
 *
 * Network Classifications:
 *   FAST       — Stable, high bandwidth (WiFi/4G)
 *   MEDIUM     — Moderate bandwidth (3G+)
 *   SLOW       — Low bandwidth or unstable
 *   VERY_SLOW  — <100kbps or high jitter
 *   OFFLINE    — No connectivity
 */
import NetInfo from '@react-native-community/netinfo';

export type NetworkTier = 'FAST' | 'MEDIUM' | 'SLOW' | 'VERY_SLOW' | 'OFFLINE';

export interface AdaptiveConfig {
  tier: NetworkTier;
  // Image
  imageMaxWidth: number;
  imageQuality: number;    // 0-1
  imageMaxSizeKB: number;
  // Audio
  audioBitrate: number;    // kbps
  // Chunks
  chunkSize: number;       // bytes of base64
  parallelChunks: number;  // concurrent uploads
  maxRetries: number;
  // Backoff
  retryDelays: number[];   // ms
}

// ── Configuration per network tier ──────────────────────────────────────────

const CONFIGS: Record<NetworkTier, AdaptiveConfig> = {
  FAST: {
    tier: 'FAST',
    imageMaxWidth: 1280, imageQuality: 0.85, imageMaxSizeKB: 500,
    audioBitrate: 96,
    chunkSize: 524288,     // 512KB chunks (req: 512KB–1MB)
    parallelChunks: 5,
    maxRetries: 4,
    retryDelays: [2000, 5000, 10000, 30000],
  },
  MEDIUM: {
    tier: 'MEDIUM',
    imageMaxWidth: 1024, imageQuality: 0.65, imageMaxSizeKB: 300,
    audioBitrate: 48,
    chunkSize: 131072,     // 128KB chunks (req: 128–512KB)
    parallelChunks: 3,
    maxRetries: 5,
    retryDelays: [2000, 5000, 10000, 20000, 30000],
  },
  SLOW: {
    tier: 'SLOW',
    imageMaxWidth: 720, imageQuality: 0.50, imageMaxSizeKB: 150,
    audioBitrate: 24,
    chunkSize: 32768,      // 32KB chunks (req: 32–128KB)
    parallelChunks: 1,
    maxRetries: 8,
    retryDelays: [2000, 5000, 10000, 15000, 20000, 25000, 30000, 30000],
  },
  VERY_SLOW: {
    tier: 'VERY_SLOW',
    imageMaxWidth: 480, imageQuality: 0.35, imageMaxSizeKB: 80,
    audioBitrate: 16,
    chunkSize: 1024,       // 1KB mandatory minimum (req: 1KB)
    parallelChunks: 1,     // sequential only
    maxRetries: 15,
    retryDelays: [2000, 5000, 10000, 15000, 20000, 25000, 30000, 30000, 30000, 30000, 30000, 30000, 30000, 30000, 30000],
  },
  OFFLINE: {
    tier: 'OFFLINE',
    imageMaxWidth: 480, imageQuality: 0.35, imageMaxSizeKB: 80,
    audioBitrate: 16,
    chunkSize: 1024,
    parallelChunks: 1,
    maxRetries: 0,
    retryDelays: [],
  },
};

// ── Current network state ───────────────────────────────────────────────────

let _currentTier: NetworkTier = 'MEDIUM';
let _lastSpeedTestMs: number = 0;

/**
 * Detect current network tier from NetInfo + speed estimation
 */
export async function detectNetworkTier(): Promise<NetworkTier> {
  try {
    const state = await NetInfo.fetch();

    if (!state.isConnected || !state.isInternetReachable) {
      _currentTier = 'OFFLINE';
      return _currentTier;
    }

    const type = state.type; // wifi, cellular, etc.
    const details = state.details as any;

    // Cellular generation detection
    if (type === 'cellular') {
      const gen = details?.cellularGeneration;
      if (gen === '2g') { _currentTier = 'VERY_SLOW'; return _currentTier; }
      if (gen === '3g') { _currentTier = 'SLOW'; return _currentTier; }
      if (gen === '4g') { _currentTier = 'MEDIUM'; return _currentTier; }
      if (gen === '5g') { _currentTier = 'FAST'; return _currentTier; }
      _currentTier = 'MEDIUM';
      return _currentTier;
    }

    if (type === 'wifi') {
      // WiFi — assume FAST unless speed test says otherwise
      _currentTier = 'FAST';
      return _currentTier;
    }

    _currentTier = 'MEDIUM';
    return _currentTier;
  } catch {
    return _currentTier; // Return last known
  }
}

/**
 * Run a lightweight speed test (download a small payload, measure time)
 */
export async function runSpeedTest(apiBase: string): Promise<NetworkTier> {
  const now = Date.now();
  // Don't speed test more than once per 30 seconds
  if (now - _lastSpeedTestMs < 30000) return _currentTier;
  _lastSpeedTestMs = now;

  try {
    const start = Date.now();
    const res = await fetch(`${apiBase}/health`);
    await res.text();
    const latencyMs = Date.now() - start;

    if (latencyMs < 200) { _currentTier = 'FAST'; }
    else if (latencyMs < 800) { _currentTier = 'MEDIUM'; }
    else if (latencyMs < 3000) { _currentTier = 'SLOW'; }
    else { _currentTier = 'VERY_SLOW'; }

    console.log(`[Network] Speed test: ${latencyMs}ms → ${_currentTier}`);
  } catch {
    _currentTier = 'OFFLINE';
  }

  return _currentTier;
}

/**
 * Get current adaptive config based on detected network
 */
export function getAdaptiveConfig(): AdaptiveConfig {
  return CONFIGS[_currentTier];
}

/**
 * Get current tier
 */
export function getCurrentTier(): NetworkTier {
  return _currentTier;
}

/**
 * Downgrade tier immediately (called on upload failure)
 */
export function downgradeNetwork(): void {
  const order: NetworkTier[] = ['FAST', 'MEDIUM', 'SLOW', 'VERY_SLOW'];
  const idx = order.indexOf(_currentTier);
  if (idx < order.length - 1) {
    _currentTier = order[idx + 1];
    console.log(`[Network] Downgraded to ${_currentTier}`);
  }
}

/**
 * Upgrade tier gradually (called on successful uploads)
 */
export function upgradeNetwork(): void {
  const order: NetworkTier[] = ['FAST', 'MEDIUM', 'SLOW', 'VERY_SLOW'];
  const idx = order.indexOf(_currentTier);
  if (idx > 0) {
    _currentTier = order[idx - 1];
    console.log(`[Network] Upgraded to ${_currentTier}`);
  }
}
