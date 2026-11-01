package com.akbar.finman;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(GoogleAuthBridgePlugin.class);
        registerPlugin(NativeSnapshotRecoveryPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
