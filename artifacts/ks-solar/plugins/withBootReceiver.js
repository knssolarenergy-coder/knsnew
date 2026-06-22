const { withAndroidManifest, withDangerousMod } = require("expo/config-plugins");
const path = require("path");
const fs = require("fs");

/**
 * Android BroadcastReceiver that restarts Expo Location's foreground service
 * after a phone reboot. The receiver only acts when the JS layer has written
 * a flag file (ks_tracking_active) to the app's internal files directory,
 * which happens when startAlwaysOnTracking() is called while a technician is
 * logged in.
 *
 * Flow:
 *   BOOT_COMPLETED → KSSolarBootReceiver.onReceive()
 *     → check flag file (getFilesDir()/ks_tracking_active)
 *     → if exists: startForegroundService(LocationTaskService)
 *     → expo-location resumes task from its own stored config
 *     → schedule KSSolarWatchdogReceiver alarm every 5 min
 */

// ─── Boot Receiver ───────────────────────────────────────────────────────────

const BOOT_RECEIVER_JAVA = `package com.kssolar.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import java.io.File;

public class KSSolarBootReceiver extends BroadcastReceiver {
    // All three files must exist for the receiver to start the location service.
    // They are written by the JS layer (backgroundLocationTask.ts / AuthContext.tsx):
    //   ks_tracking_active — set by startAlwaysOnTracking(), cleared by stopAlwaysOnTracking()
    //   ks_auth_token      — set by storeToken(token) in AuthContext, cleared on logout
    //   ks_auth_user_id    — set by setCurrentUserId(id), cleared by clearCurrentUserId()
    private static final String FLAG_TRACKING = "ks_tracking_active";
    private static final String FLAG_TOKEN    = "ks_auth_token";
    private static final String FLAG_USER_ID  = "ks_auth_user_id";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (action == null) return;
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action) &&
            !"android.intent.action.QUICKBOOT_POWERON".equals(action)) {
            return;
        }

        // Verify a technician was actively tracking AND is still authenticated.
        // All three flags must be present — this prevents the service from starting
        // after a logout even if ks_tracking_active was not cleaned up properly.
        File filesDir = context.getFilesDir();
        if (!new File(filesDir, FLAG_TRACKING).exists()) return;
        if (!new File(filesDir, FLAG_TOKEN).exists())    return;
        if (!new File(filesDir, FLAG_USER_ID).exists())  return;

        // Start Expo Location's foreground service. It reads its task configuration
        // from SharedPreferences written by expo-task-manager and resumes location
        // updates automatically — no JS bridge needed at this point.
        try {
            Intent serviceIntent = new Intent();
            serviceIntent.setClassName(
                context.getPackageName(),
                "expo.modules.location.services.LocationTaskService"
            );
            context.startForegroundService(serviceIntent);
        } catch (Exception ignored) {
            // Service unavailable or already running — safe to ignore.
        }

        // After reboot, also arm the native watchdog so it keeps the service
        // alive even if the OS later kills it (OEM battery savers, etc.).
        KSSolarWatchdogReceiver.scheduleNext(context);
    }
}
`;

// ─── Watchdog Receiver ───────────────────────────────────────────────────────

const WATCHDOG_RECEIVER_JAVA = `package com.kssolar.app;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import java.io.File;

/**
 * AlarmManager-based watchdog that fires every 5 minutes and restarts
 * LocationTaskService if it was killed by an aggressive OEM battery saver
 * (MIUI, One UI, ColorOS, etc.) while the JS layer still wants tracking.
 *
 * This runs entirely in native Java — no JS/Hermes runtime required — so it
 * works even when the app's JS process has been killed by the OS.
 *
 * The watchdog is self-scheduling: each tick reschedules the next one via
 * setExactAndAllowWhileIdle, which fires inside Doze maintenance windows.
 * It is first armed by:
 *   1. KSSolarBootReceiver  — on device reboot
 *   2. KSSolarStartupProvider — on every app process start (open or service)
 */
public class KSSolarWatchdogReceiver extends BroadcastReceiver {
    static final String ACTION_TICK   = "com.kssolar.app.WATCHDOG_TICK";
    private static final String FLAG_TRACKING = "ks_tracking_active";
    private static final String FLAG_TOKEN    = "ks_auth_token";
    private static final String FLAG_USER_ID  = "ks_auth_user_id";
    private static final long   INTERVAL_MS   = 5 * 60 * 1000L; // 5 minutes
    private static final int    REQUEST_CODE  = 9101;

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!ACTION_TICK.equals(intent.getAction())) return;
        restartServiceIfNeeded(context);
        scheduleNext(context);
    }

    /** Check flags and start the foreground service if it should be running. */
    static void restartServiceIfNeeded(Context context) {
        File files = context.getFilesDir();
        if (!new File(files, FLAG_TRACKING).exists()) return;
        if (!new File(files, FLAG_TOKEN).exists())    return;
        if (!new File(files, FLAG_USER_ID).exists())  return;

        try {
            Intent svc = new Intent();
            svc.setClassName(context.getPackageName(),
                    "expo.modules.location.services.LocationTaskService");
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(svc);
            } else {
                context.startService(svc);
            }
        } catch (Exception ignored) {}
    }

    /** Arm (or re-arm) the next 5-minute alarm. Safe to call multiple times. */
    static void scheduleNext(Context context) {
        AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;

        Intent intent = new Intent(context, KSSolarWatchdogReceiver.class);
        intent.setAction(ACTION_TICK);
        PendingIntent pi = PendingIntent.getBroadcast(
                context, REQUEST_CODE, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        long triggerAt = System.currentTimeMillis() + INTERVAL_MS;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            // setExactAndAllowWhileIdle fires inside Doze maintenance windows
            // without needing SCHEDULE_EXACT_ALARM permission.
            am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pi);
        } else {
            am.setExact(AlarmManager.RTC_WAKEUP, triggerAt, pi);
        }
    }
}
`;

// ─── Startup ContentProvider ─────────────────────────────────────────────────

const STARTUP_PROVIDER_JAVA = `package com.kssolar.app;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;
import java.io.File;

/**
 * ContentProvider.onCreate() is called by Android whenever this app's process
 * starts — including when LocationTaskService is started by the system.
 * We use this hook to (re)schedule the watchdog alarm so it stays active
 * without requiring user interaction or a reboot.
 *
 * This is the same initialisation trick used by WorkManager, Firebase, and
 * Jetpack libraries — it is completely safe and has no observable side-effects.
 */
public class KSSolarStartupProvider extends ContentProvider {
    private static final String FLAG_TRACKING = "ks_tracking_active";

    @Override
    public boolean onCreate() {
        android.content.Context ctx = getContext();
        if (ctx == null) return false;
        // Only arm the watchdog if tracking is meant to be active.
        File trackFlag = new File(ctx.getFilesDir(), FLAG_TRACKING);
        if (trackFlag.exists()) {
            KSSolarWatchdogReceiver.scheduleNext(ctx);
        }
        return false;
    }

    @Override public Cursor query(Uri u, String[] p, String s, String[] a, String o) { return null; }
    @Override public String getType(Uri uri) { return null; }
    @Override public Uri insert(Uri uri, ContentValues values) { return null; }
    @Override public int delete(Uri uri, String s, String[] a) { return 0; }
    @Override public int update(Uri uri, ContentValues v, String s, String[] a) { return 0; }
}
`;

// ─── Config plugin helpers ────────────────────────────────────────────────────

function withBootReceiverManifest(config) {
  return withAndroidManifest(config, (cfg) => {
    const app = cfg.modResults.manifest.application[0];

    if (!app.receiver) app.receiver = [];

    const alreadyAdded = app.receiver.some(
      (r) => r.$["android:name"] === ".KSSolarBootReceiver",
    );

    if (!alreadyAdded) {
      app.receiver.push({
        $: {
          "android:name": ".KSSolarBootReceiver",
          "android:enabled": "true",
          "android:exported": "false",
        },
        "intent-filter": [
          {
            action: [
              { $: { "android:name": "android.intent.action.BOOT_COMPLETED" } },
              { $: { "android:name": "android.intent.action.QUICKBOOT_POWERON" } },
            ],
            category: [
              { $: { "android:name": "android.intent.category.DEFAULT" } },
            ],
          },
        ],
      });
    }

    // Watchdog receiver — listens for our custom 5-min alarm action
    const watchdogAdded = app.receiver.some(
      (r) => r.$["android:name"] === ".KSSolarWatchdogReceiver",
    );
    if (!watchdogAdded) {
      app.receiver.push({
        $: {
          "android:name": ".KSSolarWatchdogReceiver",
          "android:enabled": "true",
          "android:exported": "false",
        },
        "intent-filter": [
          {
            action: [
              { $: { "android:name": "com.kssolar.app.WATCHDOG_TICK" } },
            ],
          },
        ],
      });
    }

    // ContentProvider — schedules watchdog on every process start
    if (!app.provider) app.provider = [];
    const providerAdded = app.provider.some(
      (p) => p.$["android:name"] === ".KSSolarStartupProvider",
    );
    if (!providerAdded) {
      app.provider.push({
        $: {
          "android:name": ".KSSolarStartupProvider",
          "android:authorities": "${applicationId}.kssolar_startup",
          "android:exported": "false",
        },
      });
    }

    return cfg;
  });
}

function withBootReceiverJavaSource(config) {
  return withDangerousMod(config, [
    "android",
    async (cfg) => {
      const packageDir = path.join(
        cfg.modRequest.platformProjectRoot,
        "app",
        "src",
        "main",
        "java",
        "com",
        "kssolar",
        "app",
      );
      fs.mkdirSync(packageDir, { recursive: true });
      fs.writeFileSync(path.join(packageDir, "KSSolarBootReceiver.java"),    BOOT_RECEIVER_JAVA,    "utf8");
      fs.writeFileSync(path.join(packageDir, "KSSolarWatchdogReceiver.java"), WATCHDOG_RECEIVER_JAVA, "utf8");
      fs.writeFileSync(path.join(packageDir, "KSSolarStartupProvider.java"),  STARTUP_PROVIDER_JAVA,  "utf8");
      return cfg;
    },
  ]);
}

/**
 * Expo Location's LocationTaskService does not explicitly set
 * android:stopWithTask="false" in its manifest entry, which means on some
 * OEM Android builds (MIUI, EMUI, Samsung) the OS kills the service when
 * the user swipes the app away from the recent tasks screen.
 *
 * This modifier explicitly sets stopWithTask="false" so the foreground
 * service survives app task removal — independent of battery optimization.
 */
function withLocationServiceSticky(config) {
  return withAndroidManifest(config, (cfg) => {
    const app = cfg.modResults.manifest.application[0];
    if (!app.service) return cfg;

    const locSvc = app.service.find(
      (s) =>
        s.$?.["android:name"] ===
        "expo.modules.location.services.LocationTaskService",
    );
    if (locSvc) {
      locSvc.$["android:stopWithTask"] = "false";
      locSvc.$["android:exported"] = "false";
    }
    return cfg;
  });
}

module.exports = function withBootReceiver(config) {
  config = withBootReceiverManifest(config);
  config = withBootReceiverJavaSource(config);
  config = withLocationServiceSticky(config);
  return config;
};
