package com.akbar.finman;

import android.content.Intent;
import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import com.google.android.gms.auth.GoogleAuthException;
import com.google.android.gms.auth.GoogleAuthUtil;
import com.google.android.gms.auth.UserRecoverableAuthException;
import com.google.android.gms.auth.api.signin.GoogleSignIn;
import com.google.android.gms.auth.api.signin.GoogleSignInAccount;
import com.google.android.gms.auth.api.signin.GoogleSignInClient;
import com.google.android.gms.auth.api.signin.GoogleSignInOptions;
import com.google.android.gms.auth.api.signin.GoogleSignInStatusCodes;
import com.google.android.gms.common.api.ApiException;
import com.google.android.gms.common.api.Scope;
import com.google.android.gms.tasks.Task;

import java.io.IOException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * GoogleAuthBridgePlugin — Native Google Play Services Authentication for FinMan
 *
 * Provides native Google Sign-In and OAuth 2.0 Bearer access token acquisition
 * targeting the exact Drive AppData scope:
 * https://www.googleapis.com/auth/drive.appdata
 *
 * Security: Zero logging of access tokens or sensitive credentials.
 */
@CapacitorPlugin(name = "GoogleAuthBridge")
public class GoogleAuthBridgePlugin extends Plugin {

    public static final String DRIVE_APPDATA_SCOPE = "https://www.googleapis.com/auth/drive.appdata";
    public static final String OAUTH_SCOPE_STRING = "oauth2:https://www.googleapis.com/auth/drive.appdata email profile";

    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    private GoogleSignInClient getSignInClient() {
        GoogleSignInOptions options = new GoogleSignInOptions.Builder(GoogleSignInOptions.DEFAULT_SIGN_IN)
                .requestEmail()
                .requestScopes(new Scope(DRIVE_APPDATA_SCOPE))
                .build();

        return GoogleSignIn.getClient(getContext(), options);
    }

    @PluginMethod
    public void signIn(PluginCall call) {
        try {
            GoogleSignInClient client = getSignInClient();
            Intent signInIntent = client.getSignInIntent();
            startActivityForResult(call, signInIntent, "handleSignInResult");
        } catch (Exception e) {
            call.reject("Failed to initialize Google Sign-In: " + e.getMessage(), e);
        }
    }

    @ActivityCallback
    public void handleSignInResult(PluginCall call, ActivityResult result) {
        if (call == null) return;

        Intent data = result.getData();
        Task<GoogleSignInAccount> task = GoogleSignIn.getSignedInAccountFromIntent(data);

        try {
            GoogleSignInAccount account = task.getResult(ApiException.class);
            if (account == null) {
                call.reject("Google Sign-In returned null account", "NULL_ACCOUNT");
                return;
            }

            executor.execute(() -> {
                try {
                    String accessToken = GoogleAuthUtil.getToken(
                            getContext(),
                            account.getAccount(),
                            OAUTH_SCOPE_STRING
                    );

                    if (accessToken == null || accessToken.trim().isEmpty()) {
                        call.reject("Google Play Services returned empty access token", "EMPTY_TOKEN");
                        return;
                    }

                    JSObject res = new JSObject();
                    res.put("accessToken", accessToken);
                    res.put("email", account.getEmail() != null ? account.getEmail() : "");
                    res.put("displayName", account.getDisplayName() != null ? account.getDisplayName() : "");
                    res.put("expiresIn", 3500);

                    call.resolve(res);
                } catch (UserRecoverableAuthException uae) {
                    call.reject("User recovery required: " + uae.getMessage(), "USER_RECOVERY_REQUIRED");
                } catch (GoogleAuthException | IOException gae) {
                    call.reject("Failed to acquire Drive access token: " + gae.getMessage(), "AUTH_TOKEN_FAILED");
                } catch (Exception ex) {
                    call.reject("Unexpected error during token acquisition: " + ex.getMessage(), ex);
                }
            });

        } catch (ApiException e) {
            int statusCode = e.getStatusCode();
            if (statusCode == GoogleSignInStatusCodes.SIGN_IN_CANCELLED) {
                call.reject("User cancelled sign-in", "12501");
            } else if (statusCode == GoogleSignInStatusCodes.DEVELOPER_ERROR) {
                call.reject("Developer configuration error (verify SHA-1 fingerprint and package name in Google Cloud Console)", "10");
            } else if (statusCode == GoogleSignInStatusCodes.NETWORK_ERROR) {
                call.reject("Network error connecting to Google Play Services", "7");
            } else {
                call.reject("Google Sign-In failed with status code " + statusCode + ": " + e.getMessage(), String.valueOf(statusCode));
            }
        } catch (Exception ex) {
            call.reject("Sign-in handling exception: " + ex.getMessage(), ex);
        }
    }

    @PluginMethod
    public void refresh(PluginCall call) {
        executor.execute(() -> {
            try {
                GoogleSignInAccount account = GoogleSignIn.getLastSignedInAccount(getContext());
                if (account == null) {
                    call.reject("No signed-in Google account found on device", "NOT_SIGNED_IN");
                    return;
                }

                String oldToken = call.getString("oldToken", null);
                if (oldToken != null && !oldToken.trim().isEmpty()) {
                    try {
                        GoogleAuthUtil.clearToken(getContext(), oldToken.trim());
                    } catch (Exception ignored) {}
                }

                String freshToken = GoogleAuthUtil.getToken(
                        getContext(),
                        account.getAccount(),
                        OAUTH_SCOPE_STRING
                );

                if (freshToken == null || freshToken.trim().isEmpty()) {
                    call.reject("Silent token refresh returned empty token", "EMPTY_TOKEN");
                    return;
                }

                JSObject res = new JSObject();
                res.put("accessToken", freshToken);
                res.put("expiresIn", 3500);
                res.put("email", account.getEmail() != null ? account.getEmail() : "");
                res.put("displayName", account.getDisplayName() != null ? account.getDisplayName() : "");

                call.resolve(res);
            } catch (UserRecoverableAuthException uae) {
                call.reject("Silent refresh requires interactive re-consent", "USER_RECOVERY_REQUIRED");
            } catch (GoogleAuthException | IOException gae) {
                call.reject("Silent refresh failed: " + gae.getMessage(), "AUTH_TOKEN_FAILED");
            } catch (Exception ex) {
                call.reject("Unexpected error during silent token refresh: " + ex.getMessage(), ex);
            }
        });
    }

    @PluginMethod
    public void signOut(PluginCall call) {
        try {
            GoogleSignInClient client = getSignInClient();
            client.signOut().addOnCompleteListener(task -> {
                call.resolve();
            });
        } catch (Exception e) {
            call.reject("Sign out error: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void setKeepScreenOn(PluginCall call) {
        boolean enabled = call.getBoolean("enabled", true);
        if (getActivity() != null) {
            getActivity().runOnUiThread(() -> {
                try {
                    if (enabled) {
                        getActivity().getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    } else {
                        getActivity().getWindow().clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    }
                    call.resolve();
                } catch (Exception e) {
                    call.reject("Failed to set keepScreenOn: " + e.getMessage(), e);
                }
            });
        } else {
            call.resolve();
        }
    }
}
