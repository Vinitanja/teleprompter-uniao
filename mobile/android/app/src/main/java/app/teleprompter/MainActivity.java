package app.teleprompter;

import android.os.Bundle;
import android.webkit.JavascriptInterface;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // O site chama TPNative.setImmersive(true) ao dar play: esconde barra de status e de navegação do Android.
        getBridge().getWebView().addJavascriptInterface(new Object() {
            @JavascriptInterface
            public void setImmersive(final boolean on) {
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        applyImmersive(on);
                    }
                });
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

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
    }
}
