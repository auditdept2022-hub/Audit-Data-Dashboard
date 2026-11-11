package com.auditdashboard.mobile;

import android.Manifest;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.ContentValues;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Message;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceResponse;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.Locale;

public class MainActivity extends Activity {
    private static final String DASHBOARD_URL = "https://auditdashboard.devs.li/";
    private static final int FILE_CHOOSER_REQUEST = 4101;
    private static final int DOWNLOAD_PERMISSION_REQUEST = 4102;

    private FrameLayout root;
    private WebView webView;
    private ProgressBar progressBar;
    private View errorPanel;
    private ValueCallback<Uri[]> filePathCallback;
    private String pendingDownloadUrl;
    private String pendingDownloadUserAgent;
    private String pendingDownloadDisposition;
    private String pendingDownloadMimeType;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Window window = getWindow();
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);

        buildLayout();
        configureWebView();

        boolean restored = savedInstanceState != null && webView.restoreState(savedInstanceState) != null;
        if (!restored) {
            webView.loadUrl(DASHBOARD_URL);
        }
    }

    private void buildLayout() {
        root = new FrameLayout(this);
        root.setBackgroundColor(getColor(R.color.app_background));

        webView = new WebView(this);
        webView.setBackgroundColor(getColor(R.color.app_background));
        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        progressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progressBar.setMax(100);
        progressBar.setProgress(0);
        progressBar.setIndeterminate(false);
        FrameLayout.LayoutParams progressParams = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(3), Gravity.TOP);
        root.addView(progressBar, progressParams);

        errorPanel = buildErrorPanel();
        errorPanel.setVisibility(View.GONE);
        root.addView(errorPanel, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        setContentView(root);
    }

    private View buildErrorPanel() {
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setGravity(Gravity.CENTER);
        panel.setPadding(dp(28), dp(28), dp(28), dp(28));
        panel.setBackgroundColor(getColor(R.color.app_background));

        TextView title = new TextView(this);
        title.setText("You're offline or the dashboard could not be reached.");
        title.setTextColor(getColor(R.color.text_primary));
        title.setTextSize(20);
        title.setGravity(Gravity.CENTER);
        title.setPadding(0, 0, 0, dp(10));
        panel.addView(title, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView detail = new TextView(this);
        detail.setText("Check your internet connection, then try again. Your dashboard data remains on the website.");
        detail.setTextColor(getColor(R.color.text_secondary));
        detail.setTextSize(14);
        detail.setGravity(Gravity.CENTER);
        detail.setPadding(0, 0, 0, dp(18));
        panel.addView(detail, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        Button retry = new Button(this);
        retry.setText("Retry");
        retry.setOnClickListener(v -> {
            errorPanel.setVisibility(View.GONE);
            webView.setVisibility(View.VISIBLE);
            webView.loadUrl(DASHBOARD_URL);
        });
        panel.addView(retry, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        return panel;
    }

    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        // Match Chrome mobile: pinch zoom allowed (if the page allows it), no on-screen +/- buttons.
        settings.setSupportZoom(true);
        settings.setBuiltInZoomControls(true);
        settings.setDisplayZoomControls(false);
        // Fixed text size and no automatic text inflation, so the page's own CSS decides sizes and card layout.
        settings.setTextZoom(100);
        settings.setLayoutAlgorithm(WebSettings.LayoutAlgorithm.NORMAL);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(true);
        settings.setSupportMultipleWindows(true);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);

        // Present the same browser identity as Chrome so the site serves its normal mobile design.
        String ua = settings.getUserAgentString();
        if (ua != null) {
            settings.setUserAgentString(ua.replace("; wv)", ")").replace(" Version/4.0", ""));
        }
        // Lets you inspect the page from a computer (chrome://inspect) in debug builds only.
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        cookieManager.setAcceptThirdPartyCookies(webView, true);

        webView.addJavascriptInterface(new DownloadBridge(), "AndroidDownload");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return routeUrl(request.getUrl());
            }

            @Override
            @SuppressWarnings("deprecation")
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return routeUrl(Uri.parse(url));
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                errorPanel.setVisibility(View.GONE);
                webView.setVisibility(View.VISIBLE);
                progressBar.setVisibility(View.VISIBLE);
                progressBar.setProgress(5);
            }

            @Override
            public void onPageCommitVisible(WebView view, String url) {
                view.evaluateJavascript(ENSURE_VIEWPORT, null);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                progressBar.setProgress(100);
                progressBar.setVisibility(View.GONE);
                CookieManager.getInstance().flush();
                view.evaluateJavascript(DOWNLOAD_NAME_HOOK, null);
                view.evaluateJavascript(ENSURE_VIEWPORT, null);
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse errorResponse) {
                if (request.isForMainFrame() && errorResponse != null && errorResponse.getStatusCode() >= 500) {
                    showConnectionError();
                }
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    showConnectionError();
                }
            }

            @Override
            @SuppressWarnings("deprecation")
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                if (view.getUrl() == null || failingUrl.equals(view.getUrl())) {
                    showConnectionError();
                }
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                progressBar.setProgress(newProgress);
                if (newProgress >= 100) {
                    progressBar.setVisibility(View.GONE);
                } else {
                    progressBar.setVisibility(View.VISIBLE);
                }
            }

            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
                // Popups: dashboard pages load in the main view, everything else goes to the browser.
                WebView popup = new WebView(MainActivity.this);
                popup.setWebViewClient(new WebViewClient() {
                    private boolean handled = false;

                    private void handle(WebView v, String url) {
                        if (handled || url == null || url.equals("about:blank")) return;
                        handled = true;
                        Uri uri = Uri.parse(url);
                        if (!routeUrl(uri)) {
                            webView.loadUrl(url);
                        }
                        v.stopLoading();
                        v.destroy();
                    }

                    @Override
                    public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                        handle(v, request.getUrl().toString());
                        return true;
                    }

                    @Override
                    public void onPageStarted(WebView v, String url, android.graphics.Bitmap favicon) {
                        handle(v, url);
                    }
                });
                WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
                transport.setWebView(popup);
                resultMsg.sendToTarget();
                return true;
            }

            @Override
            public boolean onShowFileChooser(WebView web, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (filePathCallback != null) {
                    filePathCallback.onReceiveValue(null);
                }
                filePathCallback = callback;
                Intent content = new Intent(Intent.ACTION_GET_CONTENT);
                content.addCategory(Intent.CATEGORY_OPENABLE);
                String[] accepts = params.getAcceptTypes();
                String type = "*/*";
                if (accepts != null && accepts.length == 1 && accepts[0] != null && !accepts[0].trim().isEmpty()) {
                    type = accepts[0];
                }
                content.setType(type);
                if (accepts != null && accepts.length > 1) {
                    content.putExtra(Intent.EXTRA_MIME_TYPES, accepts);
                }
                content.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                try {
                    startActivityForResult(Intent.createChooser(content, "Choose file"), FILE_CHOOSER_REQUEST);
                } catch (ActivityNotFoundException ex) {
                    filePathCallback = null;
                    callback.onReceiveValue(null);
                    Toast.makeText(MainActivity.this, "No file picker is available on this device.", Toast.LENGTH_LONG).show();
                }
                return true;
            }
        });

        webView.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String contentDisposition,
                                        String mimeType, long contentLength) {
                pendingDownloadUrl = url;
                pendingDownloadUserAgent = userAgent;
                pendingDownloadDisposition = contentDisposition;
                pendingDownloadMimeType = mimeType;
                if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P &&
                        checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
                    requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, DOWNLOAD_PERMISSION_REQUEST);
                } else {
                    startDownload();
                }
            }
        });
    }

    private boolean routeUrl(Uri uri) {
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        if ("http".equals(scheme) || "https".equals(scheme)) {
            String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase(Locale.ROOT);
            if (host.equals("drive.google.com") || host.equals("docs.google.com") ||
                    host.equals("accounts.google.com") || host.equals("myaccount.google.com")) {
                openExternal(uri);
                return true;
            }
            return false;
        }
        if ("about".equals(scheme) || "blob".equals(scheme) || "data".equals(scheme)) {
            return false;
        }
        openExternal(uri);
        return true;
    }

    private void openExternal(Uri uri) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, uri);
            startActivity(intent);
        } catch (ActivityNotFoundException ex) {
            Toast.makeText(this, "No app is available to open this link.", Toast.LENGTH_LONG).show();
        }
    }

    private void showConnectionError() {
        progressBar.setVisibility(View.GONE);
        webView.setVisibility(View.GONE);
        errorPanel.setVisibility(View.VISIBLE);
    }

    private void startDownload() {
        if (pendingDownloadUrl == null) return;
        if (pendingDownloadUrl.startsWith("blob:") || pendingDownloadUrl.startsWith("data:")) {
            String u = pendingDownloadUrl;
            String d = pendingDownloadDisposition;
            String m = pendingDownloadMimeType;
            pendingDownloadUrl = null;
            pendingDownloadUserAgent = null;
            pendingDownloadDisposition = null;
            pendingDownloadMimeType = null;
            if (u.startsWith("blob:")) {
                fetchBlobAndSave(u, m);
            } else {
                saveDataUrl(u, d, m);
            }
            return;
        }
        try {
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(pendingDownloadUrl));
            request.setTitle(URLUtil.guessFileName(pendingDownloadUrl, pendingDownloadDisposition, pendingDownloadMimeType));
            request.setDescription("Downloading from Audit Dashboard");
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setAllowedOverMetered(true);
            request.setAllowedOverRoaming(false);
            String cookies = CookieManager.getInstance().getCookie(pendingDownloadUrl);
            if (cookies != null) request.addRequestHeader("Cookie", cookies);
            if (pendingDownloadUserAgent != null) request.addRequestHeader("User-Agent", pendingDownloadUserAgent);
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS,
                    URLUtil.guessFileName(pendingDownloadUrl, pendingDownloadDisposition, pendingDownloadMimeType));
            DownloadManager manager = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
            manager.enqueue(request);
            Toast.makeText(this, "Download started. Check your Downloads folder.", Toast.LENGTH_LONG).show();
        } catch (Exception ex) {
            Toast.makeText(this, "Could not start the download. Please try again in Chrome.", Toast.LENGTH_LONG).show();
        } finally {
            pendingDownloadUrl = null;
            pendingDownloadUserAgent = null;
            pendingDownloadDisposition = null;
            pendingDownloadMimeType = null;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == FILE_CHOOSER_REQUEST && filePathCallback != null) {
            Uri[] results = null;
            if (resultCode == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int count = data.getClipData().getItemCount();
                    results = new Uri[count];
                    for (int i = 0; i < count; i++) {
                        results[i] = data.getClipData().getItemAt(i).getUri();
                    }
                } else if (data.getData() != null) {
                    results = new Uri[]{data.getData()};
                }
            }
            filePathCallback.onReceiveValue(results);
            filePathCallback = null;
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == DOWNLOAD_PERMISSION_REQUEST) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                startDownload();
            } else {
                Toast.makeText(this, "Storage permission is needed to save this download.", Toast.LENGTH_LONG).show();
                pendingDownloadUrl = null;
            }
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        webView.saveState(outState);
        super.onSaveInstanceState(outState);
    }

    @Override
    protected void onPause() {
        CookieManager.getInstance().flush();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (filePathCallback != null) {
            filePathCallback.onReceiveValue(null);
            filePathCallback = null;
        }
        if (webView != null) {
            webView.stopLoading();
            webView.destroy();
        }
        super.onDestroy();
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    private int dp(int value) {
        return (int) (value * getResources().getDisplayMetrics().density + 0.5f);
    }

    // ---- In-page generated downloads (blob: / data: URLs) -------------------------------------
    // DownloadManager cannot fetch blob: URLs, so the page hands the bytes to the app instead.

    private static final String DASHBOARD_HOST = "auditdashboard.devs.li";
    private static final int MAX_DOWNLOAD_BASE64_CHARS = 80 * 1024 * 1024;
    private volatile boolean expectBlob = false;

    // Lay the page out at 430 CSS px wide and scale it to fit the screen, so text size, header and
    // card layout look like the 430px mobile view instead of being ~12% larger on narrow phones.
    private static final int LAYOUT_WIDTH_CSS_PX = 430;
    private static final String ENSURE_VIEWPORT =
            "(function(){var W=" + LAYOUT_WIDTH_CSS_PX + ";if(window.screen&&screen.width>=W)return;"
            + "var m=document.querySelector('meta[name=viewport]');"
            + "if(!m){m=document.createElement('meta');m.name='viewport';"
            + "(document.head||document.documentElement).appendChild(m);}"
            + "var c='width='+W+', initial-scale='+(screen.width/W).toFixed(3)"
            + "+', minimum-scale=0.5, maximum-scale=5';if(m.content!==c)m.content=c;})();";

    private static final String DOWNLOAD_NAME_HOOK =
            "(function(){if(window.__adHook)return;window.__adHook=true;window.__adBlobs={};"
            + "var c=URL.createObjectURL;URL.createObjectURL=function(o){var u=c.call(URL,o);"
            + "try{if(o instanceof Blob)window.__adBlobs[u]=o;}catch(e){}return u;};"
            + "var r=URL.revokeObjectURL;URL.revokeObjectURL=function(u){"
            + "setTimeout(function(){try{delete window.__adBlobs[u];}catch(e){}},60000);"
            + "return r.call(URL,u);};"
            + "document.addEventListener('click',function(e){var a=e.target&&e.target.closest?"
            + "e.target.closest('a[download]'):null;if(a){window.__adName=a.getAttribute('download')||'';}},true);"
            + "var ac=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(){"
            + "if(this.download)window.__adName=this.download;return ac.apply(this,arguments);};})();";

    private void fetchBlobAndSave(String blobUrl, String mimeType) {
        String current = webView.getUrl();
        String host = current == null ? "" : String.valueOf(Uri.parse(current).getHost()).toLowerCase(Locale.ROOT);
        if (!DASHBOARD_HOST.equals(host)) {
            Toast.makeText(this, "Download blocked: not from the dashboard.", Toast.LENGTH_LONG).show();
            return;
        }
        expectBlob = true;
        Toast.makeText(this, "Preparing download\u2026", Toast.LENGTH_SHORT).show();
        String js = "(function(u){var b=window.__adBlobs&&window.__adBlobs[u];"
                + "var p=b?Promise.resolve(b):fetch(u).then(function(r){return r.blob();});"
                + "p.then(function(blob){var fr=new FileReader();fr.onloadend=function(){"
                + "var s=String(fr.result);var i=s.indexOf(',');"
                + "AndroidDownload.save(s.substring(i+1),blob.type||'',window.__adName||'');window.__adName='';};"
                + "fr.readAsDataURL(blob);}).catch(function(e){AndroidDownload.fail(String(e));});})("
                + JSONObject.quote(blobUrl) + ");";
        webView.evaluateJavascript(js, null);
    }

    private void saveDataUrl(String dataUrl, String disposition, String mimeType) {
        try {
            int comma = dataUrl.indexOf(',');
            String meta = dataUrl.substring(5, comma);
            String payload = dataUrl.substring(comma + 1);
            byte[] bytes;
            if (meta.contains(";base64")) {
                bytes = Base64.decode(payload, Base64.DEFAULT);
            } else {
                bytes = Uri.decode(payload).getBytes("UTF-8");
            }
            String mime = meta.split(";")[0];
            if (mime.isEmpty()) mime = mimeType == null ? "application/octet-stream" : mimeType;
            String name = URLUtil.guessFileName("download", disposition, mime);
            saveBytesToDownloads(bytes, mime, name);
        } catch (Exception ex) {
            Toast.makeText(this, "Could not save the download.", Toast.LENGTH_LONG).show();
        }
    }

    private String cleanFileName(String requested, String mime) {
        String name = requested == null ? "" : requested.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        if (name.isEmpty()) name = "audit-dashboard-file";
        if (!name.contains(".") && mime != null && !mime.isEmpty()) {
            String ext = android.webkit.MimeTypeMap.getSingleton().getExtensionFromMimeType(mime);
            if (ext != null) name = name + "." + ext;
        }
        return name;
    }

    private void saveBytesToDownloads(byte[] bytes, String mime, String requestedName) throws Exception {
        String name = cleanFileName(requestedName, mime);
        String type = (mime == null || mime.isEmpty()) ? "application/octet-stream" : mime;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.DISPLAY_NAME, name);
            values.put(MediaStore.Downloads.MIME_TYPE, type);
            values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
            Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) throw new IllegalStateException("insert failed");
            try (OutputStream out = getContentResolver().openOutputStream(uri)) {
                out.write(bytes);
            }
        } else {
            File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
            if (!dir.exists()) dir.mkdirs();
            File target = new File(dir, name);
            int n = 1;
            while (target.exists()) {
                int dot = name.lastIndexOf('.');
                String base = dot > 0 ? name.substring(0, dot) : name;
                String ext = dot > 0 ? name.substring(dot) : "";
                target = new File(dir, base + " (" + (n++) + ")" + ext);
            }
            try (FileOutputStream out = new FileOutputStream(target)) {
                out.write(bytes);
            }
        }
        final String shown = name;
        runOnUiThread(() -> Toast.makeText(this, "Saved to Downloads: " + shown, Toast.LENGTH_LONG).show());
    }

    private final class DownloadBridge {
        @JavascriptInterface
        public void save(String base64, String mime, String name) {
            // Only accept data the app itself asked the page for.
            if (!expectBlob) return;
            expectBlob = false;
            try {
                if (base64 == null || base64.length() > MAX_DOWNLOAD_BASE64_CHARS) {
                    throw new IllegalArgumentException("too large");
                }
                saveBytesToDownloads(Base64.decode(base64, Base64.DEFAULT), mime, name);
            } catch (Exception ex) {
                runOnUiThread(() -> Toast.makeText(MainActivity.this,
                        "Could not save the download. Please try again.", Toast.LENGTH_LONG).show());
            }
        }

        @JavascriptInterface
        public void fail(String message) {
            if (!expectBlob) return;
            expectBlob = false;
            runOnUiThread(() -> Toast.makeText(MainActivity.this,
                    "Download failed. Please try again.", Toast.LENGTH_LONG).show());
        }
    }
}
