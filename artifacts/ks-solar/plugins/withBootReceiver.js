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
 */

const JAVA_SOURCE = `package com.kssolar.app;

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
    }
}
`;

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
              {
                $: { "android:name": "android.intent.action.BOOT_COMPLETED" },
              },
              {
                $: {
                  "android:name": "android.intent.action.QUICKBOOT_POWERON",
                },
              },
            ],
            category: [
              {
                $: { "android:name": "android.intent.category.DEFAULT" },
              },
            ],
          },
        ],
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
      fs.writeFileSync(
        path.join(packageDir, "KSSolarBootReceiver.java"),
        JAVA_SOURCE,
        "utf8",
      );
      return cfg;
    },
  ]);
}

module.exports = function withBootReceiver(config) {
  config = withBootReceiverManifest(config);
  config = withBootReceiverJavaSource(config);
  return config;
};
