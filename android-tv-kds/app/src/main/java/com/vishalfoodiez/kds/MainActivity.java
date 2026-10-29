package com.vishalfoodiez.kds;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.Toast;

/** Android TV wrapper for kitchen.html (Live Kitchen Display). Menu / long-press OK / Settings key = change server link. */
public class MainActivity extends Activity {
    private static final String PREFS = "kds";
    private static final String KEY_URL = "url";
    private static final String DEFAULT_URL = "https://menu.vishalfoodiez.in/kitchen.html";

    private WebView web;
    private SharedPreferences prefs;
    private boolean offline = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        web = new WebView(this);
        web.setFocusable(true);
        web.setFocusableInTouchMode(true);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);                       // localStorage (ticks, size, sound setting)
        s.setMediaPlaybackRequiresUserGesture(false);       // new-order sound bina click ke bajegi
        s.setCacheMode(WebSettings.LOAD_DEFAULT);

        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                if (r.isForMainFrame()) {
                    offline = true;
                    v.postDelayed(() -> { if (offline) reload(); }, 5000);   // net aate hi khud retry
                }
            }
            @Override public void onPageFinished(WebView v, String url) { offline = false; }
        });

        web.loadUrl(prefs.getString(KEY_URL, DEFAULT_URL));
    }

    private void reload() {
        web.loadUrl(prefs.getString(KEY_URL, DEFAULT_URL));
    }

    private void askUrl(boolean first) {
        final EditText input = new EditText(this);
        input.setHint("https://your-server.com/kitchen.html");
        input.setText(prefs.getString(KEY_URL, DEFAULT_URL));
        new AlertDialog.Builder(this)
                .setTitle("Kitchen page ka link")
                .setView(input)
                .setCancelable(!first)
                .setPositiveButton("Save", (d, w) -> {
                    String u = input.getText().toString().trim();
                    if (!u.startsWith("http")) u = "http://" + u;
                    prefs.edit().putString(KEY_URL, u).apply();
                    web.loadUrl(u);
                    hideBars();
                })
                .setNegativeButton("Cancel", (d, w) -> hideBars())
                .show();
    }

    private void hideBars() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_FULLSCREEN);
    }

    @Override public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideBars();
    }

    @Override public boolean onKeyLongPress(int keyCode, KeyEvent e) {
        if (keyCode == KeyEvent.KEYCODE_DPAD_CENTER || keyCode == KeyEvent.KEYCODE_ENTER) { askUrl(false); return true; }
        return super.onKeyLongPress(keyCode, e);
    }

    @Override public boolean onKeyDown(int keyCode, KeyEvent e) {
        if (keyCode == KeyEvent.KEYCODE_MENU || keyCode == KeyEvent.KEYCODE_SETTINGS) { askUrl(false); return true; }
        if (keyCode == KeyEvent.KEYCODE_DPAD_CENTER || keyCode == KeyEvent.KEYCODE_ENTER) e.startTracking();
        return super.onKeyDown(keyCode, e);
    }

    private long lastBack = 0;

    @Override public void onBackPressed() {
        // galti se band na ho: 2 second ke andar do baar Back dabane par hi app band hogi
        long now = System.currentTimeMillis();
        if (now - lastBack < 2000) { finishAndRemoveTask(); return; }
        lastBack = now;
        Toast.makeText(this, "App band karne ke liye Back dobara dabao", Toast.LENGTH_SHORT).show();
    }

    @Override protected void onResume() { super.onResume(); web.onResume(); }
    @Override protected void onPause() { web.onPause(); super.onPause(); }
}
