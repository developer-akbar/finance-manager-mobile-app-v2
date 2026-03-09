const config = {
  appId: 'com.akbar.finman',
  appName: 'FinMan',
  webDir: 'dist',
  plugins: {
    CapacitorSQLite: { androidIsEncryption: false, androidBiometric: { biometricAuth: false } },
  },
};
module.exports = config;
