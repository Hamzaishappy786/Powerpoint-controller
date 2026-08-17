import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Dimensions, ActivityIndicator
} from 'react-native';
import { CameraView, useCameraPermissions, BarcodeScanningResult } from 'expo-camera';

interface Props {
  onConnect: (url: string) => void;
}

export default function ScanScreen({ onConnect }: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);

  const handleBarcode = ({ data }: BarcodeScanningResult) => {
    if (scanned) return;
    if (!data.startsWith('http')) return;
    setScanned(true);
    onConnect(data);
  };

  if (!permission) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#4f8ef7" size="large" />
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>Camera Permission Needed</Text>
        <Text style={styles.sub}>Required to scan the QR code from your PC</Text>
        <TouchableOpacity style={styles.btn} onPress={requestPermission}>
          <Text style={styles.btnText}>Grant Permission</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.header}>Scan QR Code</Text>
      <Text style={styles.sub}>Point your camera at the QR code shown in the terminal</Text>

      <View style={styles.cameraWrap}>
        <CameraView
          style={styles.camera}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={scanned ? undefined : handleBarcode}
        />
        <View style={styles.overlay}>
          <View style={styles.corner} />
          <View style={[styles.corner, styles.topRight]} />
          <View style={[styles.corner, styles.bottomLeft]} />
          <View style={[styles.corner, styles.bottomRight]} />
        </View>
      </View>

      {scanned && (
        <TouchableOpacity style={styles.btn} onPress={() => setScanned(false)}>
          <Text style={styles.btnText}>Scan Again</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const S = Dimensions.get('window').width * 0.65;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f0f0f',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 16,
  },
  center: {
    flex: 1,
    backgroundColor: '#0f0f0f',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 16,
  },
  header: {
    color: '#fff',
    fontSize: 22,
    fontWeight: '700',
  },
  title: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
  },
  sub: {
    color: '#666',
    fontSize: 14,
    textAlign: 'center',
  },
  cameraWrap: {
    width: S,
    height: S,
    borderRadius: 16,
    overflow: 'hidden',
    position: 'relative',
    marginVertical: 16,
  },
  camera: {
    flex: 1,
  },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    pointerEvents: 'none',
  },
  corner: {
    position: 'absolute',
    width: 24,
    height: 24,
    borderColor: '#4f8ef7',
    borderTopWidth: 3,
    borderLeftWidth: 3,
    top: 10,
    left: 10,
    borderTopLeftRadius: 4,
  },
  topRight: {
    top: 10,
    left: undefined,
    right: 10,
    borderLeftWidth: 0,
    borderRightWidth: 3,
    borderTopLeftRadius: 0,
    borderTopRightRadius: 4,
  },
  bottomLeft: {
    top: undefined,
    bottom: 10,
    left: 10,
    borderTopWidth: 0,
    borderBottomWidth: 3,
    borderTopLeftRadius: 0,
    borderBottomLeftRadius: 4,
  },
  bottomRight: {
    top: undefined,
    bottom: 10,
    left: undefined,
    right: 10,
    borderTopWidth: 0,
    borderLeftWidth: 0,
    borderBottomWidth: 3,
    borderRightWidth: 3,
    borderTopLeftRadius: 0,
    borderBottomRightRadius: 4,
  },
  btn: {
    backgroundColor: '#4f8ef7',
    paddingHorizontal: 28,
    paddingVertical: 14,
    borderRadius: 14,
  },
  btnText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 15,
  },
});
