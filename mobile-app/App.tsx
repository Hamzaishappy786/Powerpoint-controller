import React, { useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import ScanScreen from './src/screens/ScanScreen';
import RemoteScreen from './src/screens/RemoteScreen';

export default function App() {
  const [serverUrl, setServerUrl] = useState<string | null>(null);

  return (
    <>
      <StatusBar style="light" />
      {serverUrl ? (
        <RemoteScreen url={serverUrl} onDisconnect={() => setServerUrl(null)} />
      ) : (
        <ScanScreen onConnect={setServerUrl} />
      )}
    </>
  );
}
