package com.vishalfoodiez.kiosk;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.util.Base64;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.Toast;

public class MainActivity extends Activity {
    private static final String PREFS = "kiosk";
    private static final String KEY_URL = "url";

    private WebView web;
    private UsbPrinter printer;
    private SharedPreferences prefs;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        printer = new UsbPrinter(this);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        web = new WebView(this);
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);          // localStorage (printer setup is stored here)
        s.setMediaPlaybackRequiresUserGesture(false);
        web.setWebViewClient(new WebViewClient());
        web.setWebChromeClient(new WebChromeClient());
        web.addJavascriptInterface(new Bridge(), "AndroidPrinter");

        String url = prefs.getString(KEY_URL, null);
        if (url == null) askUrl(true); else web.loadUrl(url);
    }

    private void askUrl(boolean first) {
        final EditText input = new EditText(this);
        input.setHint("https://your-server.com/kiosk.html");
        input.setText(prefs.getString(KEY_URL, ""));
        new AlertDialog.Builder(this)
                .setTitle("Kiosk page ka link")
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

    @Override public void onBackPressed() {
        // customer back dabaye to kiosk se bahar na jaye
    }

    /** Exposed to the page as window.AndroidPrinter */
    private class Bridge {
        @JavascriptInterface
        public String status() { return printer.describe(); }

        /** Prints base64-encoded ESC/POS bytes in the background; result is reported to window.onAndroidPrintResult(msg). */
        @JavascriptInterface
        public void print(String base64) {
            final byte[] data;
            try { data = Base64.decode(base64, Base64.DEFAULT); }
            catch (IllegalArgumentException e) { report("ERROR: bad data"); return; }
            new Thread(() -> report(printer.send(data))).start();
        }

        @JavascriptInterface
        public void toast(String msg) { runOnUiThread(() -> Toast.makeText(MainActivity.this, msg, Toast.LENGTH_LONG).show()); }

        /** Staff-only: lets the setup panel change the server link. */
        @JavascriptInterface
        public void changeUrl() { runOnUiThread(() -> askUrl(false)); }

        private void report(String msg) {
            runOnUiThread(() -> {
                if (!msg.equals("OK")) Toast.makeText(MainActivity.this, msg, Toast.LENGTH_LONG).show();
                web.evaluateJavascript("window.onAndroidPrintResult&&window.onAndroidPrintResult(" + org.json.JSONObject.quote(msg) + ")", null);
            });
        }
    }
}
