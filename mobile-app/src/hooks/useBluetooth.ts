import { useEffect, useRef, useState, useCallback } from 'react';
import { BleManager, Device, Characteristic } from 'react-native-ble-plx';
import { PermissionsAndroid, Platform } from 'react-native';
import { Buffer } from 'buffer';

// Must match the Python BLE server constants
const SERVICE_UUID = '12345678-1234-1234-1234-123456789abc';
const CMD_CHAR_UUID = '12345678-1234-1234-1234-123456789ab1';
const STATE_CHAR_UUID = '12345678-1234-1234-1234-123456789ab2';
const DEVICE_NAME = 'PPTX-Remote';

export type BLEStatus = 'idle' | 'scanning' | 'connecting' | 'connected' | 'unavailable';

export interface SlideState {
  current: number;
  total: number | string;
}

export function useBluetooth(enabled: boolean) {
  const manager = useRef<BleManager | null>(null);
  const device = useRef<Device | null>(null);
  const [status, setBLEStatus] = useState<BLEStatus>('idle');
  const [slide, setSlide] = useState<SlideState>({ current: 1, total: '?' });

  useEffect(() => {
    manager.current = new BleManager();
    return () => {
      manager.current?.destroy();
    };
  }, []);

  const requestPermissions = async () => {
    if (Platform.OS !== 'android') return true;
    const granted = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    ]);
    return Object.values(granted).every(v => v === PermissionsAndroid.RESULTS.GRANTED);
  };

  const startScan = useCallback(async () => {
    if (!manager.current) return;
    const ok = await requestPermissions();
    if (!ok) { setBLEStatus('unavailable'); return; }

    setBLEStatus('scanning');

    manager.current.startDeviceScan(null, { allowDuplicates: false }, async (error, found) => {
      if (error) { setBLEStatus('unavailable'); return; }
      if (found?.name !== DEVICE_NAME) return;

      manager.current!.stopDeviceScan();
      setBLEStatus('connecting');

      try {
        const connected = await found.connect();
        await connected.discoverAllServicesAndCharacteristics();
        device.current = connected;
        setBLEStatus('connected');

        // Subscribe to state notifications
        connected.monitorCharacteristicForService(
          SERVICE_UUID,
          STATE_CHAR_UUID,
          (err, char) => {
            if (err || !char?.value) return;
            const json = Buffer.from(char.value, 'base64').toString('utf-8');
            try {
              const state = JSON.parse(json);
              setSlide({ current: state.current, total: state.total });
            } catch {}
          }
        );

        connected.onDisconnected(() => {
          setBLEStatus('scanning');
          startScan();
        });
      } catch {
        setBLEStatus('scanning');
        setTimeout(startScan, 3000);
      }
    });
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const sub = manager.current?.onStateChange((state) => {
      if (state === 'PoweredOn') {
        sub?.remove();
        startScan();
      } else if (state === 'PoweredOff' || state === 'Unsupported') {
        setBLEStatus('unavailable');
      }
    }, true);
    return () => sub?.remove();
  }, [enabled, startScan]);

  const send = useCallback(async (action: string, extra?: Record<string, unknown>) => {
    if (!device.current || status !== 'connected') return;
    const payload = Buffer.from(JSON.stringify({ action, ...extra })).toString('base64');
    try {
      await device.current.writeCharacteristicWithResponseForService(
        SERVICE_UUID, CMD_CHAR_UUID, payload
      );
    } catch {}
  }, [status]);

  return { status, slide, send };
}
