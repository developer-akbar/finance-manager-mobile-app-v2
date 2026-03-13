#!/bin/bash
# Run this after: npx cap add android && npx cap sync android
# Usage: bash copy-icons.sh

echo "Copying FinMan icons to Android res folders..."

SIZES=("mdpi" "hdpi" "xhdpi" "xxhdpi" "xxxhdpi")

for SIZE in "${SIZES[@]}"; do
  SRC="public/icon-${SIZE}.png"
  DST_DIR="android/app/src/main/res/mipmap-${SIZE}"
  
  if [ ! -d "$DST_DIR" ]; then
    echo "  Creating $DST_DIR"
    mkdir -p "$DST_DIR"
  fi
  
  if [ -f "$SRC" ]; then
    cp "$SRC" "$DST_DIR/ic_launcher.png"
    cp "$SRC" "$DST_DIR/ic_launcher_round.png"
    echo "  ✓ $SIZE"
  else
    echo "  ✗ Missing $SRC"
  fi
done

echo ""
echo "Done! Now in Android Studio: Build → Clean Project → Rebuild"
