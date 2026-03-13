const config = {
  appId: 'com.akbar.finman',
  appName: 'FinMan',
  webDir: 'dist',
  android: {
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false,
  },
  plugins: {
    CapacitorSQLite: { androidIsEncryption: false },
  },
};
module.exports = config;
