package com.akbar.finman;

import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.WindowInsetsController;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(GoogleAuthBridgePlugin.class);
        registerPlugin(NativeSnapshotRecoveryPlugin.class);
        registerPlugin(StatusBarThemePlugin.class);
        super.onCreate(savedInstanceState);
    }

    @CapacitorPlugin(name = "StatusBarTheme")
    public static class StatusBarThemePlugin extends Plugin {
        @PluginMethod
        public void setStyle(PluginCall call) {
            boolean isLight = Boolean.TRUE.equals(call.getBoolean("isLight", false));
            String colorHex = call.getString("colorHex", isLight ? "#FFFFFF" : "#111C44");

            getActivity().runOnUiThread(() -> {
                try {
                    Window window = getActivity().getWindow();
                    int color = Color.parseColor((colorHex != null && !colorHex.isEmpty()) ? colorHex : (isLight ? "#FFFFFF" : "#111C44"));
                    window.setStatusBarColor(color);

                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                        WindowInsetsController controller = window.getInsetsController();
                        if (controller != null) {
                            if (isLight) {
                                controller.setSystemBarsAppearance(
                                    WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS,
                                    WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                                );
                            } else {
                                controller.setSystemBarsAppearance(
                                    0,
                                    WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                                );
                            }
                        }
                    } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                        View decorView = window.getDecorView();
                        int flags = decorView.getSystemUiVisibility();
                        if (isLight) {
                            flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                        } else {
                            flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                        }
                        decorView.setSystemUiVisibility(flags);
                    }
                    call.resolve();
                } catch (Exception e) {
                    call.reject(e.getMessage());
                }
            });
        }
    }
}
