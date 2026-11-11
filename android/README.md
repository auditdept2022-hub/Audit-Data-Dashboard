# Audit Dashboard for Android

A lightweight Android application shell for the live Audit Data Dashboard:

`https://auditdashboard.devs.li/`

The app loads the live website. It does not copy dashboard records, store passwords, or replace the dashboard backend. Your dashboard account remains the source of truth.

## Included

- WebView configured for the dashboard's JavaScript interface and browser storage.
- Persistent WebView cookies for the dashboard session.
- Android file picker support for dashboard file-upload controls.
- Download Manager handling for report/file downloads.
- Android Back navigation, loading indicator, and an offline retry screen.
- Google Drive, Google Docs, and Google account pages are opened in the phone's external browser.
- HTTPS-only navigation for the dashboard itself.

## Build an installable APK without installing Android Studio

This project includes a GitHub Actions workflow that builds a debug APK in the cloud.

1. Extract `AuditDashboardAndroid.zip` on your computer.
2. Sign in to GitHub and create a **new empty repository** (private is fine), for example `audit-dashboard-android`.
3. In that repository, choose **Add file → Upload files** and upload the *contents* of this extracted folder. Keep the `.github/workflows/build-apk.yml` file and its folders; do not omit hidden folders.
4. Commit the upload to the `main` branch.
5. Open the repository's **Actions** tab and select **Build Audit Dashboard APK**. The workflow should start automatically after the commit. You can also open it and choose **Run workflow**.
6. When the run is complete, open the successful run and download the artifact named **audit-dashboard-apk**.
7. Extract the downloaded artifact. It contains `app-debug.apk`.
8. Send `app-debug.apk` to your Android phone, open it, and allow installation from that source when Android asks. Then launch **Audit Dashboard**.

The generated debug APK is signed for direct installation/testing. It is not a Play Store release build. Keep your GitHub repository private if you prefer not to publish the app source.

## Build locally with Android Studio

Open this folder as an Android Studio project and let Android Studio install the requested Android SDK components. Then choose **Build → Build Bundle(s) / APK(s) → Build APK(s)**. The APK is created at:

`app/build/outputs/apk/debug/app-debug.apk`

## Important compatibility notes

- A stable internet connection is required; the dashboard remains hosted online.
- Google may restrict OAuth sign-in inside embedded WebViews. This wrapper opens Google account, Drive, and Docs pages in the installed browser. If a Google authorization flow does not return cleanly to the app, sign in to the dashboard in Chrome and use the website's normal Google/Drive flow there.
- This app does not bypass dashboard permissions, Google Drive sharing permissions, or account security checks.
- Dashboard behavior and data remain controlled by the website. Website changes appear in the app after reload.
