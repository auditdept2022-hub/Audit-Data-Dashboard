# Audit Dashboard for Android

A lightweight Android application shell for the live Audit Data Dashboard:

`https://auditdashboard.devs.li/`

The app loads the live website. It does not copy dashboard records, store passwords, or replace the dashboard backend. Your dashboard account remains the source of truth.

## Included

- WebView configured for the dashboard's JavaScript interface and browser storage.
- Persistent WebView cookies for the dashboard session.
- Android file picker support for dashboard file-upload controls.
- Reports generated inside the page (blob/data downloads) are saved to your Downloads folder.
- Popup windows from the dashboard are handled instead of being blocked.
- Download Manager handling for report/file downloads.
- Android Back navigation, loading indicator, and an offline retry screen.
- Google Drive, Google Docs, and Google account pages are opened in the phone's external browser.
- HTTPS-only navigation for the dashboard itself.

## Build an installable APK without installing Android Studio

This project includes a GitHub Actions workflow (`.github/workflows/build-android-apk.yml`) that builds a debug APK in the cloud. See `README-ADD-TO-EXISTING-GITHUB.md` for the upload steps.

1. Put the `android/` folder and `.github/workflows/build-android-apk.yml` in the root of your repository and push to `main` or `master`.
2. Open the **Actions** tab, choose **Build Audit Dashboard Android APK**, and (if it did not start by itself) click **Run workflow**.
3. When the run succeeds, download the artifact **audit-dashboard-apk**, extract it, and install `app-debug.apk` on your phone.

Every build is signed with the same key (`android/app/debug.keystore`), so a newer APK installs over the old one without uninstalling. This is a debug/sideload key, not a Play Store release key.

## Build locally with Android Studio

Open this folder as an Android Studio project and let Android Studio install the requested Android SDK components. Then choose **Build → Build Bundle(s) / APK(s) → Build APK(s)**. The APK is created at:

`app/build/outputs/apk/debug/app-debug.apk`

## Important compatibility notes

- A stable internet connection is required; the dashboard remains hosted online.
- Google may restrict OAuth sign-in inside embedded WebViews. This wrapper opens Google account, Drive, and Docs pages in the installed browser. If a Google authorization flow does not return cleanly to the app, sign in to the dashboard in Chrome and use the website's normal Google/Drive flow there.
- This app does not bypass dashboard permissions, Google Drive sharing permissions, or account security checks.
- Dashboard behavior and data remain controlled by the website. Website changes appear in the app after reload.
