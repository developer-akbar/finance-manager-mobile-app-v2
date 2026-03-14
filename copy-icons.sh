#!/usr/bin/env bash
# FinMan — copy all icon variants into Android res folders
# Run AFTER: npm run build && npx cap sync android
# Then in Android Studio: Build → Clean Project → Rebuild → Run

set -e
ANDROID="android/app/src/main/res"

if [ ! -d "$ANDROID" ]; then
  echo "Android folder not found. Run: npx cap add android && npx cap sync android"
  exit 1
fi

echo "Copying launcher icons..."
for DPI in mdpi hdpi xhdpi xxhdpi xxxhdpi; do
  cp public/icon-${DPI}.png "$ANDROID/mipmap-${DPI}/ic_launcher.png"
  cp public/icon-${DPI}.png "$ANDROID/mipmap-${DPI}/ic_launcher_round.png"
done

echo "Copying adaptive icon foreground (fixes Expo/default icon on Android 8+)..."
for DPI in mdpi hdpi xhdpi xxhdpi xxxhdpi; do
  cp public/icon-foreground-${DPI}.png "$ANDROID/mipmap-${DPI}/ic_launcher_foreground.png"
done

echo "All icons copied."
echo "Next: Android Studio -> Build -> Clean Project -> Rebuild -> Run"
