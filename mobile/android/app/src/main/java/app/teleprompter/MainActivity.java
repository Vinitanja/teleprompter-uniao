package app.teleprompter;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.widget.Toast;

import androidx.core.content.FileProvider;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Ponte usada pelo site: tela cheia (esconde barras do Android) e atualização do próprio app.
        getBridge().getWebView().addJavascriptInterface(new Object() {
            @JavascriptInterface
            public void setImmersive(final boolean on) {
                runOnUiThread(new Runnable() { public void run() { applyImmersive(on); } });
            }
            @JavascriptInterface
            public int versionCode() {
                try {
                    PackageInfo p = getPackageManager().getPackageInfo(getPackageName(), 0);
                    return (int) (Build.VERSION.SDK_INT >= 28 ? p.getLongVersionCode() : p.versionCode);
                } catch (Exception e) { return 0; }
            }
            @JavascriptInterface
            public String versionName() {
                try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; }
                catch (Exception e) { return ""; }
            }
            @JavascriptInterface
            public void installUpdate(final String url) {
                runOnUiThread(new Runnable() { public void run() { startUpdate(url); } });
            }
        }, "TPNative");
    }

    private void applyImmersive(boolean on) {
        WindowCompat.setDecorFitsSystemWindows(getWindow(), !on);
        WindowInsetsControllerCompat c = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        if (on) {
            c.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            c.hide(WindowInsetsCompat.Type.systemBars());
        } else {
            c.show(WindowInsetsCompat.Type.systemBars());
        }
    }

    private void js(final String code) {
        getBridge().getWebView().post(new Runnable() {
            public void run() { getBridge().getWebView().evaluateJavascript(code, null); }
        });
    }

    private void toast(String m) { Toast.makeText(this, m, Toast.LENGTH_LONG).show(); }

    // Baixa o APK novo (só https) e abre o instalador do Android; o usuário só confirma "Instalar".
    private void startUpdate(final String url) {
        if (url == null || !url.startsWith("https://")) return;
        if (Build.VERSION.SDK_INT >= 26 && !getPackageManager().canRequestPackageInstalls()) {
            toast("Permita instalar apps por este aplicativo e toque em Atualizar de novo.");
            startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getPackageName())));
            return;
        }
        toast("Baixando atualização…");
        new Thread(new Runnable() {
            public void run() {
                try {
                    final File f = new File(getCacheDir(), "update.apk");
                    HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                    c.setInstanceFollowRedirects(true);
                    c.setConnectTimeout(20000);
                    c.setReadTimeout(60000);
                    long total = c.getContentLengthLong(), got = 0;
                    int last = -1;
                    InputStream in = c.getInputStream();
                    FileOutputStream out = new FileOutputStream(f);
                    byte[] buf = new byte[65536];
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        out.write(buf, 0, n);
                        got += n;
                        if (total > 0) {
                            int pct = (int) (got * 100 / total);
                            if (pct / 5 != last / 5) { last = pct; js("window.__tpUpdate&&window.__tpUpdate(" + pct + ")"); }
                        }
                    }
                    out.close(); in.close();
                    runOnUiThread(new Runnable() { public void run() { install(f); } });
                } catch (Exception e) {
                    js("window.__tpUpdate&&window.__tpUpdate(-1)");
                }
            }
        }).start();
    }

    private void install(File f) {
        try {
            Uri uri = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", f);
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(uri, "application/vnd.android.package-archive");
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
        } catch (Exception e) {
            toast("Não foi possível abrir o instalador.");
        }
    }
}
