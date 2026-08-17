import React, { useState, useRef, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput,
  PanResponder, Animated, Vibration, GestureResponderEvent
} from 'react-native';
import { useWebSocket, WSStatus } from '../hooks/useWebSocket';

interface Props {
  url: string;
  onDisconnect: () => void;
}

// 'show' starts a slideshow; the rest set ActiveWindow.ViewType on the document window.
const VIEWS = [
  { key: 'normal', label: 'Normal' },
  { key: 'sorter', label: 'Sorter' },
  { key: 'reading', label: 'Reading' },
  { key: 'show', label: 'Present' },
] as const;

function StatusBadge({ wsStatus }: { wsStatus: WSStatus }) {
  const connected = wsStatus === 'connected';
  return (
    <View style={styles.statusRow}>
      <View style={[styles.badge, connected && styles.badgeActive]}>
        <View style={[styles.dot, connected && styles.dotActive]} />
        <Text style={[styles.badgeText, connected && styles.badgeTextActive]}>
          {connected ? 'Connected' : wsStatus === 'connecting' ? 'Connecting...' : 'Reconnecting...'}
        </Text>
      </View>
    </View>
  );
}

/**
 * Absolute-mapped trackpad: the pad represents the whole screen, so touching the
 * top-left puts the laser top-left. Relative/mouse-style dragging would drift out of
 * sync with the real cursor and make "where the laser is" a lie.
 *
 * The dot follows your finger locally while dragging (instant), and falls back to the
 * PC's real cursor position between drags — so it stays honest even if someone
 * nudges the physical mouse.
 */
function LaserPad({ pointer, onMove, onActiveChange }: {
  pointer: { x: number; y: number };
  onMove: (x: number, y: number) => void;
  onActiveChange: (active: boolean) => void;
}) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [localDot, setLocalDot] = useState<{ x: number; y: number } | null>(null);

  const sizeRef = useRef(size);
  sizeRef.current = size;
  const lastSent = useRef(0);

  const handle = useCallback((e: GestureResponderEvent, force = false) => {
    const { w, h } = sizeRef.current;
    if (!w || !h) return;
    const x = Math.min(1, Math.max(0, e.nativeEvent.locationX / w));
    const y = Math.min(1, Math.max(0, e.nativeEvent.locationY / h));
    setLocalDot({ x, y });

    // Throttle the stream, but always send the final position on release so the
    // laser ends exactly where the finger lifted.
    const now = Date.now();
    if (force || now - lastSent.current >= 50) {
      lastSent.current = now;
      onMove(x, y);
    }
  }, [onMove]);

  // PanResponder is built once; refs keep it pointed at the latest callbacks.
  const handleRef = useRef(handle);
  handleRef.current = handle;
  const activeRef = useRef(onActiveChange);
  activeRef.current = onActiveChange;

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      // Don't let the parent's swipe handler steal a drag in progress.
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: e => { activeRef.current(true); handleRef.current(e); },
      onPanResponderMove: e => handleRef.current(e),
      onPanResponderRelease: e => {
        handleRef.current(e, true);
        activeRef.current(false);
        setLocalDot(null);
      },
      onPanResponderTerminate: () => { activeRef.current(false); setLocalDot(null); },
    })
  ).current;

  const dot = localDot ?? pointer;
  const DOT = 14;

  return (
    <View
      style={styles.pad}
      onLayout={e => setSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
      {...pan.panHandlers}
    >
      {size.w > 0 && (
        <View
          pointerEvents="none"
          style={[
            styles.padDot,
            {
              left: dot.x * size.w - DOT / 2,
              top: dot.y * size.h - DOT / 2,
              opacity: localDot ? 1 : 0.55,
            },
          ]}
        />
      )}
      <Text style={styles.padHint} pointerEvents="none">
        drag to aim the laser
      </Text>
    </View>
  );
}

export default function RemoteScreen({ url, onDisconnect }: Props) {
  const [gotoValue, setGotoValue] = useState('');
  const slideAnim = useRef(new Animated.Value(0)).current;

  const ws = useWebSocket(url);
  const slide = ws.slide;

  const send = useCallback((action: string, extra?: Record<string, unknown>) => {
    Vibration.vibrate(30);
    ws.send(action, extra);

    Animated.sequence([
      Animated.timing(slideAnim, { toValue: 1, duration: 100, useNativeDriver: true }),
      Animated.timing(slideAnim, { toValue: 0, duration: 150, useNativeDriver: true }),
    ]).start();
  }, [ws, slideAnim]);

  const goTo = () => {
    const n = parseInt(gotoValue);
    if (n > 0) { send('goto', { slide: n }); setGotoValue(''); }
  };

  // Raw send: pointer moves stream continuously, so no haptic buzz and no slide-number
  // pulse — both would fire dozens of times per drag.
  const movePointer = useCallback((x: number, y: number) => {
    ws.send('pointer', { x, y });
  }, [ws]);

  // While the trackpad owns the touch, the page-swipe must stand down or a drag
  // would flip slides instead of aiming.
  const padActive = useRef(false);

  // Swipe gesture
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_, g) =>
        !padActive.current && Math.abs(g.dx) > 20 && Math.abs(g.dy) < 40,
      onPanResponderRelease: (_, g) => {
        if (Math.abs(g.dx) > 60) {
          g.dx < 0 ? send('next') : send('prev');
        }
      },
    })
  ).current;

  const scale = slideAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 1.15] });
  const color = slideAnim.interpolate({ inputRange: [0, 1], outputRange: ['#ffffff', '#4f8ef7'] });

  const isConnected = ws.status === 'connected';
  const hasDeck = isConnected && slide.status === 'ok';
  const inShow = hasDeck && slide.mode === 'show';

  // Distinguish "PowerPoint isn't running" from "it's running with nothing open",
  // so a blank screen always says why.
  const waitingMsg = !isConnected
    ? 'Not connected'
    : slide.status === 'nopowerpoint'
      ? 'Waiting for PowerPoint…'
      : slide.status === 'nopresentation'
        ? 'Open a presentation'
        : null;

  return (
    <View style={styles.container} {...panResponder.panHandlers}>
      <StatusBadge wsStatus={ws.status} />

      <View style={styles.slideInfo}>
        <Animated.Text style={[styles.slideNum, { transform: [{ scale }], color }]}>
          {hasDeck && slide.current ? slide.current : '—'}
        </Animated.Text>
        <Text style={styles.slideTotal}>
          {waitingMsg ?? `of ${slide.total} slides`}
        </Text>
        {hasDeck && !!slide.name && (
          <Text style={styles.deckName} numberOfLines={1}>{slide.name}</Text>
        )}
      </View>

      <View style={styles.viewRow}>
        {VIEWS.map(v => {
          const active = slide.mode === v.key;
          return (
            <TouchableOpacity
              key={v.key}
              style={[styles.viewBtn, active && styles.viewBtnActive]}
              onPress={() => send('view', { mode: v.key })}
              activeOpacity={0.7}
            >
              <Text style={[styles.viewBtnText, active && styles.viewBtnTextActive]}>
                {v.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {inShow && (
        <>
          <TouchableOpacity
            style={[styles.laserBtn, slide.laser && styles.laserBtnOn]}
            onPress={() => send('laser', { on: !slide.laser })}
            activeOpacity={0.7}
          >
            <Text style={[styles.laserText, slide.laser && styles.laserTextOn]}>
              {slide.laser ? '● Laser ON' : '○ Laser Pointer'}
            </Text>
          </TouchableOpacity>

          <LaserPad
            pointer={slide.pointer}
            onMove={movePointer}
            onActiveChange={a => { padActive.current = a; }}
          />
        </>
      )}

      <View style={styles.controls}>
        <TouchableOpacity style={styles.btnPrev} onPress={() => send('prev')} activeOpacity={0.7}>
          <Text style={styles.btnIcon}>←</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.btnNext} onPress={() => send('next')} activeOpacity={0.7}>
          <Text style={styles.btnIcon}>→</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.gotoRow}>
        <TextInput
          style={styles.gotoInput}
          value={gotoValue}
          onChangeText={setGotoValue}
          placeholder="Slide #"
          placeholderTextColor="#444"
          keyboardType="number-pad"
          returnKeyType="go"
          onSubmitEditing={goTo}
        />
        <TouchableOpacity style={styles.gotoBtn} onPress={goTo}>
          <Text style={styles.gotoBtnText}>Go</Text>
        </TouchableOpacity>
      </View>

      <TouchableOpacity onPress={onDisconnect}>
        <Text style={styles.disconnectLink}>Scan new QR code</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f0f0f',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 28,
    paddingHorizontal: 20,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#1a1a1a',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#2a2a2a',
  },
  badgeActive: {
    borderColor: '#4ade80',
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#333',
  },
  dotActive: {
    backgroundColor: '#4ade80',
  },
  badgeText: {
    color: '#555',
    fontSize: 12,
    fontWeight: '600',
  },
  badgeTextActive: {
    color: '#4ade80',
  },
  slideInfo: {
    alignItems: 'center',
  },
  slideNum: {
    fontSize: 78,
    fontWeight: '800',
    lineHeight: 82,
    color: '#fff',
  },
  viewRow: {
    flexDirection: 'row',
    gap: 8,
    width: '100%',
  },
  viewBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: '#1a1a1a',
    borderWidth: 1,
    borderColor: '#2a2a2a',
    alignItems: 'center',
  },
  viewBtnActive: {
    backgroundColor: '#16233a',
    borderColor: '#4f8ef7',
  },
  viewBtnText: {
    color: '#666',
    fontSize: 12,
    fontWeight: '600',
  },
  viewBtnTextActive: {
    color: '#4f8ef7',
  },
  laserBtn: {
    width: '100%',
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: '#1a1a1a',
    borderWidth: 1,
    borderColor: '#2a2a2a',
    alignItems: 'center',
  },
  laserBtnOn: {
    backgroundColor: '#2a1416',
    borderColor: '#ef4444',
  },
  laserText: {
    color: '#666',
    fontSize: 13,
    fontWeight: '600',
  },
  laserTextOn: {
    color: '#ef4444',
  },
  // 16:9 so the pad's shape matches the screen it maps onto.
  pad: {
    width: '100%',
    aspectRatio: 16 / 9,
    maxHeight: 150,
    borderRadius: 14,
    backgroundColor: '#141414',
    borderWidth: 1,
    borderColor: '#2a2a2a',
    overflow: 'hidden',
  },
  padDot: {
    position: 'absolute',
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#ef4444',
  },
  padHint: {
    position: 'absolute',
    bottom: 6,
    alignSelf: 'center',
    color: '#333',
    fontSize: 10,
  },
  slideTotal: {
    color: '#444',
    fontSize: 16,
    marginTop: 4,
  },
  deckName: {
    color: '#4f8ef7',
    fontSize: 12,
    marginTop: 6,
    maxWidth: 260,
    textAlign: 'center',
  },
  controls: {
    flexDirection: 'row',
    gap: 16,
    width: '100%',
  },
  btnPrev: {
    flex: 1,
    height: 88,
    backgroundColor: '#1e1e1e',
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnNext: {
    flex: 1,
    height: 88,
    backgroundColor: '#4f8ef7',
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnIcon: {
    color: '#fff',
    fontSize: 32,
    fontWeight: '700',
  },
  gotoRow: {
    flexDirection: 'row',
    gap: 12,
    width: '100%',
  },
  gotoInput: {
    flex: 1,
    height: 52,
    backgroundColor: '#1e1e1e',
    borderRadius: 14,
    color: '#fff',
    fontSize: 16,
    textAlign: 'center',
    borderWidth: 1.5,
    borderColor: '#2a2a2a',
  },
  gotoBtn: {
    height: 52,
    paddingHorizontal: 24,
    backgroundColor: '#1e1e1e',
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: '#4f8ef7',
  },
  gotoBtnText: {
    color: '#4f8ef7',
    fontWeight: '700',
    fontSize: 15,
  },
  disconnectLink: {
    color: '#333',
    fontSize: 13,
    textDecorationLine: 'underline',
  },
});
